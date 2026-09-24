/**
 * Trusted principal and organization resolution.
 *
 * The single rule this module exists to enforce: the organization of a request is
 * derived from (a) a cryptographically verified token subject and (b) that
 * subject's active membership row, read inside an RLS-scoped transaction. A client
 * can never supply its own organization.
 *
 * Evidence that a client-supplied organization is refused: tests/unit/identity
 * and tests/integration/identity.
 */

import { AliaError } from '@/lib/errors';
import {
  withPrincipalScope,
  type TenantPrincipal,
  type TenantRuntimeOptions,
} from '@/lib/db/tenant';
import { extractBearerToken, readJwtConfig, verifyAccessToken, type JwtConfig } from './jwt';
import { isOrgRole, type OrgRole } from './roles';

export interface ResolvedMembership {
  membershipId: string;
  organizationId: string;
  role: OrgRole;
}

/**
 * Body or query keys that would let a caller choose its own tenant. Matched after
 * normalisation (case, underscores, hyphens, dots), so `organizationId`,
 * `organization_id`, and `Organization.Id` are all refused.
 */
export const CLIENT_ORGANIZATION_KEYS: ReadonlySet<string> = new Set([
  'organization',
  'organizationid',
  'organisation',
  'organisationid',
  'orgid',
  'tenant',
  'tenantid',
]);

const MAX_INSPECTED_NODES = 5_000;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function forbidden(message: string): AliaError {
  return new AliaError('FORBIDDEN', { message });
}

/**
 * Reject a request whose body or query string tries to select its own organization.
 * Only key names are reported; a supplied value is never echoed.
 */
export function assertNoClientSuppliedOrganization(input: {
  body?: unknown;
  query?: URLSearchParams | Record<string, unknown> | null;
}): void {
  const offending = new Set<string>();
  let inspected = 0;

  const visit = (node: unknown, depth: number): void => {
    if (node === null || typeof node !== 'object') return;
    if (depth > 20) {
      throw new AliaError('VALIDATION_ERROR', {
        message: 'The request payload is nested too deeply to be validated.',
      });
    }
    const entries: [string, unknown][] =
      node instanceof URLSearchParams
        ? [...node.entries()]
        : Array.isArray(node)
          ? node.map((value, index) => [String(index), value])
          : Object.entries(node as Record<string, unknown>);

    for (const [key, value] of entries) {
      inspected += 1;
      if (inspected > MAX_INSPECTED_NODES) {
        throw new AliaError('VALIDATION_ERROR', {
          message: 'The request payload is too large to be validated.',
        });
      }
      if (CLIENT_ORGANIZATION_KEYS.has(normalizeKey(key))) offending.add(key);
      visit(value, depth + 1);
    }
  };

  visit(input.body, 0);
  if (input.query) visit(input.query, 0);

  if (offending.size > 0) {
    throw new AliaError('VALIDATION_ERROR', {
      message: 'The request must not select its own organization.',
      details: { keys: [...offending].sort() },
    });
  }
}

/**
 * Read the current principal's active memberships. Runs inside `withPrincipalScope`,
 * so the row level security policy (`user_id = app.current_user_id()`) is the
 * boundary; suspended and removed memberships are excluded by the query and by the
 * `status` filter.
 */
export async function readActiveMemberships(
  userId: string,
  options: TenantRuntimeOptions = {},
): Promise<ResolvedMembership[]> {
  return withPrincipalScope(
    { userId },
    async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        organization_id: string;
        role: string;
      }>(
        `select m.id, m.organization_id, m.role
           from public.memberships m
          where m.user_id = $1
            and m.status = 'active'
          order by m.organization_id`,
        [userId],
      );

      return rows
        .filter((row) => isOrgRole(row.role))
        .map((row) => ({
          membershipId: row.id,
          organizationId: row.organization_id,
          role: row.role as OrgRole,
        }));
    },
    options,
  );
}

export interface ResolvePrincipalDeps {
  jwtConfig?: JwtConfig;
  readMemberships?: (userId: string) => Promise<ResolvedMembership[]>;
  runtimes?: TenantRuntimeOptions;
}

/**
 * Resolve the acting principal from the request's bearer credential.
 *
 * @param organizationHint a value already resolved server-side (a verified claim or
 * a server-side lookup), never a raw request body value. When it is supplied it
 * must match one of the principal's active memberships; there is no fallback.
 */
export async function resolvePrincipal(
  authorizationHeader: string | null | undefined,
  deps: ResolvePrincipalDeps = {},
  organizationHint?: string,
): Promise<TenantPrincipal> {
  const token = extractBearerToken(authorizationHeader);
  if (token === null) throw new AliaError('UNAUTHENTICATED', { message: 'Authentication is required.' });

  const jwtConfig = deps.jwtConfig ?? readJwtConfig();
  const verified = await verifyAccessToken(token, jwtConfig);

  const memberships =
    deps.readMemberships !== undefined
      ? await deps.readMemberships(verified.userId)
      : await readActiveMemberships(verified.userId, deps.runtimes);

  if (memberships.length === 0) {
    throw forbidden('This principal has no active membership.');
  }

  if (organizationHint !== undefined) {
    const match = memberships.find((membership) => membership.organizationId === organizationHint);
    if (!match) {
      throw forbidden('This principal has no active membership in the requested organization.');
    }
    return {
      userId: verified.userId,
      organizationId: match.organizationId,
      membershipId: match.membershipId,
      role: match.role,
    };
  }

  if (memberships.length > 1) {
    throw forbidden(
      'This principal belongs to more than one organization; an explicit organization is required.',
    );
  }

  const only = memberships[0] as ResolvedMembership;
  return {
    userId: verified.userId,
    organizationId: only.organizationId,
    membershipId: only.membershipId,
    role: only.role,
  };
}

/** Resolve the principal directly from an incoming request. */
export async function resolvePrincipalFromRequest(
  request: Request,
  deps: ResolvePrincipalDeps = {},
  organizationHint?: string,
): Promise<TenantPrincipal> {
  return resolvePrincipal(request.headers.get('authorization'), deps, organizationHint);
}
