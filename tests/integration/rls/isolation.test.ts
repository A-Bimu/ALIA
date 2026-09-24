/**
 * Cross-organization and individual-workspace isolation proof.
 *
 * Required by docs/ALIA-V1-SPEC.md section 4 and the ALIA-002 acceptance criteria:
 * - organization A cannot perform any CRUD operation on organization B rows;
 * - a suspended or removed membership loses access immediately;
 * - an individual (one-owner) workspace cannot create or read organization-shared
 *   memory, and is invisible to every other organization;
 * - role checks restrict pedagogical and administrative actions;
 * - the request path fails closed with no claim at all.
 *
 * Every request-path statement runs as `alia_app` with a transaction-local claim, in
 * a transaction that is rolled back. Denied writes are additionally checked on the
 * privileged connection, so "no rows changed" is proved, not assumed.
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

/** Rows of one table that a principal can see for an organization. */
async function visibleRows(userId: string, table: string, organizationId: string): Promise<number> {
  const result = await runAsPrincipal(
    pool,
    userId,
    `select count(*)::int as n from public.${table} where ${orgFilter(table)} = $1`,
    [organizationId],
  );
  return Number(result.rows[0]?.n ?? -1);
}

describe('cross-organization isolation', () => {
  it('shows a member of organization A nothing from organization B in any table', async () => {
    const leaks: string[] = [];
    for (const table of TABLE_NAMES) {
      const count = await visibleRows(OWNER_A, table, ORG_B);
      if (count !== 0) leaks.push(`${table}=${count}`);
    }
    expect(leaks).toEqual([]);
  });

  it('shows a member of organization B nothing from organization A in any table', async () => {
    const leaks: string[] = [];
    for (const table of TABLE_NAMES) {
      const count = await visibleRows(OWNER_B, table, ORG_A);
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
      const result = await captureDenial(runAsPrincipalCommitted(pool, OWNER_A, sql, values));
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
      );
      const remove = await runAsPrincipal(
        pool,
        OWNER_A,
        `delete from public.${table} where organization_id = $1 returning 1`,
        [ORG_B],
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

describe('membership lifecycle', () => {
  it('removes data access immediately when a membership is suspended', async () => {
    expect(await visibleRows(EDUCATOR_A, 'learners', ORG_A)).toBe(2);

    expect(await setMembershipStatus(admin, ORG_A, EDUCATOR_A, 'suspended')).toBe(1);

    const rows = await runAsPrincipal(pool, EDUCATOR_A, 'select id from public.learners');
    expect(rows.rowCount).toBe(0);
    const write = await captureDenial(
      runAsPrincipalCommitted(
        pool,
        EDUCATOR_A,
        `insert into public.learners (organization_id, external_learner_id) values ($1, 'suspended-educator-learner')`,
        [ORG_A],
      ),
    );
    expect('denied' in write).toBe(true);
  });

  it('removes data access when a membership is marked removed, even across organizations', async () => {
    expect(await setMembershipStatus(admin, ORG_B, EDUCATOR_B, 'removed')).toBe(1);

    const rows = await runAsPrincipal(pool, EDUCATOR_B, 'select id from public.learners');
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
    );
    expect(memberships.rowCount).toBe(1);
    expect(memberships.rows[0]?.status).toBe('suspended');

    const orgs = await runAsPrincipal(pool, VIEWER_A, 'select id from public.organizations');
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
      ),
    );
    expect('denied' in evidence).toBe(true);

    const audit = await runAsPrincipal(
      pool,
      VIEWER_A,
      `insert into public.audit_events (organization_id, actor_user_id, action, target_type)
       values ($1, $2, 'learner.read', 'learner')`,
      [ORG_A, VIEWER_A],
    );
    expect(audit.rowCount).toBe(1);

    const auditRead = await runAsPrincipal(pool, VIEWER_A, 'select id from public.audit_events');
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
    );
    expect(inserted.rowCount).toBe(1);

    const updated = await runAsPrincipal(
      pool,
      EDUCATOR_A,
      `update public.learning_events set skill_id = 'rewritten' where organization_id = $1 returning id`,
      [ORG_A],
    );
    expect(updated.rowCount).toBe(0);

    const removed = await runAsPrincipal(
      pool,
      EDUCATOR_A,
      `delete from public.learning_events where organization_id = $1 returning id`,
      [ORG_A],
    );
    expect(removed.rowCount).toBe(0);

    const learnerRemoved = await runAsPrincipal(
      pool,
      EDUCATOR_A,
      `delete from public.learners where organization_id = $1 returning id`,
      [ORG_A],
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
    );
    expect(byEducator.rowCount).toBe(0);

    const byOwner = await runAsPrincipal(
      pool,
      OWNER_A,
      `update public.organization_memory set status = 'approved', approved_at = now(), reviewer_user_id = $2
        where organization_id = $1 and status = 'candidate' returning id`,
      [ORG_A, OWNER_A],
    );
    expect(byOwner.rowCount).toBe(1);
  });

  it('never serves a non-approved or expired memory row to a retrieval path', async () => {
    const pending = await runAsPrincipal(
      pool,
      EDUCATOR_A,
      `select id from public.organization_memory where status <> 'approved'`,
    );
    expect(pending.rowCount).toBe(0);

    const approved = await runAsPrincipal(
      pool,
      EDUCATOR_A,
      `select fingerprint from public.organization_memory order by fingerprint`,
    );
    expect(approved.rows.map((row) => row.fingerprint)).toEqual(['fp-a-approved']);

    await admin.query(
      `update public.organization_memory
          set approved_at = now() - interval '2 days', expires_at = now() - interval '1 day'
        where organization_id = $1 and status = 'approved'`,
      [ORG_A],
    );
    try {
      const expired = await runAsPrincipal(pool, EDUCATOR_A, 'select fingerprint from public.organization_memory');
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
    const asViewer = await runAsPrincipal(pool, VIEWER_A, 'select user_id from public.memberships');
    expect(asViewer.rowCount).toBe(1);
    expect(asViewer.rows[0]?.user_id).toBe(VIEWER_A);

    const asOwner = await runAsPrincipal(pool, OWNER_A, 'select user_id from public.memberships');
    expect(asOwner.rowCount).toBe(3);

    const asOtherOrgOwner = await runAsPrincipal(pool, OWNER_B, 'select user_id from public.memberships');
    expect(asOtherOrgOwner.rowCount).toBe(2);
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
      ),
    );
    expect('denied' in insert && insert.code).toBe('42501');

    const read = await runAsPrincipal(
      pool,
      OWNER_INDIVIDUAL,
      'select fingerprint from public.organization_memory',
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
    expect(await visibleRows(OWNER_A, 'learners', ORG_INDIVIDUAL)).toBe(0);
    expect(await visibleRows(OWNER_B, 'learners', ORG_INDIVIDUAL)).toBe(0);
    expect(await visibleRows(OWNER_A, 'organizations', ORG_INDIVIDUAL)).toBe(0);

    const intrusion = await captureDenial(
      runAsPrincipalCommitted(
        pool,
        OWNER_A,
        `insert into public.learners (organization_id, external_learner_id) values ($1, 'workspace-intruder')`,
        [ORG_INDIVIDUAL],
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
    );
    expect(ownBudget.rowCount).toBe(1);

    const otherOrgBudget = await runAsPrincipalCommitted(
      pool,
      OWNER_INDIVIDUAL,
      `update public.organization_budgets set daily_limit_usd = 99 where organization_id = $1`,
      [ORG_A],
    );
    expect(otherOrgBudget.rowCount).toBe(0);

    const roster = await runAsPrincipal(pool, OWNER_INDIVIDUAL, 'select user_id from public.memberships');
    expect(roster.rowCount).toBe(1);

    const otherOrgRows = await visibleRows(OWNER_INDIVIDUAL, 'learner_private_memory', ORG_A);
    expect(otherOrgRows).toBe(0);
  });
});
