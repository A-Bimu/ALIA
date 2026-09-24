-- ALIA-002 migration 0001: tenancy root, membership RLS, and the helper functions
-- every tenant policy is built on.
--
-- Invariants established here:
--   * every tenant-owned table enables *and forces* row level security;
--   * no table starts with a permissive policy: access must be granted explicitly;
--   * the request identity comes from a verified claim, never from a request body;
--   * the application runs as `alia_app`, a role with no superuser, no BYPASSRLS,
--     and no ownership of any tenant table.
--
-- Security-definer helpers are used only where a policy would otherwise recurse on
-- the memberships table. Each one has a fixed empty search_path, fully qualified
-- object names, a revoked PUBLIC grant, and a test in tests/integration/rls.

create schema if not exists app;

comment on schema app is
  'ALIA-owned helper functions and bookkeeping. Never reachable from a partner product.';

-- The only role normal tenant requests run as. NOLOGIN: a request transaction
-- enters it with SET LOCAL ROLE from a scoped login role (Supabase `authenticated`
-- in staging), so no credential for this role exists anywhere.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'alia_app') then
    create role alia_app nologin noinherit nosuperuser nocreatedb nocreaterole
      noreplication nobypassrls;
  end if;
end
$$;

-- The migration ledger and the ALIA role are created by the runner
-- (src/lib/db/migrations.ts) before this file is applied. See docs/DEVELOPMENT.md.

-- ---------------------------------------------------------------------------
-- organizations: the isolation root
-- ---------------------------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  account_type text not null default 'organization'
    check (account_type in ('organization', 'individual')),
  status text not null default 'active'
    check (status in ('active', 'suspended', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Referenced by organization_memory's composite foreign key, which is what makes
  -- an organization-shared memory row impossible in an individual workspace.
  unique (id, account_type)
);

comment on table public.organizations is
  'Tenant isolation root. account_type distinguishes a multi-member organization from a one-owner individual workspace.';

-- ---------------------------------------------------------------------------
-- memberships
-- ---------------------------------------------------------------------------

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner', 'admin', 'educator', 'viewer')),
  status text not null default 'active' check (status in ('active', 'suspended', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

comment on table public.memberships is
  'Organization identity is derived from these rows only. A client-supplied organization id is never trusted.';

comment on column public.memberships.user_id is
  'Authenticated principal id from the verified token subject. Not a learner id.';

create index memberships_user_id_idx on public.memberships (user_id);

-- ---------------------------------------------------------------------------
-- Request identity helpers
-- ---------------------------------------------------------------------------

-- The verified subject claim, as set by the request transaction. Reads the
-- Supabase-compatible session settings and never raises on hostile input.
create or replace function app.claim_sub()
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    case
      when left(nullif(current_setting('request.jwt.claims', true), ''), 1) = '{'
        then nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    end
  )
$$;

comment on function app.claim_sub() is
  'Verified subject claim for the current transaction. Null when absent or unset.';

-- The same claim, but only when it is a well-formed UUID. A malformed claim
-- yields null, so every policy built on it fails closed instead of raising.
create or replace function app.current_user_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select case
    when app.claim_sub() ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then app.claim_sub()::uuid
    else null
  end
$$;

comment on function app.current_user_id() is
  'Authenticated principal id, or null. Fail-closed input for every tenant policy.';

-- ---------------------------------------------------------------------------
-- Membership helpers (security definer: these read memberships from inside
-- memberships policies, which cannot use RLS itself without recursing).
-- ---------------------------------------------------------------------------

create or replace function app.is_active_member(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.organization_id = target_organization_id
      and m.user_id = app.current_user_id()
      and m.status = 'active'
  )
$$;

comment on function app.is_active_member(uuid) is
  'True only when the current principal holds an active membership in that organization.';

-- Workspace access combines the two access rules required by the specification:
-- inside an organization, the membership role must be in the allowed set; inside a
-- one-owner individual workspace, only the owner has access.
create or replace function app.has_workspace_access(target_organization_id uuid, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = target_organization_id
      and m.user_id = app.current_user_id()
      and m.status = 'active'
      and (
        (o.account_type = 'individual' and m.role = 'owner')
        or (o.account_type = 'organization' and m.role = any(allowed_roles))
      )
  )
$$;

comment on function app.has_workspace_access(uuid, text[]) is
  'Active role access inside an organization, or owner-only access inside an individual workspace.';

-- Administration of an organization: rosters, budgets, and organization memory
-- approval. Deliberately false for individual workspaces, so a one-owner workspace
-- can never use organization-shared memory or manage a roster.
create or replace function app.is_organization_admin(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = target_organization_id
      and m.user_id = app.current_user_id()
      and m.status = 'active'
      and o.account_type = 'organization'
      and m.role = any(array['owner', 'admin'])
  )
$$;

comment on function app.is_organization_admin(uuid) is
  'True only for an active owner or admin of a multi-member organization.';

-- True only for an active member of a one-owner individual workspace. Lets the RLS
-- layer itself refuse organization-shared memory in such a workspace, in addition to
-- the composite foreign key that makes the row unrepresentable.
create or replace function app.is_individual_workspace(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organizations o
    join public.memberships m on m.organization_id = o.id
    where o.id = target_organization_id
      and o.account_type = 'individual'
      and m.user_id = app.current_user_id()
      and m.status = 'active'
  )
$$;

comment on function app.is_individual_workspace(uuid) is
  'True only for an active member of a one-owner individual workspace.';

revoke all on function app.claim_sub() from public;
revoke all on function app.current_user_id() from public;
revoke all on function app.is_active_member(uuid) from public;
revoke all on function app.has_workspace_access(uuid, text[]) from public;
revoke all on function app.is_organization_admin(uuid) from public;
revoke all on function app.is_individual_workspace(uuid) from public;

grant usage on schema app to alia_app;
grant execute on function app.claim_sub() to alia_app;
grant execute on function app.current_user_id() to alia_app;
grant execute on function app.is_active_member(uuid) to alia_app;
grant execute on function app.has_workspace_access(uuid, text[]) to alia_app;
grant execute on function app.is_organization_admin(uuid) to alia_app;
grant execute on function app.is_individual_workspace(uuid) to alia_app;

-- Shared updated_at trigger. No table access, so a plain invoker function is safe.
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Trigger functions are invoked by the trigger, not by a caller, so no role needs
-- an execute grant.
revoke all on function app.touch_updated_at() from public;

create trigger organizations_touch_updated_at
  before update on public.organizations
  for each row execute function app.touch_updated_at();

create trigger memberships_touch_updated_at
  before update on public.memberships
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: enabled and forced, then granted narrowly
-- ---------------------------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.organizations force row level security;

create policy organizations_select_own_membership
  on public.organizations
  for select
  using (app.is_active_member(id));

-- No insert, update, or delete policy: lifecycle changes belong to a named
-- administrative background task, not to a partner request.

alter table public.memberships enable row level security;
alter table public.memberships force row level security;

-- A principal may always read its own memberships (including a suspended one, so a
-- suspension is observable); a roster is readable only by an organization admin.
create policy memberships_select_own_or_admin
  on public.memberships
  for select
  using (
    user_id = app.current_user_id()
    or app.is_organization_admin(organization_id)
  );

create policy memberships_insert_by_admin
  on public.memberships
  for insert
  with check (app.is_organization_admin(organization_id));

create policy memberships_update_by_admin
  on public.memberships
  for update
  using (app.is_organization_admin(organization_id))
  with check (app.is_organization_admin(organization_id));

create policy memberships_delete_by_admin
  on public.memberships
  for delete
  using (app.is_organization_admin(organization_id));

grant select, insert, update, delete on public.organizations to alia_app;
grant select, insert, update, delete on public.memberships to alia_app;
