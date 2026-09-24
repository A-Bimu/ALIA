# Architecture decision log

## ADR-001: Independent product boundary

Status: accepted, 2026-09-23

Adaptive Learning Intelligence Agent is an independent API/SDK service. Eureka Learn and KidyCode are independent products and first validation environments. They retain curriculum, identity, and learner experience.

## ADR-002: Modular monolith for alpha

Status: accepted, 2026-09-23

Use a TypeScript modular monolith with Supabase PostgreSQL/Auth. This is the fastest low-cost path to a secure pilot. Extract services only after measured need.

## ADR-003: Database-enforced tenancy

Status: accepted, 2026-09-23

All tenant data is rooted in organization_id and protected by forced RLS. Individual accounts receive one-owner isolated workspaces, but database rules prohibit organization-shared memory for them.

## ADR-004: Governed organization memory

Status: accepted, 2026-09-23

Only generalized, approved, active solutions are reused inside the same organization. Private learner memory is never automatically shared. Exact fingerprints and lexical retrieval precede optional embeddings.

## ADR-005: Cost-first model routing

Status: accepted, 2026-09-23

Rules, approved memory, cache, and retrieval precede a small configured Meta Llama route. Stronger model escalation requires an explicit reason. Budgets and circuit breakers are mandatory.

## ADR-006: Explainable alpha learner model

Status: accepted, 2026-09-23

Use deterministic evidence weighting in the synchronous alpha. Retain PyTorch as the planned evaluated experimentation path after sufficient pilot data exists.

## ADR-007: GitHub agent coordination

Status: accepted, 2026-09-23

Hermes implements one queued task per branch and pull request. Codex reviews and may merge non-production changes only after defined gates pass. Production actions remain human-approved.

## ADR-008: Server-side PostgreSQL access with SET LOCAL ROLE and the verified claim

Status: accepted, 2026-09-24 (ALIA-002)

ALIA's server connects to PostgreSQL with `pg` rather than through PostgREST for the
alpha. Each tenant request runs in one transaction that enters a restricted NOLOGIN
role (`alia_app`) with `set local role` and publishes the verified token subject as a
transaction-local `request.jwt.claim.sub`, which is the same claim shape Supabase uses
in its own RLS helpers. Benefits: policies are the only access decision, no credential
for the application role exists anywhere, the path is testable against any PostgreSQL
without the Supabase stack, and `auth.uid()`-style behaviour is available by defining
`app.current_user_id()` ourselves. Costs: ALIA owns the transaction wrapper and must keep
the claim contract stable. Supabase's `authenticated` role plays the scoped login role in
staging; that login is configured separately (ADR-011), and only named administrative
background jobs use the service role. The organization a transaction acts in is bound to
the same transaction (ADR-010).

## ADR-009: Real PostgreSQL in the test harness

Status: accepted, 2026-09-24 (ALIA-002)

Forced RLS, policy recursion, composite foreign keys, and role privileges cannot be
proved with a mock. The request-path suites therefore run against a real PostgreSQL 18.
CI starts a service container and passes `ALIA_TEST_DATABASE_URL`. Locally the harness
starts the pinned `embedded-postgres` devDependency, which needs no Docker and no
administrator rights; it is a test-only dependency and not part of the deployed service.
The harness login it creates for the request path is deliberately unprivileged, so the
application guards are exercised against the shape a deployment uses.

## ADR-010: The selected organization is bound to the request transaction

Status: accepted, 2026-09-24 (ALIA-002 coordinator review repair)

Membership alone does not scope a request. After the organization has been resolved from
an active membership row, the request transaction publishes it as the transaction-local
`app.organization_id`; `app.current_organization_id()` validates it and every tenant
access helper (`is_active_member`, `has_workspace_access`, `is_organization_admin`,
`is_individual_workspace`) requires its target to equal it. A principal that belongs to
two organizations therefore cannot read or write the other one inside a transaction
scoped to the first, and an unset or malformed selection denies everything. Membership
discovery stays a separate, earlier step: without a selected organization a principal can
read its own membership rows and no other tenant row. Regression coverage:
`tests/integration/rls/isolation.test.ts` ("selected-organization binding").

## ADR-011: Separate request and administrative database credentials

Status: accepted, 2026-09-24 (ALIA-002 coordinator review repair)

`DATABASE_URL` is the migration/administrative connection and is used only by
`npm run db:migrate` and the test harness. `ALIA_DB_REQUEST_URL` is a dedicated
least-privileged login used by normal tenant requests. Validation refuses a privileged
login name, a connection string with no login role, a login equal to the application
role, and any reuse of the administrative connection; the live session is verified before
the work runs and again before commit (restricted role, unprivileged login, owns no
relation, member of no privileged role), so `RESET ROLE` cannot regain a bypassing
session and a transaction that leaves the restricted role cannot commit. A credential
split that is only documented would not survive review: it is enforced in code and proved
by `tests/integration/db/credential-split.test.ts` against a real database.
