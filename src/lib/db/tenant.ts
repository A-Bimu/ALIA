/**
 * Tenant-scoped database access.
 *
 * Every normal request opens one transaction that:
 *   1. enters the restricted application role (`set local role`);
 *   2. publishes the verified subject claim as a transaction-local setting, the same
 *      shape Supabase uses, and the selected organization as `app.organization_id`,
 *      which is what the RLS helpers read;
 *   3. verifies the live session: it must be the restricted role, the login behind it
 *      must not be a superuser, must not hold BYPASSRLS, must own no relation, and must
 *      not be a member of a role that is privileged;
 *   4. verifies that the claim and the selected organization really are the values
 *      intended for this request;
 *   5. scopes the statement and lock timeouts;
 *   6. repeats 3 and 4 before committing, so a callback that left the restricted role
 *      (for example with `RESET ROLE`) cannot commit anything;
 *   7. is always closed: commit on success, rollback on any failure.
 *
 * The request credential is the dedicated least-privileged login from
 * `ALIA_DB_REQUEST_URL`, never the migration/administrative `DATABASE_URL`. Nothing
 * here ever selects a service role or disables row level security.
 */

import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

import { AliaError, isAliaError } from '@/lib/errors';
import {
  createPool,
  getPool,
  readDbConfig,
  type DbConfig,
} from '@/lib/db/pool';
import { isOrgRole, type OrgRole } from '@/modules/identity/roles';

/** A resolved, trusted tenant principal. Never built from a request body. */
export interface TenantPrincipal {
  userId: string;
  organizationId: string;
  membershipId: string;
  role: OrgRole;
}

export interface TenantTransaction {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export interface TenantTransactionScope {
  userId: string;
  /**
   * Organization selected for this transaction, already resolved from membership.
   * Absent only for the pre-selection step that discovers a principal's own
   * memberships; every other tenant table denies without it. RLS remains the
   * authoritative boundary.
   */
  organizationId?: string;
}

export interface TenantRuntimeOptions {
  /** Explicit pool. Defaults to the shared pool for the configured database. */
  pool?: Pool;
  /** Explicit configuration. Builds (and closes) a temporary pool when no pool is given. */
  config?: DbConfig;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LOCK_TIMEOUT = '2s';

/** SQLSTATE values that mean "the request was refused", never "try harder". */
const VIOLATION_CODES: ReadonlySet<string> = new Set([
  '23502', // not null violation
  '23503', // foreign key violation
  '23514', // check violation
  '22P02', // invalid text representation
  '22001', // string data right truncation
  '22003', // numeric value out of range
]);

export interface PgLikeError {
  code?: unknown;
  message?: unknown;
}

/**
 * Map a database failure onto the structured error contract.
 *
 * A row level security refusal is a FORBIDDEN result, never a partial success and
 * never a leak: the original message, including any row value, is discarded and
 * kept only as a non-public `cause`.
 */
export function toTypedDbError(error: unknown): AliaError {
  const code = typeof (error as PgLikeError | null)?.code === 'string'
    ? ((error as PgLikeError).code as string)
    : undefined;

  if (code === '42501') {
    return new AliaError('FORBIDDEN', {
      message: 'This principal is not permitted to perform that action.',
      cause: error,
    });
  }
  if (code === '23505') {
    return new AliaError('IDEMPOTENCY_CONFLICT', { cause: error });
  }
  if (code !== undefined && VIOLATION_CODES.has(code)) {
    return new AliaError('VALIDATION_ERROR', { cause: error });
  }
  return new AliaError('INTERNAL_ERROR', { cause: error });
}

/**
 * Everything the guard needs to prove the session is the restricted one over an
 * unprivileged login, and that the settings the policies read are the ones intended.
 *
 * `coalesce(..., true)` on the role attributes fails closed: a role the catalogue
 * cannot describe is treated as privileged.
 */
const SESSION_PROBE_SQL = `
  select current_user as role_name,
         session_user as session_role,
         current_setting('is_superuser') as is_superuser,
         app.current_user_id()::text as claim_user_id,
         app.current_organization_id()::text as selected_organization_id,
         coalesce((select r.rolbypassrls from pg_roles r where r.rolname = current_user), true)
           as role_bypass_rls,
         coalesce((select r.rolsuper from pg_roles r where r.rolname = session_user), true)
           as session_superuser,
         coalesce((select r.rolbypassrls from pg_roles r where r.rolname = session_user), true)
           as session_bypass_rls,
         (select count(*)::int
            from pg_class c
            join pg_roles r on r.oid = c.relowner
           where r.rolname = session_user) as session_owned_relations,
         (select count(*)::int
            from pg_roles r
           where (r.rolsuper or r.rolbypassrls)
             and pg_has_role(session_user, r.oid, 'MEMBER')) as session_privileged_memberships
`;

interface SessionProbe {
  role_name: string;
  session_role: string;
  is_superuser: string;
  claim_user_id: string | null;
  selected_organization_id: string | null;
  role_bypass_rls: boolean;
  session_superuser: boolean;
  session_bypass_rls: boolean;
  session_owned_relations: number;
  session_privileged_memberships: number;
}

/**
 * Refuse to run (or to commit) unless the live session is exactly the scoped,
 * unprivileged request session that row level security assumes.
 */
async function assertScopedUnprivilegedSession(
  client: PoolClient,
  config: DbConfig,
  scope: TenantTransactionScope,
): Promise<void> {
  const { rows } = await client.query<SessionProbe>(SESSION_PROBE_SQL);
  const facts = rows[0];

  const safe =
    facts !== undefined &&
    facts.role_name === config.appRole &&
    facts.is_superuser === 'off' &&
    facts.role_bypass_rls === false &&
    facts.session_superuser === false &&
    facts.session_bypass_rls === false &&
    facts.session_owned_relations === 0 &&
    facts.session_privileged_memberships === 0 &&
    facts.claim_user_id === scope.userId &&
    facts.selected_organization_id === (scope.organizationId ?? null);

  if (!safe) {
    throw new AliaError('CONFIGURATION_ERROR', {
      message:
        'The tenant request path is not running as the restricted application role over an unprivileged login; refusing to continue.',
    });
  }
}

async function applyScope(
  client: PoolClient,
  config: DbConfig,
  scope: TenantTransactionScope,
): Promise<void> {
  // statement_timeout is a validated positive integer from readDbConfig.
  await client.query(`set local statement_timeout = ${config.statementTimeoutMs}`);
  await client.query(`set local lock_timeout = '${LOCK_TIMEOUT}'`);
  await client.query(`set local role "${config.appRole}"`);
  await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [scope.userId]);
  // Always written, including the empty string for the pre-selection step, so the
  // request can never inherit a selected organization from another transaction.
  await client.query(`select set_config('app.organization_id', $1, true)`, [
    scope.organizationId ?? '',
  ]);
  await assertScopedUnprivilegedSession(client, config, scope);
}

function createTransaction(client: PoolClient): TenantTransaction {
  return {
    query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      return client.query<R>(text, values);
    },
  };
}

/**
 * Run `work` inside one tenant transaction scoped to a verified claim, before an
 * organization is known (used to resolve the principal's own memberships).
 */
export async function withPrincipalScope<T>(
  scope: TenantTransactionScope,
  work: (tx: TenantTransaction) => Promise<T>,
  options: TenantRuntimeOptions = {},
): Promise<T> {
  // Validate before touching a connection: a malformed principal never reaches the
  // database, and the failure needs no pool.
  if (!UUID_PATTERN.test(scope.userId)) {
    throw new AliaError('UNAUTHENTICATED', {
      message: 'The authenticated principal identifier is not valid.',
    });
  }
  if (scope.organizationId !== undefined && !UUID_PATTERN.test(scope.organizationId)) {
    throw new AliaError('FORBIDDEN', {
      message: 'The selected organization identifier is not valid.',
    });
  }

  const config = options.config ?? readDbConfig();
  const temporaryPool = options.pool === undefined && options.config !== undefined;
  const pool = options.pool ?? (temporaryPool ? createPool(config) : getPool());
  const client = await pool.connect();

  try {
    await client.query('begin');
    await applyScope(client, config, scope);
    const result = await work(createTransaction(client));
    // Re-checked before commit: a callback that left the restricted role, or that
    // rewrote the settings the policies read, cannot commit its work.
    await assertScopedUnprivilegedSession(client, config, scope);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch {
      // A broken connection has nothing to roll back; the original error is the
      // one that matters.
    }
    throw isAliaError(error) ? error : toTypedDbError(error);
  } finally {
    client.release();
    if (temporaryPool) await pool.end();
  }
}

/**
 * Run `work` inside one tenant transaction for a resolved principal. The principal's
 * organization is published as the selected organization, so every RLS helper is
 * bound to it.
 */
export async function withTenant<T>(
  principal: TenantPrincipal,
  work: (tx: TenantTransaction) => Promise<T>,
  options: TenantRuntimeOptions = {},
): Promise<T> {
  if (!isOrgRole(principal.role)) {
    throw new AliaError('FORBIDDEN', {
      message: 'The resolved membership role is not recognised.',
    });
  }
  return withPrincipalScope(
    { userId: principal.userId, organizationId: principal.organizationId },
    work,
    options,
  );
}