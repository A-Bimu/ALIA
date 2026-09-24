/**
 * Two-organization fixture used by the RLS proof.
 *
 * Required by docs/ALIA-V1-SPEC.md section 4 and the ALIA-002 acceptance criteria:
 * two organizations, at least two members, distinct learners, plus an individual
 * (one-owner) workspace and a principal with no membership at all.
 *
 * Seeding runs on the privileged migration connection, which the request path never
 * uses; every assertion about tenant data is made through the restricted role.
 */

import type { Client } from 'pg';

export const ORG_A = '11111111-1111-1111-1111-111111111111';
export const ORG_B = '22222222-2222-2222-2222-222222222222';
export const ORG_INDIVIDUAL = '33333333-3333-3333-3333-333333333333';

export const OWNER_A = 'aaaaaaaa-0000-0000-0000-000000000001';
export const EDUCATOR_A = 'aaaaaaaa-0000-0000-0000-000000000002';
export const VIEWER_A = 'aaaaaaaa-0000-0000-0000-000000000003';
export const OWNER_B = 'bbbbbbbb-0000-0000-0000-000000000001';
export const EDUCATOR_B = 'bbbbbbbb-0000-0000-0000-000000000002';
export const OWNER_INDIVIDUAL = 'cccccccc-0000-0000-0000-000000000001';
/** Authenticated but a member of nothing. */
export const OUTSIDER = 'dddddddd-0000-0000-0000-000000000001';

export const LEARNER_A1 = 'eeeeeeee-0000-0000-0000-000000000001';
export const LEARNER_A2 = 'eeeeeeee-0000-0000-0000-000000000002';
export const LEARNER_B1 = 'ffffffff-0000-0000-0000-000000000001';
export const LEARNER_INDIVIDUAL = 'ffffffff-0000-0000-0000-000000000002';

export const MEMBERSHIP_USERS = [
  OWNER_A,
  EDUCATOR_A,
  VIEWER_A,
  OWNER_B,
  EDUCATOR_B,
  OWNER_INDIVIDUAL,
] as const;

export async function seedFixtures(admin: Client): Promise<void> {
  await admin.query(
    `insert into public.organizations (id, name, account_type) values
       ($1, 'Org A', 'organization'),
       ($2, 'Org B', 'organization'),
       ($3, 'Solo workspace', 'individual')`,
    [ORG_A, ORG_B, ORG_INDIVIDUAL],
  );

  await admin.query(
    `insert into public.memberships (organization_id, user_id, role, status) values
       ($1, $4, 'owner', 'active'),
       ($1, $5, 'educator', 'active'),
       ($1, $6, 'viewer', 'active'),
       ($2, $7, 'owner', 'active'),
       ($2, $8, 'educator', 'active'),
       ($3, $9, 'owner', 'active')`,
    [ORG_A, ORG_B, ORG_INDIVIDUAL, OWNER_A, EDUCATOR_A, VIEWER_A, OWNER_B, EDUCATOR_B, OWNER_INDIVIDUAL],
  );

  await admin.query(
    `insert into public.learners (id, organization_id, external_learner_id) values
       ($1, $5, 'learner-a1'),
       ($2, $5, 'learner-a2'),
       ($3, $6, 'learner-b1'),
       ($4, $7, 'learner-solo')`,
    [LEARNER_A1, LEARNER_A2, LEARNER_B1, LEARNER_INDIVIDUAL, ORG_A, ORG_B, ORG_INDIVIDUAL],
  );

  await admin.query(
    `insert into public.learning_events
       (organization_id, learner_id, external_event_id, skill_id, event_type, occurred_at, evidence)
     values
       ($1, $2, 'evt-a1', 'skill-1', 'attempt', now(), '{"correct": false}'::jsonb),
       ($1, $3, 'evt-a2', 'skill-1', 'attempt', now(), '{"correct": true}'::jsonb),
       ($4, $5, 'evt-b1', 'skill-1', 'attempt', now(), '{"correct": false}'::jsonb)`,
    [ORG_A, LEARNER_A1, LEARNER_A2, ORG_B, LEARNER_B1],
  );

  await admin.query(
    `insert into public.learner_skill_state
       (organization_id, learner_id, skill_id, mastery_band, mastery_score, confidence, evidence_count)
     values
       ($1, $3, 'skill-1', 'emerging', 0.3000, 0.4000, 2),
       ($2, $4, 'skill-1', 'developing', 0.5000, 0.3000, 1)`,
    [ORG_A, ORG_B, LEARNER_A1, LEARNER_B1],
  );

  await admin.query(
    `insert into public.learner_private_memory
       (organization_id, learner_id, kind, summary, fingerprint)
     values
       ($1, $3, 'misconception', '{"code": "sign_error"}'::jsonb, 'priv-fp-a1'),
       ($2, $4, 'misconception', '{"code": "sign_error"}'::jsonb, 'priv-fp-b1')`,
    [ORG_A, ORG_B, LEARNER_A1, LEARNER_B1],
  );

  await admin.query(
    `insert into public.decisions
       (organization_id, learner_id, trace_id, source, recommended_action, reason_codes)
     values
       ($1, $3, 'trace-a-00000001', 'rule', 'retry_with_hint', array['low_confidence']),
       ($2, $4, 'trace-b-00000001', 'rule', 'retry_with_hint', array['low_confidence'])`,
    [ORG_A, ORG_B, LEARNER_A1, LEARNER_B1],
  );

  await admin.query(
    `insert into public.organization_memory
       (organization_id, fingerprint, misconception_signature, skill_id, approved_intervention,
        status, approved_at, reviewer_user_id, quality_score)
     values
       ($1, 'fp-a-approved', 'sign error on linear equations', 'skill-1',
        'Re-teach inverse operations with a worked example.', 'approved', now(), $3, 0.8000),
       ($1, 'fp-a-candidate', 'unit conversion slip', 'skill-1',
        'Use a unit-cancellation drill.', 'candidate', null, null, null),
       ($2, 'fp-b-approved', 'sign error on linear equations', 'skill-1',
        'Org B intervention text.', 'approved', now(), $4, 0.5000)`,
    [ORG_A, ORG_B, OWNER_A, OWNER_B],
  );

  await admin.query(
    `insert into public.model_usage
       (organization_id, trace_id, route_reason, outcome, provider, model, input_tokens, output_tokens, estimated_cost_usd, latency_ms)
     values
       ($1, 'trace-a-00000001', 'rule_hit', 'rule_only', null, null, null, null, 0, 12),
       ($2, 'trace-b-00000001', 'rule_hit', 'rule_only', null, null, null, null, 0, 11)`,
    [ORG_A, ORG_B],
  );

  await admin.query(
    `insert into public.organization_budgets (organization_id, daily_limit_usd, monthly_limit_usd)
     values ($1, 1.000000, 10.000000), ($2, 1.000000, 10.000000)`,
    [ORG_A, ORG_B],
  );

  await admin.query(
    `insert into public.audit_events (organization_id, actor_user_id, action, target_type)
     values ($1, $3, 'learner.read', 'learner'), ($2, $4, 'learner.read', 'learner')`,
    [ORG_A, ORG_B, OWNER_A, OWNER_B],
  );
}

/**
 * Seed once per database. Every test file runs in its own worker against the same
 * database, so the guard makes seeding idempotent across files.
 */
export async function ensureFixturesSeeded(admin: Client): Promise<void> {
  const existing = await admin.query('select count(*)::int as n from public.organizations');
  const count = Number((existing.rows[0] as { n: number }).n);
  if (count === 0) await seedFixtures(admin);
}

export async function setMembershipStatus(
  admin: Client,
  organizationId: string,
  userId: string,
  status: 'active' | 'suspended' | 'removed',
): Promise<number> {
  const result = await admin.query(
    `update public.memberships set status = $3 where organization_id = $1 and user_id = $2`,
    [organizationId, userId, status],
  );
  return result.rowCount ?? 0;
}

/** Put every fixture membership back to active after a mutation test. */
export async function restoreFixtureMemberships(admin: Client): Promise<void> {
  await admin.query(`update public.memberships set status = 'active' where user_id = any($1::uuid[])`, [
    [...MEMBERSHIP_USERS],
  ]);
}

/** Count rows on a privileged connection; used only to prove a denied write did not land. */
export async function privilegedCount(
  admin: Client,
  sql: string,
  values: unknown[] = [],
): Promise<number> {
  const result = await admin.query(sql, values);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  const value = row ? Object.values(row)[0] : 0;
  return Number(value ?? 0);
}
