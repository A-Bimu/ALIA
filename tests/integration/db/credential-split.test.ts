/**
 * Credential split: the migration/administrative connection and the request connection.
 *
 * Review finding 2 of the ALIA-002 coordinator security review: validating the
 * configured *application role* is not enough. A database owner or superuser session
 * can enter `alia_app` with `set local role` and still be privileged underneath, and a
 * callback that issues `RESET ROLE` returns to that privileged session.
 *
 * These cases run against a real database and prove:
 * - the administrative connection is refused even when the configured application role
 *   is the restricted one;
 * - the dedicated least-privileged login is accepted;
 * - after `RESET ROLE` no row level security bypass exists, and a transaction that left
 *   the restricted role cannot commit;
 * - configuration validation refuses a privileged login and refuses to reuse the
 *   administrative connection for requests.
 */

import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { Client, Pool } from 'pg';

import {
  ADMIN_DB_URL_KEY,
  loginRoleOf,
  PRIVILEGED_ROLE_NAMES,
  readDbConfig,
  REQUEST_DB_URL_KEY,
} from '@/lib/db/pool';
import { withTenant, type TenantPrincipal } from '@/lib/db/tenant';
import { AliaError } from '@/lib/errors';
import {
  APP_LOGIN_ROLE,
  captureDenial,
  createAppPool,
  testRuntimeConfig,
  withAppSession,
  type ProvidedTestDatabase,
} from '../../support/test-database';
import {
  ensureFixturesSeeded,
  ORG_A,
  ORG_B,
  OWNER_A,
  privilegedCount,
} from '../../support/fixtures';

const database = inject('aliaTestDatabase') as ProvidedTestDatabase;

const principal: TenantPrincipal = {
  userId: OWNER_A,
  organizationId: ORG_A,
  membershipId: 'credential-split-test',
  role: 'owner',
};

let admin: Client;
let pool: Pool;

beforeAll(async () => {
  admin = new Client({ connectionString: database.adminUrl, application_name: 'alia-credential-split' });
  await admin.connect();
  await ensureFixturesSeeded(admin);
  pool = createAppPool(database);
});

afterAll(async () => {
  await pool.end();
  await admin.end();
});

describe('request connection versus administrative connection', () => {
  it('describes the harness exactly as a deployment: two logins, the request one unprivileged', () => {
    const appLogin = loginRoleOf(database.appUrl);
    const adminLogin = loginRoleOf(database.adminUrl);

    expect(appLogin).toBe(APP_LOGIN_ROLE);
    expect(appLogin).not.toBe(adminLogin);
    expect(PRIVILEGED_ROLE_NAMES.has(appLogin as string)).toBe(false);
    expect(database.appRole).toBe('alia_app');
    expect(appLogin).not.toBe(database.appRole);
  });

  it('refuses the administrative connection on the request path even with the restricted role configured', async () => {
    const adminPool = new Pool({ connectionString: database.adminUrl, max: 1 });
    try {
      await expect(
        withTenant(principal, (tx) => tx.query('select 1 as ok'), {
          pool: adminPool,
          config: {
            url: database.adminUrl,
            appRole: database.appRole,
            statementTimeoutMs: database.statementTimeoutMs,
          },
        }),
      ).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    } finally {
      await adminPool.end();
    }

    // The same call succeeds over the dedicated least-privileged login: the refusal
    // above is the session check, not an unrelated connection failure.
    const evidence = await withTenant(
      principal,
      (tx) =>
        tx.query<{ role_name: string; session_role: string }>(
          `select current_user as role_name, session_user as session_role`,
        ),
      { pool, config: testRuntimeConfig(database) },
    );
    expect(evidence.rows[0]?.role_name).toBe(database.appRole);
    expect(evidence.rows[0]?.session_role).toBe(APP_LOGIN_ROLE);
  });

  it('refuses a privileged login even when the configured application role name is the restricted one', async () => {
    // Administration is checked on the live session, so a privileged credential is
    // refused regardless of what ALIA_DB_APP_ROLE says.
    const adminPool = new Pool({ connectionString: database.adminUrl, max: 1 });
    try {
      await expect(
        withTenant(
          principal,
          (tx) => tx.query('select current_user as role_name, session_user as session_role'),
          {
            pool: adminPool,
            config: {
              url: database.adminUrl,
              appRole: 'alia_app',
              statementTimeoutMs: database.statementTimeoutMs,
            },
          },
        ),
      ).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
    } finally {
      await adminPool.end();
    }
  });

  it('validates the two connection keys apart, and refuses a privileged request login', () => {
    // The real request connection from the harness is accepted.
    const config = readDbConfig({
      [REQUEST_DB_URL_KEY]: database.appUrl,
      [ADMIN_DB_URL_KEY]: database.adminUrl,
      ALIA_DB_APP_ROLE: database.appRole,
    });
    expect(config.url).toBe(database.appUrl);
    expect(config.appRole).toBe(database.appRole);

    // The administrative connection is not a request connection, whether it arrives
    // under the request key or in place of it.
    for (const source of [
      { [REQUEST_DB_URL_KEY]: database.adminUrl, [ADMIN_DB_URL_KEY]: database.adminUrl },
      { [REQUEST_DB_URL_KEY]: database.adminUrl },
    ]) {
      try {
        readDbConfig({ ...source, ALIA_DB_APP_ROLE: database.appRole });
        expect.unreachable('the administrative connection must not serve requests');
      } catch (error) {
        const typed = error as AliaError;
        expect(typed.code).toBe('CONFIGURATION_ERROR');
        expect(typed.message).toContain(REQUEST_DB_URL_KEY);
        expect(typed.message).not.toContain(database.adminUrl);
      }
    }
  });
});

describe('RESET ROLE', () => {
  it('leaves no row level security bypass available and no cross-tenant read', async () => {
    const evidence = await withAppSession(
      pool,
      { userId: OWNER_A, organizationId: ORG_A },
      async (client) => {
        await client.query('reset role');

        const session = await client.query<{
          role_name: string;
          session_role: string;
          bypass_rls: boolean;
          superuser: boolean;
        }>(
          `select current_user as role_name,
                  session_user as session_role,
                  coalesce((select r.rolbypassrls from pg_roles r where r.rolname = current_user), true)
                    as bypass_rls,
                  coalesce((select r.rolsuper from pg_roles r where r.rolname = current_user), true)
                    as superuser`,
        );

        const otherOrganization = await client.query<{ n: number }>(
          'select count(*)::int as n from public.learners where organization_id = $1',
          [ORG_B],
        );
        const ownOrganization = await client.query<{ n: number }>(
          'select count(*)::int as n from public.learners where organization_id = $1',
          [ORG_A],
        );

        return {
          session: session.rows[0],
          otherOrganization: otherOrganization.rows[0]?.n,
          ownOrganization: ownOrganization.rows[0]?.n,
        };
      },
    );

    expect(evidence.session?.role_name).toBe(APP_LOGIN_ROLE);
    expect(evidence.session?.session_role).toBe(APP_LOGIN_ROLE);
    expect(evidence.session?.bypass_rls).toBe(false);
    expect(evidence.session?.superuser).toBe(false);
    expect(evidence.otherOrganization).toBe(0);
    expect(evidence.ownOrganization).toBe(2);
  });

  it('still refuses a cross-tenant write after RESET ROLE', async () => {
    const denial = await withAppSession(
      pool,
      { userId: OWNER_A, organizationId: ORG_A },
      async (client) => {
        await client.query('reset role');
        return captureDenial(
          client.query(
            `insert into public.learners (organization_id, external_learner_id)
             values ($1, 'reset-role-intruder')`,
            [ORG_B],
          ),
        );
      },
    );

    expect('denied' in denial).toBe(true);
    expect(
      await privilegedCount(
        admin,
        `select count(*)::int as n from public.learners where external_learner_id = 'reset-role-intruder'`,
      ),
    ).toBe(0);
  });

  it('refuses to commit a transaction whose callback left the restricted role', async () => {
    await expect(
      withTenant(
        principal,
        async (tx) => {
          await tx.query('reset role');
          return tx.query(
            `insert into public.learners (organization_id, external_learner_id)
             values ($1, 'escaped-write')`,
            [ORG_A],
          );
        },
        { pool, config: testRuntimeConfig(database) },
      ),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });

    expect(
      await privilegedCount(
        admin,
        `select count(*)::int as n from public.learners where external_learner_id = 'escaped-write'`,
      ),
    ).toBe(0);
  });

  it('refuses a transaction whose callback rewrote the selected organization', async () => {
    await expect(
      withTenant(
        principal,
        async (tx) => {
          // A callback cannot widen its own scope by writing the setting the policies
          // read: the scope is re-verified before commit.
          await tx.query(`select set_config('app.organization_id', $1, true)`, [ORG_B]);
          const rows = await tx.query<{ n: number }>(
            'select count(*)::int as n from public.learners where organization_id = $1',
            [ORG_B],
          );
          return rows.rows[0]?.n;
        },
        { pool, config: testRuntimeConfig(database) },
      ),
    ).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR' });
  });
});