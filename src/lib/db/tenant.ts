/**
 * Tenant-scoped database access.
 *
 * Every normal request opens one transaction that:
 *   1. enters the restricted application role (`set local role`);
 *   2. publishes the verified subject claim as a transaction-local setting, the
 *      same shape Supabase uses, which is what the RLS policies read;
 *   3. refuses to continue if the session turns out to be a superuser or to hold
 *      BYPASSRLS, so a service-role or owner credential cannot silently serve a
 *      tenant request;
 *   4. scopes the statement and lock timeouts;
 *   5. is always closed: commit on success, rollback on any failure.
 *
 * Nothing here ever selects the service role or disables row level security.
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
  /** Resolved tenant for the request. RLS remains the authoritative boundary. */
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

async function assertUnprivilegedSession(client: PoolClient, config: DbConfig): Promise<void> {
  const { rows } = await client.query<{
    role_name: string;
    is_superuser: string;
    bypass_rls: boolean;
  }>(
    `select current_user as role_name,
            current_setting('is_superuser') as is_superuser,
            coalesce((select r.rolbypassrls from pg_roles r where r.rolname = current_user), false) as bypass_rls`,
  );

  const row = rows[0];
  const safe =
    row !== undefined &&
    row.role_name === config.appRole &&
    row.is_superuser === 'off' &&
    row.bypass_rls === false;

  if (!safe) {
    throw new AliaError('CONFIGURATION_ERROR', {
      message:
        'The tenant request path is not running as the restricted application role; refusing to continue.',
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
  if (scope.organizationId !== undefined) {
    await client.query(`select set_config('app.organization_id', $1, true)`, [
      scope.organizationId,
    ]);
  }
  await assertUnprivilegedSession(client, config);
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

  const config = options.config ?? readDbConfig();
  const temporaryPool = options.pool === undefined && options.config !== undefined;
  const pool = options.pool ?? (temporaryPool ? createPool(config) : getPool());
  const client = await pool.connect();

  try {
    await client.query('begin');
    await applyScope(client, config, scope);
    const result = await work(createTransaction(client));
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

/** Run `work` inside one tenant transaction for a resolved principal. */
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
