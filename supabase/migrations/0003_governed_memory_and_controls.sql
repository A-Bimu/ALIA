-- ALIA-002 migration 0003: governed organization memory, cost controls, and audit.
--
-- The individual-workspace prohibition is enforced by the database itself, not by a
-- policy that could be relaxed later: organization_memory carries account_type pinned
-- to 'organization' and references organizations(id, account_type), so an
-- organization-shared memory row for a one-owner individual workspace is
-- unrepresentable. Converting an organization with shared memory into an individual
-- workspace is likewise refused until that memory is removed.

-- ---------------------------------------------------------------------------
-- organization_memory
-- ---------------------------------------------------------------------------

create table public.organization_memory (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  account_type text not null default 'organization' check (account_type = 'organization'),
  fingerprint text not null
    check (length(fingerprint) between 8 and 200)
    check (fingerprint !~ '@'),
  misconception_signature text not null
    check (length(btrim(misconception_signature)) between 3 and 400)
    check (misconception_signature !~ '@'),
  skill_id text not null check (length(btrim(skill_id)) between 1 and 200),
  curriculum_scope text not null default '' check (length(curriculum_scope) <= 200),
  approved_intervention text not null
    check (length(btrim(approved_intervention)) between 3 and 4000)
    check (approved_intervention !~ '@'),
  provenance jsonb not null default '{}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  reviewer_user_id uuid,
  quality_score numeric(5, 4) check (quality_score between 0 and 1),
  usage_count integer not null default 0 check (usage_count >= 0),
  success_count integer not null default 0 check (success_count >= 0),
  version integer not null default 1 check (version > 0),
  status text not null default 'candidate'
    check (status in ('candidate', 'approved', 'rejected', 'expired', 'retired')),
  approved_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, fingerprint, version),
  check (success_count <= usage_count),
  check (status <> 'approved' or approved_at is not null),
  check (status <> 'approved' or reviewer_user_id is not null),
  check (expires_at is null or approved_at is null or expires_at > approved_at),
  foreign key (organization_id, account_type)
    references public.organizations (id, account_type),
  -- An approving reviewer must be a member of the same organization.
  foreign key (organization_id, reviewer_user_id)
    references public.memberships (organization_id, user_id)
);

comment on table public.organization_memory is
  'Generalized, approved, reusable solutions. Stores a normalized signature and an approved intervention only: never a learner name, email, external learner id, raw chat, or raw submission.';

comment on column public.organization_memory.reviewer_user_id is
  'Membership-scoped reviewer. The composite foreign key prevents an approving user from another organization.';

create index organization_memory_lookup_idx
  on public.organization_memory (organization_id, fingerprint, version desc);

create index organization_memory_retrieval_idx
  on public.organization_memory (organization_id, status, expires_at);

create trigger organization_memory_touch_updated_at
  before update on public.organization_memory
  for each row execute function app.touch_updated_at();

alter table public.organization_memory enable row level security;
alter table public.organization_memory force row level security;

-- Retrieval: approved, unexpired, and role-scoped. Rejected, expired, retired, and
-- pending rows are not visible to a retrieval path.
create policy organization_memory_select_approved
  on public.organization_memory
  for select
  using (
    status = 'approved'
    and (expires_at is null or expires_at > now())
    and app.has_workspace_access(organization_id, array['owner', 'admin', 'educator'])
  );

-- Review: organization admins may read candidates and history inside their organization.
create policy organization_memory_select_review
  on public.organization_memory
  for select
  using (app.is_organization_admin(organization_id));

-- A candidate must be created as a candidate: no self-approval on insert.
create policy organization_memory_insert_candidate
  on public.organization_memory
  for insert
  with check (
    status = 'candidate'
    and app.has_workspace_access(organization_id, array['owner', 'admin', 'educator'])
    and not app.is_individual_workspace(organization_id)
  );

-- Approval belongs to an organization admin, so a candidate can never approve
-- itself: it cannot update the row it just created.

create policy organization_memory_update_approval
  on public.organization_memory
  for update
  using (app.is_organization_admin(organization_id))
  with check (app.is_organization_admin(organization_id));

-- No delete policy: memory is retired or expired, never silently removed.

grant select, insert, update, delete on public.organization_memory to alia_app;

-- ---------------------------------------------------------------------------
-- model_usage: the cost ledger
-- ---------------------------------------------------------------------------

create table public.model_usage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  trace_id text not null check (length(btrim(trace_id)) between 8 and 128),
  route_reason text not null check (length(btrim(route_reason)) between 1 and 120),
  outcome text not null
    check (outcome in ('model_success', 'model_error', 'model_timeout', 'budget_blocked',
                       'circuit_open', 'cache_hit', 'memory_hit', 'rule_only')),
  provider text check (provider is null or length(btrim(provider)) between 1 and 60),
  model text check (model is null or length(btrim(model)) between 1 and 120),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  estimated_cost_usd numeric(12, 6) not null default 0 check (estimated_cost_usd >= 0),
  latency_ms integer check (latency_ms is null or latency_ms >= 0),
  created_at timestamptz not null default now(),
  unique (organization_id, id)
);

comment on table public.model_usage is
  'Per-request cost and route evidence. Carries no prompt, no completion, and no learner payload.';

create index model_usage_organization_created_idx
  on public.model_usage (organization_id, created_at desc);

alter table public.model_usage enable row level security;
alter table public.model_usage force row level security;

create policy model_usage_select_administrators
  on public.model_usage
  for select
  using (app.has_workspace_access(organization_id, array['owner', 'admin']));

create policy model_usage_insert_pedagogical_roles
  on public.model_usage
  for insert
  with check (app.has_workspace_access(organization_id, array['owner', 'admin', 'educator']));

-- The ledger is append-only: no update and no delete policy.

grant select, insert, update, delete on public.model_usage to alia_app;

-- ---------------------------------------------------------------------------
-- organization_budgets
-- ---------------------------------------------------------------------------

create table public.organization_budgets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations (id) on delete cascade,
  daily_limit_usd numeric(12, 6) not null default 0 check (daily_limit_usd >= 0),
  monthly_limit_usd numeric(12, 6) not null default 0 check (monthly_limit_usd >= 0),
  daily_spent_usd numeric(12, 6) not null default 0 check (daily_spent_usd >= 0),
  monthly_spent_usd numeric(12, 6) not null default 0 check (monthly_spent_usd >= 0),
  period_started_on date not null default current_date,
  updated_at timestamptz not null default now()
);

comment on table public.organization_budgets is
  'Per-workspace spend limits. Limits of zero mean no paid provider call is permitted.';

create trigger organization_budgets_touch_updated_at
  before update on public.organization_budgets
  for each row execute function app.touch_updated_at();

alter table public.organization_budgets enable row level security;
alter table public.organization_budgets force row level security;

create policy organization_budgets_select_owners
  on public.organization_budgets
  for select
  using (app.has_workspace_access(organization_id, array['owner', 'admin']));

create policy organization_budgets_insert_owners
  on public.organization_budgets
  for insert
  with check (app.has_workspace_access(organization_id, array['owner', 'admin']));

create policy organization_budgets_update_owners
  on public.organization_budgets
  for update
  using (app.has_workspace_access(organization_id, array['owner', 'admin']))
  with check (app.has_workspace_access(organization_id, array['owner', 'admin']));

grant select, insert, update, delete on public.organization_budgets to alia_app;

-- ---------------------------------------------------------------------------
-- audit_events
-- ---------------------------------------------------------------------------

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  actor_user_id uuid,
  action text not null check (length(btrim(action)) between 3 and 80),
  target_type text not null check (length(btrim(target_type)) between 2 and 80),
  target_id uuid,
  trace_id text check (trace_id is null or length(btrim(trace_id)) between 8 and 128),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

comment on table public.audit_events is
  'Privacy-safe audit trail: who did what to which object, with a trace id. metadata must carry counts and codes, never payloads.';

create index audit_events_organization_created_idx
  on public.audit_events (organization_id, created_at desc);

alter table public.audit_events enable row level security;
alter table public.audit_events force row level security;

create policy audit_events_select_owners
  on public.audit_events
  for select
  using (app.has_workspace_access(organization_id, array['owner', 'admin']));

create policy audit_events_insert_active_members
  on public.audit_events
  for insert
  with check (
    app.is_active_member(organization_id)
    -- An actor may only be recorded as itself: the trail cannot be forged.
    and (actor_user_id is null or actor_user_id = app.current_user_id())
  );

-- Append-only: no update and no delete policy, so an audit trail cannot be edited
-- through a partner request path.

grant select, insert, update, delete on public.audit_events to alia_app;
