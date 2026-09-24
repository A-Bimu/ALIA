/**
 * Schema invariants for the tenant boundary.
 *
 * These assertions fail the suite if a future migration adds a tenant table without
 * forced RLS, drops a policy, introduces a blanket-permissive policy, or hands the
 * application role a privileged attribute. They are the machine-checked form of the
 * AGENTS.md security invariants.
 */

import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { Client } from 'pg';

import { createAppPool, runAsPrincipal, type ProvidedTestDatabase } from '../../support/test-database';
import { ensureFixturesSeeded, OUTSIDER } from '../../support/fixtures';

const database = inject('aliaTestDatabase') as ProvidedTestDatabase;

/** Every tenant-owned table. Adding one without this list fails the suite. */
const TENANT_TABLES = [
  'audit_events',
  'decisions',
  'learner_private_memory',
  'learner_skill_state',
  'learning_events',
  'learners',
  'memberships',
  'model_usage',
  'organization_budgets',
  'organization_memory',
  'organizations',
] as const;

let admin: Client;

beforeAll(async () => {
  admin = new Client({ connectionString: database.adminUrl, application_name: 'alia-rls-invariants' });
  await admin.connect();
  await ensureFixturesSeeded(admin);
});

afterAll(async () => {
  await admin.end();
});

async function publicTables(): Promise<string[]> {
  const { rows } = await admin.query<{ relname: string }>(
    `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
      order by c.relname`,
  );
  return rows.map((row) => row.relname);
}

async function tenantTablesWithOrganizationId(): Promise<string[]> {
  const { rows } = await admin.query<{ relname: string }>(
    `select distinct c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid
      where n.nspname = 'public'
        and c.relkind = 'r'
        and a.attname = 'organization_id'
        and a.attnum > 0
        and not a.attisdropped
      order by c.relname`,
  );
  return rows.map((row) => row.relname);
}

describe('tenant schema invariants', () => {
  it('exposes exactly the reviewed set of public tables', async () => {
    expect(await publicTables()).toEqual([...TENANT_TABLES].sort());
  });

  it('carries organization_id on every tenant table except the isolation root', async () => {
    const expected = TENANT_TABLES.filter((table) => table !== 'organizations');
    expect(await tenantTablesWithOrganizationId()).toEqual([...expected].sort());
  });

  it('enables and forces row level security on every tenant table', async () => {
    const { rows } = await admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by c.relname`,
    );

    const unsafe = rows.filter((row) => !row.relrowsecurity || !row.relforcerowsecurity);
    expect(unsafe.map((row) => row.relname)).toEqual([]);
  });

  it('gives every tenant table at least one policy, so access is granted explicitly', async () => {
    const { rows } = await admin.query<{ relname: string; policies: number }>(
      `select c.relname, count(p.oid)::int as policies
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_policy p on p.polrelid = c.oid
        where n.nspname = 'public' and c.relkind = 'r'
        group by c.relname
        order by c.relname`,
    );

    expect(rows.filter((row) => row.policies === 0).map((row) => row.relname)).toEqual([]);
  });

  it('contains no blanket-permissive policy', async () => {
    const { rows } = await admin.query<{ relname: string; polname: string; using_expr: string | null; check_expr: string | null }>(
      `select c.relname,
              p.polname,
              pg_get_expr(p.polqual, p.polrelid) as using_expr,
              pg_get_expr(p.polwithcheck, p.polrelid) as check_expr
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
        order by c.relname, p.polname`,
    );

    const permissive = rows.filter(
      (row) => row.using_expr === 'true' || row.check_expr === 'true',
    );
    expect(permissive.map((row) => `${row.relname}.${row.polname}`)).toEqual([]);
    expect(rows.length).toBeGreaterThan(20);
  });

  it('holds the append-only tables to read-and-insert policies only', async () => {
    const { rows } = await admin.query<{ relname: string; polcmd: string }>(
      `select c.relname, p.polcmd
         from pg_policy p
         join pg_class c on c.oid = p.polrelid
        where c.relname in ('learning_events', 'decisions', 'model_usage', 'audit_events', 'organization_memory')
        order by c.relname, p.polcmd`,
    );

    const mutating = rows.filter(
      (row) => row.polcmd === 'd' || (row.polcmd === 'w' && row.relname !== 'organization_memory'),
    );
    expect(mutating).toEqual([]);
  });

  it('never lets the application role bypass RLS or administer the database', async () => {
    const { rows } = await admin.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolcanlogin: boolean;
    }>(
      `select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin
         from pg_roles where rolname = 'alia_app'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolcanlogin: false,
    });
  });

  it('keeps the application role from owning any table', async () => {
    const { rows } = await admin.query<{ n: string }>(
      `select count(*)::int as n
         from pg_class c
         join pg_roles r on r.oid = c.relowner
        where r.rolname = 'alia_app'`,
    );
    expect(Number(rows[0]?.n ?? -1)).toBe(0);
  });

  it('keeps the migration ledger unreadable by the application role', async () => {
    const pool = createAppPool(database);
    try {
      await expect(
        runAsPrincipal(pool, OUTSIDER, 'select * from app.schema_migrations'),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await pool.end();
    }
  });

  it('fixes the search_path of every helper and revokes PUBLIC execute', async () => {
    const { rows } = await admin.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      public_execute: boolean;
    }>(
      `select p.proname,
              p.prosecdef,
              p.proconfig,
              exists (
                select 1
                  from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
                 where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
              ) as public_execute
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app'
        order by p.proname`,
    );

    expect(rows.map((row) => row.proname).sort()).toEqual([
          'claim_sub',
          'current_organization_id',
          'current_user_id',
          'has_workspace_access',
          'is_active_member',
          'is_individual_workspace',
          'is_organization_admin',
          'touch_updated_at',
        ]);

    for (const helper of rows) {
      expect(helper.public_execute, `${helper.proname} must not be executable by PUBLIC`).toBe(false);
      expect(helper.proconfig ?? [], `${helper.proname} must fix its search_path`).toEqual([
        'search_path=""',
      ]);
    }

    // Only the helpers that read tenant tables may run as their owner.
    const definerHelpers = rows.filter((row) => row.prosecdef).map((row) => row.proname).sort();
    expect(definerHelpers).toEqual([
      'has_workspace_access',
      'is_active_member',
      'is_individual_workspace',
      'is_organization_admin',
    ]);
  });

  it('guards organization memory with a composite foreign key and tenant-consistent learner keys', async () => {
    const { rows } = await admin.query<{ relname: string; conname: string; definition: string }>(
      `select c.relname, con.conname, pg_get_constraintdef(con.oid) as definition
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
        where con.contype = 'f'
          and c.relname in ('organization_memory', 'learning_events', 'learner_skill_state', 'learner_private_memory', 'decisions')
        order by c.relname, con.conname`,
    );

    const memoryGuard = rows.find(
      (row) =>
        row.relname === 'organization_memory' &&
        row.definition.includes('(organization_id, account_type)') &&
        row.definition.includes('organizations(id, account_type)'),
    );
    expect(memoryGuard, 'organization_memory must reference organizations(id, account_type)').toBeDefined();

    for (const table of ['learning_events', 'learner_skill_state', 'learner_private_memory', 'decisions']) {
      const guard = rows.find(
        (row) =>
          row.relname === table &&
          row.definition.includes('(organization_id, learner_id)') &&
          row.definition.includes('learners(organization_id, id)'),
      );
      expect(guard, `${table} must reference learners(organization_id, id)`).toBeDefined();
          }
        });

        it('binds every tenant access helper to the transaction-local selected organization', async () => {
          const { rows } = await admin.query<{ proname: string; prosrc: string }>(
            `select p.proname, p.prosrc
               from pg_proc p
               join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'app'
              order by p.proname`,
          );

          // The claim readers are the only helpers that do not need an organization; the
          // workspace helpers cannot answer without one, and the trigger helper reads no
          // tenant table at all.
          const organizationBoundHelpers = [
            'has_workspace_access',
            'is_active_member',
            'is_individual_workspace',
            'is_organization_admin',
          ];
          for (const helper of organizationBoundHelpers) {
            const row = rows.find((candidate) => candidate.proname === helper);
            expect(row, `${helper} must exist`).toBeDefined();
            expect(
              row?.prosrc,
              `${helper} must require the selected organization, not any membership of the principal`,
            ).toContain('app.current_organization_id()');
          }

          // The selected organization itself must fail closed on missing or malformed input.
          const selected = rows.find((candidate) => candidate.proname === 'current_organization_id');
          expect(selected?.prosrc).toContain('current_setting(\'app.organization_id\', true)');
          expect(selected?.prosrc).toContain('else null');

          // Membership discovery stays possible, but the own-row policy limits it: inside a
          // selected organization even the principal's own rows are limited to that
          // organization.
          const { rows: policies } = await admin.query<{ polname: string; using_expr: string | null }>(
            `select p.polname, pg_get_expr(p.polqual, p.polrelid) as using_expr
               from pg_policy p
               join pg_class c on c.oid = p.polrelid
              where c.relname = 'memberships'
              order by p.polname`,
          );

          const ownRowPolicy = policies.find((row) => row.polname === 'memberships_select_own_or_admin');
          expect(ownRowPolicy, 'memberships must keep an own-row select policy').toBeDefined();
          expect(ownRowPolicy?.using_expr).toContain('current_user_id');
          expect(ownRowPolicy?.using_expr).toContain('current_organization_id');
        });
      });
