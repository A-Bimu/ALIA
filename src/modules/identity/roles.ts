/**
 * Organization roles and server-side role checks.
 *
 * Role checks are enforced twice: here for the request path, and in the database
 * policies (`app.has_workspace_access`, `app.is_organization_admin`). The database
 * is authoritative; this module exists so a route fails early with a typed error
 * instead of relying on an empty result set.
 */

import { AliaError } from '@/lib/errors';

export const ORG_ROLES = ['viewer', 'educator', 'admin', 'owner'] as const;

export type OrgRole = (typeof ORG_ROLES)[number];

const RANK: Record<OrgRole, number> = {
  viewer: 0,
  educator: 1,
  admin: 2,
  owner: 3,
};

/** Roles that may read or write learner evidence and private learner memory. */
export const PEDAGOGICAL_ROLES: readonly OrgRole[] = ['owner', 'admin', 'educator'];

/** Roles that may administer a workspace, budgets, and organization memory. */
export const ADMINISTRATIVE_ROLES: readonly OrgRole[] = ['owner', 'admin'];

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
}

export function hasRoleAtLeast(role: OrgRole, minimum: OrgRole): boolean {
  return RANK[role] >= RANK[minimum];
}

/**
 * Refuse an action when the principal's role is not in the allowed set.
 * The message names no identifier and reveals nothing about other tenants.
 */
export function requireOrgRole(role: OrgRole, allowed: readonly OrgRole[]): void {
  if (!allowed.includes(role)) {
    throw new AliaError('FORBIDDEN', {
      message: 'This principal is not permitted to perform that action.',
    });
  }
}
