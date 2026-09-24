/**
 * Principal resolution rules and the client-supplied-organization refusal.
 *
 * Memberships are injected here so the decision table is exercised directly; the
 * integration suite repeats it against the real database and RLS policies.
 */

import { describe, expect, it } from 'vitest';

import { AliaError } from '@/lib/errors';
import {
  assertNoClientSuppliedOrganization,
  resolvePrincipal,
  type ResolvedMembership,
} from '@/modules/identity/principal';
import { hasRoleAtLeast, isOrgRole, requireOrgRole, type OrgRole } from '@/modules/identity/roles';
import { bearer, mintToken, TEST_JWT_SECRET } from '../support/tokens';

const ORG_1 = '11111111-1111-1111-1111-111111111111';
const ORG_2 = '22222222-2222-2222-2222-222222222222';
const USER = 'aaaaaaaa-0000-0000-0000-000000000001';

const jwtConfig = { secret: TEST_JWT_SECRET };

function reader(
  memberships: { membershipId: string; organizationId: string; role: OrgRole }[],
): () => Promise<ResolvedMembership[]> {
  return async () => memberships;
}

describe('assertNoClientSuppliedOrganization', () => {
  it('refuses an organization identifier at any depth and in any spelling', () => {
    const bodies: unknown[] = [
      { organization_id: ORG_2 },
      { organizationId: ORG_2 },
      { ORG_ID: ORG_2 },
      { 'org-id': ORG_2 },
      { tenant_id: ORG_2 },
      { data: { organization_id: ORG_2 } },
      { items: [{ nested: { organisationId: ORG_2 } }] },
    ];

    for (const body of bodies) {
      expect(() => assertNoClientSuppliedOrganization({ body }), JSON.stringify(body)).toThrow(AliaError);
    }

    expect(() =>
      assertNoClientSuppliedOrganization({ query: new URLSearchParams({ organizationId: ORG_2 }) }),
    ).toThrow(AliaError);
  });

  it('reports key names only and never the supplied value', () => {
    try {
      assertNoClientSuppliedOrganization({ body: { organizationId: ORG_2 } });
      expect.unreachable('a body-supplied organization must be refused');
    } catch (error) {
      const typed = error as AliaError;
      expect(typed.code).toBe('VALIDATION_ERROR');
      expect(typed.details).toEqual({ keys: ['organizationId'] });
      expect(JSON.stringify(typed.details)).not.toContain(ORG_2);
    }
  });

  it('accepts a body that describes learning evidence only', () => {
    expect(() =>
      assertNoClientSuppliedOrganization({
        body: {
          external_event_id: 'evt-1',
          pseudonymous_learner_id: 'learner-1',
          skill_id: 'skill-1',
          event_type: 'attempt',
          occurred_at: '2026-09-24T10:00:00.000Z',
          evidence: { correct: false, misconception: 'sign_error' },
        },
      }),
    ).not.toThrow();
  });

  it('refuses a payload it cannot inspect within its bounds', () => {
    let deep: unknown = { value: 1 };
    for (let index = 0; index < 30; index += 1) deep = { nested: deep };

    expect(() => assertNoClientSuppliedOrganization({ body: deep })).toThrow(/nested too deeply/);

    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 6_000; index += 1) wide[`field_${index}`] = index;

    expect(() => assertNoClientSuppliedOrganization({ body: wide })).toThrow(/too large to be validated/);
  });
});

describe('resolvePrincipal', () => {
  it('resolves a single active membership', async () => {
    const token = await mintToken({ subject: USER });

    const principal = await resolvePrincipal(bearer(token), {
      jwtConfig,
      readMemberships: reader([{ membershipId: 'm1', organizationId: ORG_1, role: 'educator' }]),
    });

    expect(principal).toEqual({
      userId: USER,
      organizationId: ORG_1,
      membershipId: 'm1',
      role: 'educator',
    });
  });

  it('refuses a principal with no active membership', async () => {
    const token = await mintToken({ subject: USER });

    await expect(
      resolvePrincipal(bearer(token), { jwtConfig, readMemberships: reader([]) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses an ambiguous multi-organization principal and honours a server-side hint', async () => {
    const memberships: { membershipId: string; organizationId: string; role: OrgRole }[] = [
      { membershipId: 'm1', organizationId: ORG_1, role: 'owner' },
      { membershipId: 'm2', organizationId: ORG_2, role: 'educator' },
    ];
    const token = await mintToken({ subject: USER });

    await expect(
      resolvePrincipal(bearer(token), { jwtConfig, readMemberships: reader(memberships) }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const hinted = await resolvePrincipal(
      bearer(token),
      { jwtConfig, readMemberships: reader(memberships) },
      ORG_2,
    );
    expect(hinted.organizationId).toBe(ORG_2);
    expect(hinted.role).toBe('educator');
  });

  it('never falls back when the hint does not match a membership', async () => {
    const token = await mintToken({ subject: USER });

    await expect(
      resolvePrincipal(
        bearer(token),
        { jwtConfig, readMemberships: reader([{ membershipId: 'm1', organizationId: ORG_1, role: 'owner' }]) },
        ORG_2,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a missing or unusable credential', async () => {
    for (const header of [undefined, null, '', 'Bearer', 'Basic abc']) {
      await expect(
        resolvePrincipal(header, { jwtConfig, readMemberships: reader([]) }),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });
});

describe('role helpers', () => {
  it('recognises only the four organization roles', () => {
    expect(isOrgRole('owner')).toBe(true);
    expect(isOrgRole('educator')).toBe(true);
    expect(isOrgRole('admin')).toBe(true);
    expect(isOrgRole('viewer')).toBe(true);
    for (const value of ['superuser', 'OWNER', '', null, undefined, 7, {}]) {
      expect(isOrgRole(value)).toBe(false);
    }
  });

  it('orders roles by privilege', () => {
    expect(hasRoleAtLeast('owner', 'admin')).toBe(true);
    expect(hasRoleAtLeast('admin', 'admin')).toBe(true);
    expect(hasRoleAtLeast('educator', 'admin')).toBe(false);
    expect(hasRoleAtLeast('viewer', 'viewer')).toBe(true);
  });

  it('refuses an action outside the allowed role set', () => {
    expect(() => requireOrgRole('educator', ['owner', 'admin'])).toThrow(AliaError);
    expect(() => requireOrgRole('owner', ['owner', 'admin'])).not.toThrow();
  });
});
