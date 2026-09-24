-- ALIA-002 migration 0002: learning evidence, learner state, and private learner memory.
--
-- Design points enforced by the database, not by application code:
--   * every child row carries organization_id and is tied to its parent with a
--     composite foreign key, so a row can never point at another tenant's learner;
--   * learning evidence is append-only: no update or delete policy exists;
--   * a pseudonymous external learner reference may not contain an email-shaped
--     direct identifier.

-- ---------------------------------------------------------------------------
-- learners
-- ---------------------------------------------------------------------------

create table public.learners (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  external_learner_id text not null
    check (length(btrim(external_learner_id)) between 1 and 120)
    check (external_learner_id !~ '@')
    check (external_learner_id !~ '\s'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, external_learner_id),
  -- Composite foreign key target for every learner-owned table.
  unique (organization_id, id)
);

comment on table public.learners is
  'A pseudonymous learner reference inside one organization. Partner products own real identity; ALIA never stores a name, email, or external account.';

comment on column public.learners.external_learner_id is
  'Pseudonymous partner-side identifier. Email-shaped and whitespace-bearing values are rejected by check constraints.';

create index learners_organization_id_idx on public.learners (organization_id);

create trigger learners_touch_updated_at
  before update on public.learners
  for each row execute function app.touch_updated_at();

alter table public.learners enable row level security;
alter table public.learners force row level security;

create policy learners_select_pedagogical_roles
  on public.learners
  for select
  using (app.has_workspace_access(organization_id, array['owner', 'admin', 'educator']));

create policy learners_insert_pedagogical_roles
  on public.learners
  for insert
  with check (app.has_workspace_access(organization_id, array['owner', 'admin', 'educator']));

create policy learners_update_pedagogical_roles
  on public.learners
  for update
  using (app.has_workspace_access(organization_id, array['owner', 'admin', 'educator']))
  with check (app.has_workspace_access(organization_id, array['owner', 'admin', 'educator']));

create policy learners_delete_administrators
  on public.learners
  for delete
  using (app.has_workspace_access(organization_id, array['owner', 'admin']));

grant select, insert, update, delete on public.learners to alia_app;

-- ---------------------------------------------------------------------------
-- learning_events
-- ---------------------------------------------------------------------------

create table public.learning_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  learner_id uuid not null,
  external_event_id text not null check (length(btrim(external_event_id)) between 1 and 200),
  skill_id text not null check (length(btrim(skill_id)) between 1 and 200),
  event_type text not null check (length(btrim(event_type)) between 1 and 60),
  occurred_at timestamptz not null,
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  received_at timestamptz not null default now(),
  -- Organization-scoped idempotency: a partner may resend an event id safely.
  unique (organization_id, external_event_id),
  unique (organization_id, id),
  foreign key (organization_id, learner_id)
    references public.learners (organization_id, id) on delete cascade
);

comment on table public.learning_events is
  'Append-only learning evidence. There is deliberately no update or delete policy: evidence is immutable once accepted.';

comment on column public.learning_events.occurred_at is
  'Partner-reported event time. received_at is ALIA-side arrival time.';

create index learning_events_organization_learner_idx
  on public.learning_events (organization_id, learner_id, occurred_at desc);

alter table public.learning_events enable row level security;
alter table public.learning_events force row level security;

create policy learning_events_select_pedagogical_roles
  on public.learning_events
  for select
  using (app.has_workspace_access(organization_id, array['owner', 'admin', 'educator']));

create policy learning_events_insert_pedagogical_roles
  on public.learning_events
  for insert
  with check (app.has_workspace_access(organization_id, array['owner', 'admin', 'educator']));

grant select, insert, update, delete on public.learning_events to alia_app;

-- ---------------------------------------------------------------------------
-- learner_skill_state
-- ---------------------------------------------------------------------------

create table public.learner_skill_state (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  learner_id uuid not null,
  skill_id text not null check (length(btrim(skill_id)) between 1 and 200),
  mastery_band text not null default 'unseen'
    check (mastery_band in ('unseen', 'emerging', 'developing', 'secure', 'mastered')),
  mastery_score numeric(5, 4) check (mastery_score between 0 and 1),
  confidence numeric(5, 4) not null default 0 check (confidence between 0 and 1),
  evidence_count integer not null default 0 check (evidence_count >= 0),
  misconception_code text,
  algorithm_version text not null default 'deterministic-v0'
    check (length(btrim(algorithm_version)) between 1 and 60),
  updated_at timestamptz not null default now(),
  unique (organization_id, learner_id, skill_id),
  foreign key (organization_id, learner_id)
    references public.learners (organization_id, id) on delete cascade
);

comment on table public.learner_skill_state is
  'Deterministic learner state per skill. algorithm_version is recorded so a later change in the model is auditable.';

create trigger learner_skill_state_touch_updated_at
  before update on public.learner_skill_state
  for each row execute function app.touch_updated_at();

alter table public.learner_skill_state enable row level security;
alter table public.learner_skill_state force row level security;

create policy learner_skill_state_select_pedagogical_roles
  on public.learner_skill_state
  for select
  using (app.has_workspace_access(organization_id, array['owner', 'admin', 'educator']));

create policy learner_skill_state_insert_pedagogical_roles
  on public.learner_skill_state
  for insert
  with check (app.has_workspace_access(organization_id, array['owner', 'admin', 'educator']));

create policy learner_skill_state_update_pedagogical_roles
  on public.learner_skill_state
  for update
  using (app.has_workspace_access(organization_id, array['owner', 'admin', 'educator']))
  with check (app.has_workspace_access(organization_id, array['owner', 'admin', 'educator']));

create policy learner_skill_state_delete_administrators
  on public.learner_skill_state
  for delete
  using (app.has_workspace_access(organization_id, array['owner', 'admin']));

grant select, insert, update, delete on public.learner_skill_state to alia_app;

-- ---------------------------------------------------------------------------
-- learner_private_memory
-- ---------------------------------------------------------------------------

create table public.learner_private_memory (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  learner_id uuid not null,
  kind text not null
    check (kind in ('mastery_evidence', 'intervention_outcome', 'misconception', 'preference')),
  summary jsonb not null check (jsonb_typeof(summary) = 'object'),
  fingerprint text not null check (length(fingerprint) between 8 and 200),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, learner_id)
    references public.learners (organization_id, id) on delete cascade
);

comment on table public.learner_private_memory is
  'Private learner memory. Never readable across learners and never promoted into organization memory by any policy or constraint in this schema.';

create index learner_private_memory_learner_idx
  on public.learner_private_memory (organization_id, learner_id);

create trigger learner_private_memory_touch_updated_at
  before update on public.learner_private_memory
  for each row execute function app.touch_updated_at();

alter table public.learner_private_memory enable row level security;
alter table public.learner_private_memory force row level security;

create policy learner_private_memory_select_pedagogical_roles
  on public.learner_private_memory
  for select
  using (app.has_workspace_access(organization_id, array['owner', 'admin', 'educator']));

create policy learner_private_memory_insert_pedagogical_roles
  on public.learner_private_memory
  for insert
  with check (app.has_workspace_access(organization_id, array['owner', 'admin', 'educator']));

create policy learner_private_memory_update_pedagogical_roles
  on public.learner_private_memory
  for update
  using (app.has_workspace_access(organization_id, array['owner', 'admin', 'educator']))
  with check (app.has_workspace_access(organization_id, array['owner', 'admin', 'educator']));

create policy learner_private_memory_delete_administrators
  on public.learner_private_memory
  for delete
  using (app.has_workspace_access(organization_id, array['owner', 'admin']));

grant select, insert, update, delete on public.learner_private_memory to alia_app;

-- ---------------------------------------------------------------------------
-- decisions
-- ---------------------------------------------------------------------------

create table public.decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  learner_id uuid not null,
  trace_id text not null check (length(btrim(trace_id)) between 8 and 128),
  source text not null check (source in ('rule', 'organization_memory', 'cache', 'model')),
  recommended_action text not null check (length(btrim(recommended_action)) between 1 and 200),
  reason_codes text[] not null default array[]::text[],
  review_recommended boolean not null default false,
  algorithm_version text not null default 'deterministic-v0'
    check (length(btrim(algorithm_version)) between 1 and 60),
  created_at timestamptz not null default now(),
  -- Composite foreign key target for the later intervention-outcome table.
  unique (organization_id, id),
  foreign key (organization_id, learner_id)
    references public.learners (organization_id, id) on delete cascade
);

comment on table public.decisions is
  'Decision audit trail: what ALIA recommended, why (reason codes), and from which source. Append-only.';

create index decisions_organization_learner_idx
  on public.decisions (organization_id, learner_id, created_at desc);

alter table public.decisions enable row level security;
alter table public.decisions force row level security;

create policy decisions_select_pedagogical_roles
  on public.decisions
  for select
  using (app.has_workspace_access(organization_id, array['owner', 'admin', 'educator']));

create policy decisions_insert_pedagogical_roles
  on public.decisions
  for insert
  with check (app.has_workspace_access(organization_id, array['owner', 'admin', 'educator']));

grant select, insert, update, delete on public.decisions to alia_app;
