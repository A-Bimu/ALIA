/**
 * Trusted organization resolution and tenant request path, against a real database.
 *
 * Proves the ALIA-002 acceptance criteria that cannot be shown with a mock:
 * - a principal's organization comes from an active membership row, never a request;
 * - a suspended or removed membership loses access immediately;
 * - the request path enters the restricted role and refuses a privileged one;
 * - a row level security refusal becomes a typed FORBIDDEN, not a partial write.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, inject } from 'vitest';
import { Client, Pool } from 'pg';

import { AliaError } from '@/lib/errors';
import { closePool } from '@/lib/db/pool';
import { withTenant, type TenantRuntimeOptions } from '@/lib/db/tenant';
import {
  assertNoClientSuppliedOrganization,
  resolvePrincipalFromRequest,
} from '@/modules/identity/principal';
import { createAppPool, testRuntimeConfig, type ProvidedTestDatabase } from '../../support/test-database';
import {
  EDUCATOR_A,
  ensureFixturesSeeded,
  LEARNER_A1,
  ORG_A,
  ORG_B,
  OUTSIDER,
  OWNER_A,
  OWNER_B,
  restoreFixtureMemberships,
  setMembershipStatus,
} from '../../support/fixtures';
import {
  bearer,
  mintToken,
  requestWithAuthorization,
  TEST_JWT_SECRET,
  unsignedToken,
} from '../../support/tokens';

const database = inject('aliaTestDatabase') as ProvidedTestDatabase;
const jwtConfig = { secret: TEST_JWT_SECRET };

let admin: Client;
let pool: Pool;
let runtime: TenantRuntimeOptions;

beforeAll(async () => {
  admin = new Client({ connectionString: database.adminUrl, application_name: 'alia-identity' });
  await admin.connect();
  await ensureFixturesSeeded(admin);
  pool = createAppPool(database);
  runtime = { pool, config: testRuntimeConfig(database) };
});

afterEach(async () => {
  await restoreFixtureMemberships(admin);
  await admin.query(`delete from public.memberships where user_id = $1 and organization_id = $2`, [
    OWNER_A,
    ORG_B,
  ]);
});

afterAll(async () => {
  await closePool();
  await pool.end();
  await admin.end();
});

function deps(): { jwtConfig: { secret: string }; runtimes: TenantRuntimeOptions } {
  return { jwtConfig, runtimes: runtime };
}

describe('resolvePrincipalFromRequest', () => {
  it('resolves the acting organization from an active membership', async () => {
    const token = await mintToken({ subject: OWNER_A });

    const principal = await resolvePrincipalFromRequest(requestWithAuthorization(bearer(token)), deps());

    expect(principal.organizationId).toBe(ORG_A);
    expect(principal.role).toBe('owner');
    expect(principal.userId).toBe(OWNER_A);

    const membership = await admin.query(
      `select id from public.memberships where organization_id = $1 and user_id = $2`,
      [ORG_A, OWNER_A],
    );
    expect(principal.membershipId).toBe(membership.rows[0]?.id);
  });

  it('refuses an unauthenticated request', async () => {
    await expect(resolvePrincipalFromRequest(requestWithAuthorization(), deps())).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('refuses a malformed, mis-signed, unsigned, or service-role token', async () => {
    const wrongSecret = await mintToken({ subject: OWNER_A, secret: 'another-secret-0000000000' });
    const serviceRole = await mintToken({ subject: OWNER_A, role: 'service_role' });

    for (const authorization of [
      'Bearer not-a-token',
      'Basic dXNlcjpwYXNz',
      bearer(wrongSecret),
      bearer(unsignedToken()),
      bearer(serviceRole),
      bearer('a'.repeat(9_000)),
    ]) {
      await expect(
        resolvePrincipalFromRequest(requestWithAuthorization(authorization), deps()),
      ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('refuses a principal whose membership is suspended or removed', async () => {
    const token = await mintToken({ subject: EDUCATOR_A });

    await setMembershipStatus(admin, ORG_A, EDUCATOR_A, 'suspended');
    await expect(
      resolvePrincipalFromRequest(requestWithAuthorization(bearer(token)), deps()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await setMembershipStatus(admin, ORG_A, EDUCATOR_A, 'removed');
    await expect(
      resolvePrincipalFromRequest(requestWithAuthorization(bearer(token)), deps()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a principal with no membership at all', async () => {
    const token = await mintToken({ subject: OUTSIDER });

    await expect(
      resolvePrincipalFromRequest(requestWithAuthorization(bearer(token)), deps()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requires an explicit organization when a principal has more than one', async () => {
    await admin.query(
      `insert into public.memberships (organization_id, user_id, role)
       values ($1, $2, 'viewer')
       on conflict (organization_id, user_id) do update set status = 'active'`,
      [ORG_B, OWNER_A],
    );
    const token = await mintToken({ subject: OWNER_A });

    await expect(
      resolvePrincipalFromRequest(requestWithAuthorization(bearer(token)), deps()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // A server-side hint resolves the intended organization; there is no fallback.
    const hinted = await resolvePrincipalFromRequest(
      requestWithAuthorization(bearer(token)),
      deps(),
      ORG_B,
    );
    expect(hinted.organizationId).toBe(ORG_B);
    expect(hinted.role).toBe('viewer');
  });

  it('refuses an organization hint the principal does not belong to, without falling back', async () => {
    const token = await mintToken({ subject: OWNER_A });

    await expect(
      resolvePrincipalFromRequest(requestWithAuthorization(bearer(token)), deps(), ORG_B),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a body that tries to select its own organization', async () => {
    expect(() => assertNoClientSuppliedOrganization({ body: { organization_id: ORG_B } })).toThrow(
      AliaError,
    );
    expect(() => assertNoClientSuppliedOrganization({ body: { organizationId: ORG_B } })).toThrow(
      /must not select its own organization/,
    );
    expect(() => assertNoClientSuppliedOrganization({ body: { nested: [{ Org_Id: ORG_B }] } })).toThrow(
      AliaError,
    );
    expect(() =>
      assertNoClientSuppliedOrganization({ body: {}, query: new URLSearchParams({ orgId: ORG_B }) }),
    ).toThrow(AliaError);

    // Only key names are reported: the identifier the caller supplied is not echoed.
    try {
      assertNoClientSuppliedOrganization({ body: { organization_id: ORG_B } });
      expect.unreachable('a body-supplied organization must be refused');
    } catch (error) {
      const typed = error as AliaError;
      expect(typed.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(typed.details)).not.toContain(ORG_B);
    }

    expect(() =>
      assertNoClientSuppliedOrganization({ body: { learner_id: LEARNER_A1 } }),
    ).not.toThrow();
  });
});

describe('tenant request path', () => {
  it('runs as the restricted role with no bypass and sees only its own organization', async () => {
    const token = await mintToken({ subject: OWNER_A });
    const principal = await resolvePrincipalFromRequest(requestWithAuthorization(bearer(token)), deps());

    const evidence = await withTenant(
      principal,
      async (tx) => {
        const session = await tx.query<{
          role_name: string;
          is_superuser: string;
          claim: string;
          organization: string;
        }>(
          `select current_user as role_name,
                  current_setting('is_superuser') as is_superuser,
                  current_setting('request.jwt.claim.sub') as claim,
                  current_setting('app.organization_id') as organization`,
        );
        const learners = await tx.query<{ external_learner_id: string }>(
          'select external_learner_id from public.learners order by external_learner_id',
        );
        const otherOrg = await tx.query<{ n: number }>(
          'select count(*)::int as n from public.learners where organization_id = $1',
          [ORG_B],
        );
        return { session: session.rows[0], learners: learners.rows, otherOrg: otherOrg.rows[0]?.n };
      },
      runtime,
    );

    expect(evidence.session?.role_name).toBe(database.appRole);
    expect(evidence.session?.is_superuser).toBe('off');
    expect(evidence.session?.claim).toBe(OWNER_A);
    expect(evidence.session?.organization).toBe(ORG_A);
    expect(evidence.learners.map((row) => row.external_learner_id)).toEqual([
      'learner-a1',
      'learner-a2',
    ]);
    expect(evidence.otherOrg).toBe(0);
  });

  it('turns a cross-organization write into a typed refusal', async () => {
    const token = await mintToken({ subject: OWNER_A });
    const principal = await resolvePrincipalFromRequest(requestWithAuthorization(bearer(token)), deps());

    await expect(
      withTenant(
        principal,
        (tx) =>
          tx.query(
            `insert into public.learners (organization_id, external_learner_id) values ($1, 'cross-org-write')`,
            [ORG_B],
          ),
        runtime,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', httpStatus: 403 });

    const landed = await admin.query(
      `select count(*)::int as n from public.learners where external_learner_id = 'cross-org-write'`,
    );
    expect(Number(landed.rows[0]?.n)).toBe(0);
  });

  it('turns a duplicate event identifier into a typed conflict, not a second row', async () => {
    const token = await mintToken({ subject: OWNER_A });
    const principal = await resolvePrincipalFromRequest(requestWithAuthorization(bearer(token)), deps());

    await expect(
      withTenant(
        principal,
        (tx) =>
          tx.query(
            `insert into public.learning_events
               (organization_id, learner_id, external_event_id, skill_id, event_type, occurred_at)
             values ($1, $2, 'evt-a1', 'skill-1', 'attempt', now())`,
            [ORG_A, LEARNER_A1],
          ),
        runtime,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const rows = await admin.query(
      `select count(*)::int as n from public.learning_events where external_event_id = 'evt-a1'`,
    );
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  it('refuses a privileged configured role, then succeeds with the restricted one', async () => {
    const superuserPool = new Pool({ connectionString: database.adminUrl, max: 1 });
    try {
      const token = await mintToken({ subject: OWNER_A });
      const principal = await resolvePrincipalFromRequest(requestWithAuthorization(bearer(token)), deps());

      await expect(
        withTenant(principal, (tx) => tx.query('select 1 as ok'), {
          pool: superuserPool,
          config: { url: database.adminUrl, appRole: 'postgres', statementTimeoutMs: 5_000 },
        }),
      ).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });

      // The same call succeeds once the configured role matches the restricted role:
      // the refusal is the role check, not an unrelated connection failure.
      const allowed = await withTenant(principal, (tx) => tx.query('select 1 as ok'), runtime);
      expect(allowed.rowCount).toBe(1);
    } finally {
      await superuserPool.end();
    }
  });

  it('refuses a membership role it does not recognise', async () => {
    await expect(
      withTenant(
        { userId: OWNER_A, organizationId: ORG_A, membershipId: 'x', role: 'superuser' as never },
        (tx) => tx.query('select 1 as ok'),
        runtime,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a malformed principal identifier without opening a transaction', async () => {
    await expect(
      withTenant(
        { userId: 'not-a-uuid', organizationId: ORG_A, membershipId: 'x', role: 'owner' },
        (tx) => tx.query('select 1 as ok'),
        runtime,
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('keeps access out of reach for a suspended membership on an already-resolved principal', async () => {
    await setMembershipStatus(admin, ORG_A, OWNER_A, 'suspended');

    const rows = await withTenant(
      { userId: OWNER_A, organizationId: ORG_A, membershipId: 'stale', role: 'owner' },
      (tx) => tx.query('select id from public.learners'),
      runtime,
    );
    expect(rows.rowCount).toBe(0);

    const token = await mintToken({ subject: OWNER_A });
    await expect(
      resolvePrincipalFromRequest(requestWithAuthorization(bearer(token)), deps()),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('scopes a second organization owner to its own tenant', async () => {
    const token = await mintToken({ subject: OWNER_B });
    const principal = await resolvePrincipalFromRequest(requestWithAuthorization(bearer(token)), deps());
    expect(principal.organizationId).toBe(ORG_B);

    const learners = await withTenant(
      principal,
      (tx) => tx.query<{ external_learner_id: string }>('select external_learner_id from public.learners'),
      runtime,
    );
    expect(learners.rows.map((row) => row.external_learner_id)).toEqual(['learner-b1']);
  });
});
