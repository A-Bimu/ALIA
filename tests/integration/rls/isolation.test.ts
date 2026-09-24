/**
 * Cross-organization and individual-workspace isolation proof.
 *
 * Required by docs/ALIA-V1-SPEC.md section 4 and the ALIA-002 acceptance criteria:
 * - organization A cannot perform any CRUD operation on organization B rows;
 * - membership in two organizations does not widen access inside either one: every
 *   request transaction is bound to the organization selected for it;
 * - a suspended or removed membership loses access immediately;
 * - an individual (one-owner) workspace cannot create or read organization-shared
 *   memory, and is invisible to every other organization;
 * - role checks restrict pedagogical and administrative actions;
 * - the request path fails closed with no claim, no selected organization, or a
 *   forged selected organization.
 *
 * Every request-path statement runs as `alia_app` with a transaction-local claim and
 * the transaction-local selected organization, in a transaction that is rolled back.
 * Denied writes are additionally checked on the privileged connection, so "no rows
 * changed" is proved, not assumed.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, inject } from 'vitest';
import { Client, Pool } from 'pg';

import {
  captureDenial,
  createAppPool,
  runAsPrincipal,
  runAsPrincipalCommitted,
  type ProvidedTestDatabase,
} from '../../support/test-database';
import {
  DUAL_MEMBER,
  EDUCATOR_A,
  EDUCATOR_B,
  ensureFixturesSeeded,
  LEARNER_A1,
  LEARNER_B1,
  LEARNER_INDIVIDUAL,
  ORG_A,
  ORG_B,
  ORG_INDIVIDUAL,
  OUTSIDER,
  OWNER_A,
  OWNER_B,
  OWNER_INDIVIDUAL,
  privilegedCount,
  restoreFixtureMemberships,
  setMembershipStatus,
  VIEWER_A,
} from '../../support/fixtures';

const database = inject('aliaTestDatabase') as ProvidedTestDatabase;

/** Tables addressed through their own primary key instead of organization_id. */
const ORG_COLUMN: Record<string, string> = { organizations: 'id' };

const TABLE_NAMES = [
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

/** Tables that are always scoped by organization_id. */
const ORGANIZATION_SCOPED_TABLES = TABLE_NAMES.filter((table) => table !== 'organizations');

/**
 * Organization-scoped tables other than `memberships`. Membership rows are the one
 * sanctioned exception to the "selected organization only" rule: a principal's own
 * rows stay readable before an organization has been selected, which is how that
 * selection is resolved in the first place.
 */
const NON_MEMBERSHIP_TABLES = ORGANIZATION_SCOPED_TABLES.filter(
  (table) => table !== 'memberships',
);

/** A well-formed organization identifier that no fixture uses. */
const UNKNOWN_ORGANIZATION = '99999999-9999-9999-9999-999999999999';

let admin: Client;
let pool: Pool;

beforeAll(async () => {
  admin = new Client({ connectionString: database.adminUrl, application_name: 'alia-rls-isolation' });
  await admin.connect();
  await ensureFixturesSeeded(admin);
  pool = createAppPool(database);
});

afterEach(async () => {
  await restoreFixtureMemberships(admin);
});

afterAll(async () => {
  await pool.end();
  await admin.end();
});

function orgFilter(table: string): string {
  return ORG_COLUMN[table] ?? 'organization_id';
}

/**
 * Rows of one table that a request transaction can see.
 *
 * `filter` is the organization whose rows the query asks for; `scope` is the
 * organization selected for the transaction, which defaults to the same value. A test
 * that wants to prove cross-organization denial passes the principal's own
 * organization as the scope and the other organization as the filter, so the two
 * cannot silently coincide.
 */
async function visibleRows(
  userId: string,
  table: string,
  filter: string,
  scope: string | undefined = filter,
): Promise<number> {
  const result = await runAsPrincipal(
    pool,
    userId,
    `select count(*)::int as n from public.${table} where ${orgFilter(table)} = $1`,
    [filter],
    scope,
  );
  return Number(result.rows[0]?.n ?? -1);
}

/**
 * Every organization identifier visible in a table for a scope. An unfiltered read is
 * the strongest statement about isolation: a row of another organization would appear
 * here even though the query never asked for it.
 */
async function visibleOrganizations(
  userId: string,
  table: string,
  scope: string | undefined,
): Promise<string[]> {
  const result = await runAsPrincipal(
    pool,
    userId,
    `select distinct ${orgFilter(table)}::text as organization_id from public.${table}`,
    [],
    scope,
  );
  return result.rows.map((row) => String(row.organization_id)).sort();
}

describe('cross-organization isolation', () => {
  it('shows a member of organization A nothing from organization B in any table', async () => {
    const leaks: string[] = [];
    for (const table of TABLE_NAMES) {
      const count = await visibleRows(OWNER_A, table, ORG_B, ORG_A);
      if (count !== 0) leaks.push(`${table}=${count}`);
    }
    expect(leaks).toEqual([]);
  });

  it('shows a member of organization B nothing from organization A in any table', async () => {
    const leaks: string[] = [];
    for (const table of TABLE_NAMES) {
      const count = await visibleRows(OWNER_B, table, ORG_A, ORG_B);
      if (count !== 0) leaks.push(`${table}=${count}`);
    }
    expect(leaks).toEqual([]);
  });

  it('still shows members their own rows, so isolation is not achieved by denying everything', async () => {
    expect(await visibleRows(OWNER_A, 'learners', ORG_A)).toBe(2);
    expect(await visibleRows(OWNER_A, 'learning_events', ORG_A)).toBe(2);
    expect(await visibleRows(OWNER_B, 'learners', ORG_B)).toBe(1);
    expect(await visibleRows(OWNER_A, 'organizations', ORG_A)).toBe(1);
  });

  it('refuses to insert a row owned by another organization', async () => {
    const attempts: [string, string, unknown[]][] = [
      [
        'organization_memory',
        `insert into public.organization_memory (organization_id, fingerprint, misconception_signature, skill_id, approved_intervention)
         values ($1, 'fp-intruder-1', 'intruder signature', 'skill-1', 'intruder intervention')`,
        [ORG_B],
      ],
      [
        'learners',
        `insert into public.learners (organization_id, external_learner_id) values ($1, 'intruder-learner')`,
        [ORG_B],
      ],
      [
        'learning_events',
        `insert into public.learning_events (organization_id, learner_id, external_event_id, skill_id, event_type, occurred_at)
         values ($1, $2, 'intruder-event', 'skill-1', 'attempt', now())`,
        [ORG_B, LEARNER_B1],
      ],
      [
        'learner_skill_state',
        `insert into public.learner_skill_state (organization_id, learner_id, skill_id) values ($1, $2, 'skill-1')`,
        [ORG_B, LEARNER_B1],
      ],
      [
        'learner_private_memory',
        `insert into public.learner_private_memory (organization_id, learner_id, kind, summary, fingerprint)
         values ($1, $2, 'preference', '{}'::jsonb, 'intruder-private-fp')`,
        [ORG_B, LEARNER_B1],
      ],
      [
        'decisions',
        `insert into public.decisions (organization_id, learner_id, trace_id, source, recommended_action)
         values ($1, $2, 'intruder-trace-1', 'rule', 'intruder action')`,
        [ORG_B, LEARNER_B1],
      ],
      [
        'model_usage',
        `insert into public.model_usage (organization_id, trace_id, route_reason, outcome)
         values ($1, 'intruder-trace-2', 'intruder', 'rule_only')`,
        [ORG_B],
      ],
      [
        'organization_budgets',
        `insert into public.organization_budgets (organization_id, daily_limit_usd, monthly_limit_usd)
         values ($1, 1, 1)`,
        [ORG_B],
      ],
      [
        'audit_events',
        `insert into public.audit_events (organization_id, action, target_type) values ($1, 'intruder.action', 'learner')`,
        [ORG_B],
      ],
      [
        'memberships',
        `insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'owner')`,
        [ORG_B, OUTSIDER],
      ],
      [
        'organizations',
        `insert into public.organizations (name) values ('intruder org')`,
        [],
      ],
    ];

    const accepted: string[] = [];
    for (const [label, sql, values] of attempts) {
      const result = await captureDenial(runAsPrincipalCommitted(pool, OWNER_A, sql, values, ORG_A));
      if (!('denied' in result)) accepted.push(label);
    }
    expect(accepted).toEqual([]);
  });

  it('refuses to update or delete another organization rows, and changes nothing', async () => {
    const survivors: string[] = [];
    for (const table of TABLE_NAMES) {
      if (table === 'organizations') continue;
      const update = await runAsPrincipal(
        pool,
        OWNER_A,
        `update public.${table} set organization_id = organization_id where organization_id = $1 returning 1`,
        [ORG_B],
        ORG_A,
      );
      const remove = await runAsPrincipal(
        pool,
        OWNER_A,
        `delete from public.${table} where organization_id = $1 returning 1`,
        [ORG_B],
        ORG_A,
      );
      if (update.rowCount !== 0) survivors.push(`${table} update=${update.rowCount}`);
      if (remove.rowCount !== 0) survivors.push(`${table} delete=${remove.rowCount}`);
    }
    expect(survivors).toEqual([]);

    // Privileged confirmation that organization B's data is untouched.
    expect(
      await privilegedCount(admin, `select count(*)::int as n from public.learners where organization_id = $1`, [
        ORG_B,
      ]),
    ).toBe(1);
    expect(
      await privilegedCount(
        admin,
        `select count(*)::int as n from public.organization_memory where organization_id = $1`,
        [ORG_B],
      ),
    ).toBe(1);
  });

  it('refuses to move its own row into another organization', async () => {
    const denial = await captureDenial(
      runAsPrincipalCommitted(
        pool,
        OWNER_A,
        `update public.learners set organization_id = $1 where id = $2`,
        [ORG_B, LEARNER_A1],
        ORG_A,
      ),
    );

    expect('denied' in denial).toBe(true);
    expect(
      await privilegedCount(
        admin,
        `select count(*)::int as n from public.learners where id = $1 and organization_id = $2`,
        [LEARNER_A1, ORG_A],
      ),
    ).toBe(1);
  });

  it('refuses to attach its own row to another organization learner', async () => {
    const denial = await captureDenial(
      runAsPrincipalCommitted(
        pool,
        OWNER_A,
        `insert into public.learning_events (organization_id, learner_id, external_event_id, skill_id, event_type, occurred_at)
         values ($1, $2, 'cross-learner-event', 'skill-1', 'attempt', now())`,
        [ORG_A, LEARNER_B1],
        ORG_A,
      ),
    );

    expect('denied' in denial && denial.code).toBe('23503');
    expect(
      await privilegedCount(
        admin,
        `select count(*)::int as n from public.learning_events where external_event_id = 'cross-learner-event'`,
      ),
    ).toBe(0);
  });

  it('shows an authenticated principal with no membership nothing at all', async () => {
    const leaks: string[] = [];
    for (const table of TABLE_NAMES) {
      const result = await runAsPrincipal(pool, OUTSIDER, `select count(*)::int as n from public.${table}`);
      const count = Number(result.rows[0]?.n ?? -1);
      if (count !== 0) leaks.push(`${table}=${count}`);
    }
    expect(leaks).toEqual([]);
  });

  it('fails closed when a session carries no claim at all', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role alia_app');
      for (const table of TABLE_NAMES) {
        const result = await client.query(`select count(*)::int as n from public.${table}`);
        expect(Number(result.rows[0]?.n), `${table} must be empty without a claim`).toBe(0);
      }
      await expect(
        client.query(
          `insert into public.learners (organization_id, external_learner_id) values ($1, 'no-claim-learner')`,
          [ORG_A],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
    expect(
      await privilegedCount(
        admin,
        `select count(*)::int as n from public.learners where external_learner_id = 'no-claim-learner'`,
      ),
    ).toBe(0);
  });
});

describe('selected-organization binding', () => {
  it('exposes only the selected organization to a principal that belongs to two', async () => {
    const inA = await Promise.all(
      TABLE_NAMES.map((table) => visibleOrganizations(DUAL_MEMBER, table, ORG_A)),
    );
    const inB = await Promise.all(
      TABLE_NAMES.map((table) => visibleOrganizations(DUAL_MEMBER, table, ORG_B)),
    );

    const leaks: string[] = [];
    TABLE_NAMES.forEach((table, index) => {
      for (const organizationId of inA[index] ?? []) {
        if (organizationId !== ORG_A) leaks.push(`A scope: ${table}=${organizationId}`);
      }
      for (const organizationId of inB[index] ?? []) {
        if (organizationId !== ORG_B) leaks.push(`B scope: ${table}=${organizationId}`);
      }
    });
    expect(leaks).toEqual([]);

    // Both organizations really are reachable, in their own scope: this is not a
    // principal that lost access to everything.
    expect(inA[TABLE_NAMES.indexOf('learners')]).toEqual([ORG_A]);
    expect(inB[TABLE_NAMES.indexOf('learners')]).toEqual([ORG_B]);
    expect(await visibleRows(DUAL_MEMBER, 'learners', ORG_A)).toBe(2);
    expect(await visibleRows(DUAL_MEMBER, 'learners', ORG_B)).toBe(1);
  });

  it('denies every CRUD operation and resource-by-id access against the other organization', async () => {
    const denials: string[] = [];

    for (const table of ORGANIZATION_SCOPED_TABLES) {
      // Select, scoped to A but asking for B.
      if ((await visibleRows(DUAL_MEMBER, table, ORG_B, ORG_A)) !== 0) {
        denials.push(`select ${table}`);
      }
      // Update and delete, scoped to A but targeting B.
      const update = await runAsPrincipal(
        pool,
        DUAL_MEMBER,
        `update public.${table} set organization_id = organization_id where organization_id = $1 returning 1`,
        [ORG_B],
        ORG_A,
      );
      if (update.rowCount !== 0) denials.push(`update ${table}`);
      const remove = await runAsPrincipal(
        pool,
        DUAL_MEMBER,
        `delete from public.${table} where organization_id = $1 returning 1`,
        [ORG_B],
        ORG_A,
      );
      if (remove.rowCount !== 0) denials.push(`delete ${table}`);
    }

    // Insert, scoped to A but owned by B.
    const inserts: [string, string, unknown[]][] = [
      [
        'learners',
        `insert into public.learners (organization_id, external_learner_id) values ($1, 'dual-intruder-learner')`,
        [ORG_B],
      ],
      [
        'learning_events',
        `insert into public.learning_events (organization_id, learner_id, external_event_id, skill_id, event_type, occurred_at)
         values ($1, $2, 'dual-intruder-event', 'skill-1', 'attempt', now())`,
        [ORG_B, LEARNER_B1],
      ],
      [
        'organization_memory',
        `insert into public.organization_memory (organization_id, fingerprint, misconception_signature, skill_id, approved_intervention)
         values ($1, 'fp-dual-intruder', 'dual intruder signature', 'skill-1', 'dual intruder intervention')`,
        [ORG_B],
      ],
      [
        'model_usage',
        `insert into public.model_usage (organization_id, trace_id, route_reason, outcome)
         values ($1, 'dual-intruder-trace', 'dual intruder', 'rule_only')`,
        [ORG_B],
      ],
      [
        'memberships',
        `insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'viewer')`,
        [ORG_B, OUTSIDER],
      ],
      [
        'audit_events',
        `insert into public.audit_events (organization_id, action, target_type) values ($1, 'dual.intruder', 'learner')`,
        [ORG_B],
      ],
    ];
    for (const [label, sql, values] of inserts) {
      const result = await captureDenial(
        runAsPrincipalCommitted(pool, DUAL_MEMBER, sql, values, ORG_A),
      );
      if (!('denied' in result)) denials.push(`insert ${label}`);
    }

    // Resource-by-id access to a row of the other organization.
    const byId = await runAsPrincipal(
      pool,
      DUAL_MEMBER,
      `select external_learner_id from public.learners where id = $1`,
      [LEARNER_B1],
      ORG_A,
    );
    if (byId.rowCount !== 0) denials.push('select learner by id');
    const memoryById = await runAsPrincipal(
      pool,
      DUAL_MEMBER,
      `select fingerprint from public.organization_memory where organization_id = $1`,
      [ORG_B],
      ORG_A,
    );
    if (memoryById.rowCount !== 0) denials.push('select memory by organization');

    expect(denials).toEqual([]);

    // Nothing landed on the privileged connection either.
    expect(
      await privilegedCount(
        admin,
        `select count(*)::int as n from public.learners where external_learner_id = 'dual-intruder-learner'`,
      ),
    ).toBe(0);
    expect(
      await privilegedCount(
        admin,
        `select count(*)::int as n from public.organization_memory where fingerprint = 'fp-dual-intruder'`,
      ),
    ).toBe(0);
    expect(
      await privilegedCount(
        admin,
        `select count(*)::int as n from public.learners where organization_id = $1`,
        [ORG_B],
      ),
    ).toBe(1);
  });

  it('denies tenant-key reassignment and cross-tenant attachment in both directions', async () => {
    const reassignmentToB = await captureDenial(
      runAsPrincipalCommitted(
        pool,
        DUAL_MEMBER,
        `update public.learners set organization_id = $1 where id = $2`,
        [ORG_B, LEARNER_A1],
        ORG_A,
      ),
    );
    expect('denied' in reassignmentToB).toBe(true);

    const reassignmentToA = await captureDenial(
      runAsPrincipalCommitted(
        pool,
        DUAL_MEMBER,
        `update public.learners set organization_id = $1 where id = $2`,
        [ORG_A, LEARNER_B1],
        ORG_B,
      ),
    );
    expect('denied' in reassignmentToA).toBe(true);

    const attachedAcross = await captureDenial(
      runAsPrincipalCommitted(
        pool,
        DUAL_MEMBER,
        `insert into public.learning_events (organization_id, learner_id, external_event_id, skill_id, event_type, occurred_at)
         values ($1, $2, 'dual-cross-learner-event', 'skill-1', 'attempt', now())`,
        [ORG_B, LEARNER_A1],
        ORG_B,
      ),
    );
    expect('denied' in attachedAcross && attachedAcross.code).toBe('23503');

    expect(
      await privilegedCount(
        admin,
        `select count(*)::int as n from public.learners where (id = $1 and organization_id = $2) or (id = $3 and organization_id = $4)`,
        [LEARNER_A1, ORG_A, LEARNER_B1, ORG_B],
      ),
    ).toBe(2);
    expect(
      await privilegedCount(
        admin,
        `select count(*)::int as n from public.learning_events where external_event_id = 'dual-cross-learner-event'`,
      ),
    ).toBe(0);
  });

  it('limits a non-administrator own membership rows to the selected organization', async () => {
    // VIEWER_A is an active viewer of organization A and, for this test only, a viewer
    // of organization B as well.
    await admin.query(
      `insert into public.memberships (organization_id, user_id, role, status)
       values ($1, $2, 'viewer', 'active')
       on conflict (organization_id, user_id) do update set status = 'active'`,
      [ORG_B, VIEWER_A],
    );

    try {
      const inB = await runAsPrincipal(
        pool,
        VIEWER_A,
        `select organization_id::text as organization_id, user_id::text as user_id from public.memberships`,
        [],
        ORG_B,
      );
      expect(inB.rows.map((row) => row.user_id)).toEqual([VIEWER_A]);
      expect(inB.rows.map((row) => row.organization_id)).toEqual([ORG_B]);

      const inA = await runAsPrincipal(
        pool,
        VIEWER_A,
        `select organization_id::text as organization_id from public.memberships`,
        [],
        ORG_A,
      );
      expect(inA.rows.map((row) => row.organization_id)).toEqual([ORG_A]);

      // Pre-selection discovery: with no organization selected the principal sees its
      // own membership rows only, and no other tenant table at all.
      const discovery = await runAsPrincipal(
        pool,
        VIEWER_A,
        `select organization_id::text as organization_id from public.memberships order by organization_id`,
      );
      expect(discovery.rows.map((row) => row.organization_id)).toEqual([ORG_A, ORG_B]);

      const leaks: string[] = [];
            for (const table of NON_MEMBERSHIP_TABLES) {
              const result = await runAsPrincipal(pool, VIEWER_A, `select count(*)::int as n from public.${table}`);
              if (Number(result.rows[0]?.n) !== 0) leaks.push(table);
            }
            expect(leaks).toEqual([]);
            expect(await visibleOrganizations(VIEWER_A, 'organizations', undefined)).toEqual([]);

            // Membership discovery is the one sanctioned exception: the principal's own rows
            // are readable without a selected organization, and nobody else's.
            const ownRows = await runAsPrincipal(
              pool,
              VIEWER_A,
              `select count(*)::int as n from public.memberships`,
            );
            expect(Number(ownRows.rows[0]?.n)).toBe(2);
            const otherRows = await runAsPrincipal(
              pool,
              VIEWER_A,
              `select count(*)::int as n from public.memberships where user_id <> $1`,
              [VIEWER_A],
            );
            expect(Number(otherRows.rows[0]?.n)).toBe(0);
    } finally {
      await admin.query(`delete from public.memberships where organization_id = $1 and user_id = $2`, [
        ORG_B,
        VIEWER_A,
      ]);
    }
  });

  it('fails closed when the selected organization is missing or forged', async () => {
    const leaks: string[] = [];

    for (const scope of [undefined, UNKNOWN_ORGANIZATION, ORG_INDIVIDUAL]) {
          for (const table of NON_MEMBERSHIP_TABLES) {
            const result = await runAsPrincipal(
              pool,
              DUAL_MEMBER,
              `select count(*)::int as n from public.${table} where organization_id = $1`,
              [ORG_A],
              scope,
            );
            if (Number(result.rows[0]?.n) !== 0) leaks.push(`${table} with scope ${scope ?? 'none'}`);
          }
          const organizations = await visibleOrganizations(DUAL_MEMBER, 'organizations', scope);
          if (organizations.length > 0) leaks.push(`organizations with scope ${scope ?? 'none'}`);

          // Without a selected organization the only rows in reach are the principal's own
          // membership rows; with a forged or foreign organization, nothing at all.
          const memberships = await runAsPrincipal(
            pool,
            DUAL_MEMBER,
            `select count(*)::int as n from public.memberships`,
            [],
            scope,
          );
          const expectedMemberships = scope === undefined ? 2 : 0;
          if (Number(memberships.rows[0]?.n) !== expectedMemberships) {
            leaks.push(`memberships=${String(memberships.rows[0]?.n)} with scope ${scope ?? 'none'}`);
          }
        }
        expect(leaks).toEqual([]);

    // A write against the principal's real organization is refused too, because no
    // organization was selected for the transaction.
    const writeWithoutSelection = await captureDenial(
      runAsPrincipalCommitted(
        pool,
        DUAL_MEMBER,
        `insert into public.learners (organization_id, external_learner_id) values ($1, 'unselected-learner')`,
        [ORG_A],
      ),
    );
    expect('denied' in writeWithoutSelection).toBe(true);
    expect(
      await privilegedCount(
        admin,
        `select count(*)::int as n from public.learners where external_learner_id = 'unselected-learner'`,
      ),
    ).toBe(0);
  });

  it('keeps a single-membership principal out of an organization it does not belong to', async () => {
    const leaks: string[] = [];
    for (const table of ORGANIZATION_SCOPED_TABLES) {
      // Scoped to organization B although the principal is only a member of A.
      const count = await visibleRows(OWNER_A, table, ORG_B, ORG_B);
      if (count !== 0) leaks.push(`${table}=${count}`);
    }
    expect(leaks).toEqual([]);
    expect(await visibleRows(OWNER_A, 'learners', ORG_A, ORG_A)).toBe(2);
  });
});

describe('membership lifecycle', () => {
  it('removes data access immediately when a membership is suspended', async () => {
    expect(await visibleRows(EDUCATOR_A, 'learners', ORG_A)).toBe(2);

    expect(await setMembershipStatus(admin, ORG_A, EDUCATOR_A, 'suspended')).toBe(1);

    const rows = await runAsPrincipal(pool, EDUCATOR_A, 'select id from public.learners', [], ORG_A);
    expect(rows.rowCount).toBe(0);
    const write = await captureDenial(
      runAsPrincipalCommitted(
        pool,
        EDUCATOR_A,
        `insert into public.learners (organization_id, external_learner_id) values ($1, 'suspended-educator-learner')`,
        [ORG_A],
        ORG_A,
      ),
    );
    expect('denied' in write).toBe(true);
  });

  it('removes data access when a membership is marked removed, even across organizations', async () => {
    expect(await setMembershipStatus(admin, ORG_B, EDUCATOR_B, 'removed')).toBe(1);

    const rows = await runAsPrincipal(pool, EDUCATOR_B, 'select id from public.learners', [], ORG_B);
    expect(rows.rowCount).toBe(0);
    expect(await visibleRows(EDUCATOR_B, 'organizations', ORG_B)).toBe(0);
  });

  it('keeps a suspended member able to see its own membership row only', async () => {
    await setMembershipStatus(admin, ORG_A, VIEWER_A, 'suspended');

    const memberships = await runAsPrincipal(
      pool,
      VIEWER_A,
      `select organization_id, status from public.memberships where user_id = $1`,
      [VIEWER_A],
      ORG_A,
    );
    expect(memberships.rowCount).toBe(1);
    expect(memberships.rows[0]?.status).toBe('suspended');

    const orgs = await runAsPrincipal(pool, VIEWER_A, 'select id from public.organizations', [], ORG_A);
    expect(orgs.rowCount).toBe(0);
  });
});

describe('role checks', () => {
  it('keeps a viewer out of learner evidence while allowing its own audit trail append', async () => {
    expect(await visibleRows(VIEWER_A, 'learners', ORG_A)).toBe(0);
    expect(await visibleRows(VIEWER_A, 'learner_private_memory', ORG_A)).toBe(0);
    expect(await visibleRows(VIEWER_A, 'organization_memory', ORG_A)).toBe(0);

    const evidence = await captureDenial(
      runAsPrincipalCommitted(
        pool,
        VIEWER_A,
        `insert into public.learning_events (organization_id, learner_id, external_event_id, skill_id, event_type, occurred_at)
         values ($1, $2, 'viewer-event', 'skill-1', 'attempt', now())`,
        [ORG_A, LEARNER_A1],
        ORG_A,
      ),
    );
    expect('denied' in evidence).toBe(true);

    const audit = await runAsPrincipal(
      pool,
      VIEWER_A,
      `insert into public.audit_events (organization_id, actor_user_id, action, target_type)
       values ($1, $2, 'learner.read', 'learner')`,
      [ORG_A, VIEWER_A],
      ORG_A,
    );
    expect(audit.rowCount).toBe(1);

    const auditRead = await runAsPrincipal(pool, VIEWER_A, 'select id from public.audit_events', [], ORG_A);
    expect(auditRead.rowCount).toBe(0);
  });

  it('refuses an audit event attributed to another principal', async () => {
    const forged = await captureDenial(
      runAsPrincipalCommitted(
        pool,
        VIEWER_A,
        `insert into public.audit_events (organization_id, actor_user_id, action, target_type)
         values ($1, $2, 'learner.read', 'learner')`,
        [ORG_A, OWNER_A],
        ORG_A,
      ),
    );
    expect('denied' in forged).toBe(true);
  });

  it('lets an educator read and add evidence but not delete or rewrite it', async () => {
    expect(await visibleRows(EDUCATOR_A, 'learners', ORG_A)).toBe(2);

    const inserted = await runAsPrincipalCommitted(
      pool,
      EDUCATOR_A,
      `insert into public.learning_events (organization_id, learner_id, external_event_id, skill_id, event_type, occurred_at)
       values ($1, $2, $3, 'skill-1', 'attempt', now()) returning id`,
      [ORG_A, LEARNER_A1, `educator-event-${Date.now()}`],
      ORG_A,
    );
    expect(inserted.rowCount).toBe(1);

    const updated = await runAsPrincipal(
      pool,
      EDUCATOR_A,
      `update public.learning_events set skill_id = 'rewritten' where organization_id = $1 returning id`,
      [ORG_A],
      ORG_A,
    );
    expect(updated.rowCount).toBe(0);

    const removed = await runAsPrincipal(
      pool,
      EDUCATOR_A,
      `delete from public.learning_events where organization_id = $1 returning id`,
      [ORG_A],
      ORG_A,
    );
    expect(removed.rowCount).toBe(0);

    const learnerRemoved = await runAsPrincipal(
      pool,
      EDUCATOR_A,
      `delete from public.learners where organization_id = $1 returning id`,
      [ORG_A],
      ORG_A,
    );
    expect(learnerRemoved.rowCount).toBe(0);
  });

  it('reserves organization memory approval for an administrator', async () => {
    const byEducator = await runAsPrincipal(
      pool,
      EDUCATOR_A,
      `update public.organization_memory set status = 'approved', approved_at = now(), reviewer_user_id = $2
        where organization_id = $1 and status = 'candidate' returning id`,
      [ORG_A, EDUCATOR_A],
      ORG_A,
    );
    expect(byEducator.rowCount).toBe(0);

    const byOwner = await runAsPrincipal(
      pool,
      OWNER_A,
      `update public.organization_memory set status = 'approved', approved_at = now(), reviewer_user_id = $2
        where organization_id = $1 and status = 'candidate' returning id`,
      [ORG_A, OWNER_A],
      ORG_A,
    );
    expect(byOwner.rowCount).toBe(1);
  });

  it('never serves a non-approved or expired memory row to a retrieval path', async () => {
    const pending = await runAsPrincipal(
      pool,
      EDUCATOR_A,
      `select id from public.organization_memory where status <> 'approved'`,
      [],
      ORG_A,
    );
    expect(pending.rowCount).toBe(0);

    const approved = await runAsPrincipal(
      pool,
      EDUCATOR_A,
      `select fingerprint from public.organization_memory order by fingerprint`,
      [],
      ORG_A,
    );
    expect(approved.rows.map((row) => row.fingerprint)).toEqual(['fp-a-approved']);

    await admin.query(
      `update public.organization_memory
          set approved_at = now() - interval '2 days', expires_at = now() - interval '1 day'
        where organization_id = $1 and status = 'approved'`,
      [ORG_A],
    );
    try {
      const expired = await runAsPrincipal(
        pool,
        EDUCATOR_A,
        'select fingerprint from public.organization_memory',
        [],
        ORG_A,
      );
      expect(expired.rowCount).toBe(0);
    } finally {
      await admin.query(
        `update public.organization_memory
            set approved_at = now(), expires_at = null
          where organization_id = $1 and status = 'approved'`,
        [ORG_A],
      );
    }
  });

  it('restricts the roster to the principal itself and organization administrators', async () => {
    const asViewer = await runAsPrincipal(
      pool,
      VIEWER_A,
      'select user_id from public.memberships',
      [],
      ORG_A,
    );
    expect(asViewer.rowCount).toBe(1);
    expect(asViewer.rows[0]?.user_id).toBe(VIEWER_A);

    const asOwner = await runAsPrincipal(
      pool,
      OWNER_A,
      'select user_id from public.memberships',
      [],
      ORG_A,
    );
    expect(asOwner.rowCount).toBe(4);

    const asOtherOrgOwner = await runAsPrincipal(
      pool,
      OWNER_B,
      'select user_id from public.memberships',
      [],
      ORG_B,
    );
    expect(asOtherOrgOwner.rowCount).toBe(3);
  });

  it('keeps budgets readable by owners only', async () => {
    expect(await visibleRows(OWNER_A, 'organization_budgets', ORG_A)).toBe(1);
    expect(await visibleRows(EDUCATOR_A, 'organization_budgets', ORG_A)).toBe(0);
    expect(await visibleRows(VIEWER_A, 'organization_budgets', ORG_A)).toBe(0);
  });
});

describe('individual workspace isolation', () => {
  it('refuses organization-shared memory in an individual workspace', async () => {
    const insert = await captureDenial(
      runAsPrincipalCommitted(
        pool,
        OWNER_INDIVIDUAL,
        `insert into public.organization_memory (organization_id, fingerprint, misconception_signature, skill_id, approved_intervention)
         values ($1, 'fp-solo-1', 'solo signature', 'skill-1', 'solo intervention')`,
        [ORG_INDIVIDUAL],
        ORG_INDIVIDUAL,
      ),
    );
    expect('denied' in insert && insert.code).toBe('42501');

    const read = await runAsPrincipal(
      pool,
      OWNER_INDIVIDUAL,
      'select fingerprint from public.organization_memory',
      [],
      ORG_INDIVIDUAL,
    );
    expect(read.rowCount).toBe(0);
  });

  it('refuses organization memory even for a privileged connection', async () => {
    await expect(
      admin.query(
        `insert into public.organization_memory (organization_id, fingerprint, misconception_signature, skill_id, approved_intervention)
         values ($1, 'fp-solo-2', 'solo signature', 'skill-1', 'solo intervention')`,
        [ORG_INDIVIDUAL],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('refuses to convert an organization with shared memory into an individual workspace', async () => {
    await expect(
      admin.query(`update public.organizations set account_type = 'individual' where id = $1`, [ORG_A]),
    ).rejects.toMatchObject({ code: '23503' });

    const accountType = await privilegedCount(
      admin,
      `select case when account_type = 'organization' then 1 else 0 end from public.organizations where id = $1`,
      [ORG_A],
    );
    expect(accountType).toBe(1);
  });

  it('keeps an individual workspace invisible to every organization', async () => {
    expect(await visibleRows(OWNER_A, 'learners', ORG_INDIVIDUAL, ORG_A)).toBe(0);
    expect(await visibleRows(OWNER_B, 'learners', ORG_INDIVIDUAL, ORG_B)).toBe(0);
    expect(await visibleRows(OWNER_A, 'organizations', ORG_INDIVIDUAL, ORG_A)).toBe(0);

    const intrusion = await captureDenial(
      runAsPrincipalCommitted(
        pool,
        OWNER_A,
        `insert into public.learners (organization_id, external_learner_id) values ($1, 'workspace-intruder')`,
        [ORG_INDIVIDUAL],
        ORG_A,
      ),
    );
    expect('denied' in intrusion).toBe(true);
  });

  it('gives the individual owner access to its own workspace only', async () => {
    expect(await visibleRows(OWNER_INDIVIDUAL, 'learners', ORG_INDIVIDUAL)).toBe(1);

    const ownLearner = await runAsPrincipal(
      pool,
      OWNER_INDIVIDUAL,
      `select organization_id from public.learners where id = $1`,
      [LEARNER_INDIVIDUAL],
      ORG_INDIVIDUAL,
    );
    expect(ownLearner.rowCount).toBe(1);

    // Organization-shared memory administration is not available to a one-owner
    // workspace, while its own cost limits remain under its control.
    const organizationMemoryWrite = await captureDenial(
      runAsPrincipalCommitted(
        pool,
        OWNER_INDIVIDUAL,
        `insert into public.organization_memory (organization_id, fingerprint, misconception_signature, skill_id, approved_intervention)
         values ($1, 'fp-solo-3', 'solo signature', 'skill-1', 'solo intervention')`,
        [ORG_INDIVIDUAL],
        ORG_INDIVIDUAL,
      ),
    );
    expect('denied' in organizationMemoryWrite).toBe(true);

    const ownBudget = await runAsPrincipalCommitted(
      pool,
      OWNER_INDIVIDUAL,
      `insert into public.organization_budgets (organization_id, daily_limit_usd, monthly_limit_usd)
       values ($1, 1, 1)
       on conflict (organization_id) do update set daily_limit_usd = excluded.daily_limit_usd
       returning organization_id`,
      [ORG_INDIVIDUAL],
      ORG_INDIVIDUAL,
    );
    expect(ownBudget.rowCount).toBe(1);

    const otherOrgBudget = await runAsPrincipalCommitted(
      pool,
      OWNER_INDIVIDUAL,
      `update public.organization_budgets set daily_limit_usd = 99 where organization_id = $1`,
      [ORG_A],
      ORG_INDIVIDUAL,
    );
    expect(otherOrgBudget.rowCount).toBe(0);

    const roster = await runAsPrincipal(
      pool,
      OWNER_INDIVIDUAL,
      'select user_id from public.memberships',
      [],
      ORG_INDIVIDUAL,
    );
    expect(roster.rowCount).toBe(1);

    const otherOrgRows = await visibleRows(OWNER_INDIVIDUAL, 'learner_private_memory', ORG_A, ORG_INDIVIDUAL);
    expect(otherOrgRows).toBe(0);
  });
});