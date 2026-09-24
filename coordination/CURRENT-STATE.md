# Current build state

Updated: 2026-09-24 (ALIA-002 coordinator review repair)

## Release

Founding-Pilot Alpha with a seven-day target. This is not an error-free or full-production claim.

## Completed

- Independent A-Bimu/ALIA repository created.
- Product boundary, security invariants, architecture, cost controls, and phased task queue defined.
- GitHub coordination and Hermes worker files initialized.
- CI governance checks initialized.
- ALIA-001, Foundation and executable contract: TypeScript modular monolith scaffold, typed environment
  validation with a secret-free `.env.example`, structured error contract, trace IDs, `GET /api/v1/health`,
  lint/typecheck/test/build scripts, and a Vitest harness. Pull request #1 merged.
- ALIA-002, Tenant identity, schema, and RLS proof: eleven tenant-owned tables with forced RLS, trusted
  organization resolution from verified membership, role checks, a transaction-bound selected organization,
  a separate least-privileged request credential, and a real-database RLS isolation proof.

## Active

- Next task: ALIA-003, Learning-event and mastery loop (ready; depends on ALIA-002, completed). **Not
  started**: the coordinator change request on pull request #2 takes precedence.
- Owner: Hermes implementation worker.
- Reviewer/coordinator: Codex GitHub task.
- Open pull request: #2 `hermes/ALIA-002-tenant-identity-rls`. It carries the ALIA-002 work plus the two
  blocking repairs below and is awaiting coordinator re-review. No other task is claimed and no other
  branch exists.

## ALIA-002 coordinator review repair (2026-09-24)

`COORDINATOR_STATUS: CHANGES_REQUESTED` on head `5512594` raised two blocking isolation gaps. Both are
repaired inside ALIA-002 scope, with a regression case for each finding that fails on the reviewed revision
and passes after the fix.

### Finding 1 - the resolved organization was not enforced by RLS

`withTenant()` published `app.organization_id`, but no helper or policy read it:
`app.has_workspace_access()`, `app.is_active_member()`, `app.is_organization_admin()`, and
`app.is_individual_workspace()` authorized against *any* active membership of the subject, so a principal
in organizations A and B could be resolved to A and then read or mutate B inside that A-scoped transaction.

Repair:

- `supabase/migrations/0001_foundation.sql` adds `app.current_organization_id()`, which validates the
  transaction-local `app.organization_id` (UUID shape, `null` when unset, empty, or malformed, `stable`,
  fixed empty `search_path`, PUBLIC execute revoked).
- All four tenant access helpers now additionally require
  `target_organization_id = app.current_organization_id()`.
- The `memberships_select_own_or_admin` policy keeps pre-selection discovery separate: a principal's own
  rows are readable while no organization is selected, and are limited to the selected organization once one
  is. No other table is reachable without a selected organization.
- `src/lib/db/tenant.ts` always writes `app.organization_id` (the empty string when no organization is
  selected, so a request cannot inherit another transaction's selection) and refuses a malformed selected
  organization before opening a transaction.
- `tests/integration/rls/schema-invariants.test.ts` now fails the suite if any workspace helper stops
  requiring the selected organization, and the helper inventory was extended with
  `current_organization_id`.

### Finding 2 - the no-privileged-credential gate checked the target role, not the connection role

`readDbConfig()` rejected a privileged `ALIA_DB_APP_ROLE`, but `createPool()` connected with
`DATABASE_URL` - the migration/owner connection - and `assertUnprivilegedSession()` inspected `current_user`
only *after* `SET LOCAL ROLE alia_app`, so a database owner or superuser session passed and a callback could
`RESET ROLE` back to it.

Repair:

- `src/lib/db/pool.ts` separates the credentials. `ALIA_DB_REQUEST_URL` is the dedicated least-privileged
  request login and is required by `readDbConfig()`; `DATABASE_URL` is the migration/administrative
  connection and is read only by `readAdminDbConfig()`, `npm run db:migrate`, and the test harness.
  Validation refuses a privileged login name, a connection string with no login role, a login equal to
  `ALIA_DB_APP_ROLE`, and any reuse of the administrative connection (same string or same login).
- `src/lib/db/tenant.ts` verifies the live session instead of trusting the URL: `current_user` must be the
  configured application role, `is_superuser` must be `off`, and the login behind the session (`session_user`)
  must not be a superuser, must not hold `BYPASSRLS`, must own no relation, and must not be a member of a
  privileged role. The same probe verifies that the claim and the selected organization really are the
  values intended for the request. It runs before the work **and again immediately before commit**, so a
  callback that left the restricted role or rewrote the settings the policies read cannot commit.
- `src/config/env.ts`, `.env.example`, `docs/DEVELOPMENT.md`, `README.md`, and
  `coordination/DECISIONS.md` (ADR-010, ADR-011) now describe the credential split and the binding instead
  of the rejected behaviour.

### Regression evidence (fails on the reviewed revision, passes after the fix)

With the reviewed revision's `supabase/migrations/0001_foundation.sql` and `src/lib/db/tenant.ts` restored in
the working tree (the new suites and harness unchanged), `npx vitest run tests/integration/rls
tests/integration/db` fails 10 cases in 3 files:

- `exposes only the selected organization to a principal that belongs to two` - 22 rows of the other
  organization leaked through unfiltered reads.
- `denies every CRUD operation and resource-by-id access against the other organization` - leaked rows.
- `limits a non-administrator own membership rows to the selected organization` - leaked rows.
- `fails closed when the selected organization is missing or forged` - 33 leaked rows.
- `fixes the search_path of every helper and revokes PUBLIC execute` - helper inventory changed.
- `binds every tenant access helper to the transaction-local selected organization` -
  `has_workspace_access must require the selected organization`.
- `refuses the administrative connection on the request path even with the restricted role configured` -
  the promise resolved instead of rejecting: the superuser session passed the old check.
- `refuses a privileged login even when the configured application role name is the restricted one` -
  resolved instead of rejecting.
- `refuses to commit a transaction whose callback left the restricted role` - the escaped `INSERT` resolved
  instead of rejecting.
- `refuses a transaction whose callback rewrote the selected organization` - resolved instead of rejecting.

Restoring the reviewed revision's `src/lib/db/pool.ts` as well fails 6 cases in
`tests/integration/db/credential-split.test.ts` alone, including `loginRoleOf is not a function` and
`Missing server configuration: DATABASE_URL`: the reviewed revision had no separate request credential at
all.

## ALIA-002 evidence

Artifacts: `supabase/migrations/0001_foundation.sql`, `0002_learning_data.sql`,
`0003_governed_memory_and_controls.sql`, `scripts/migrate.ts`, `src/lib/db/migrations.ts`,
`src/lib/db/pool.ts`, `src/lib/db/tenant.ts`, `src/modules/identity/{roles,jwt,principal}.ts`,
`tests/support/*`, `tests/global-setup.ts`.

Commands run in the repository root on Node 24.14.1 / npm 11.11.0 (repair revision):

- `npm run verify` (lint, typecheck, `vitest run`, `next build`) -> exit 0.
  - `npm run lint` (`eslint .`) -> exit 0, no findings.
  - `npm run typecheck` (`tsc --noEmit`) -> exit 0, no findings.
  - `npm test` (`vitest run`) -> 16 files passed, 162 tests passed, 0 failed (137 before this repair).
    One PostgreSQL 18.4 instance is started once per run by `tests/global-setup.ts`.
  - `npm run build` (`next build`) -> compiled successfully; routes `/` (static), `/_not-found` (static),
    `/api/v1/health` (dynamic).
- `npm run db:migrate` with no `DATABASE_URL` set -> exit 1, `DATABASE_URL is not set. Nothing was applied.`
  (re-run for this repair). The migration-file set is unchanged by the repair (the same three files, in the
  same order, with the reviewed revision's ledger checksums untouched at the database level), and
  `tests/integration/db/migrations.test.ts` applies all three to fresh scratch databases in order twice for
  every run, which is the "from a clean database" evidence. The reviewed revision's recorded output for a
  real database (`done: 3 applied, 0 already present`, then `0 applied, 3 already present`) was not re-taken
  in this repair because the repair changes no migration file name, order, or ledger interaction; the only
  change to an applied file is the helper/policy body inside `0001_foundation.sql`, and the checksum ledger
  intentionally refuses a database where that file was already applied.

Suites for this task (current counts):

- `tests/integration/rls/isolation.test.ts` (30 tests): two organizations, a principal that belongs to both,
  a one-owner individual workspace, and a principal with no membership. Every request-path statement runs as
  the restricted `alia_app` role with a transaction-local claim *and* the transaction-local selected
  organization, inside a transaction that is rolled back; denied writes are additionally counted on the
  privileged connection, so "no rows changed" is proved rather than assumed. Six cases are the
  selected-organization binding regressions: unfiltered reads in both directions, CRUD and resource-by-id
  denial against the other organization, tenant-key reassignment, cross-tenant attachment, the own-row
  membership limit, and fail-closed behaviour with a missing or forged selection.
- `tests/integration/rls/schema-invariants.test.ts` (12 tests): the machine-checked form of the AGENTS.md
  invariants - forced RLS, explicit policy presence, no blanket-permissive policy, append-only tables, role
  attributes, helper `search_path` and grants, the tenant-consistency foreign keys, and the requirement that
  every workspace helper is bound to the selected organization.
- `tests/integration/db/credential-split.test.ts` (8 tests, new): the request and administrative credentials
  are separate; the administrative connection is refused on the request path even when `ALIA_DB_APP_ROLE` is
  the restricted role, while the dedicated login is accepted; after `RESET ROLE` the session has no
  `BYPASSRLS`, no superuser attribute, and still reads nothing cross-tenant; a transaction that left the
  restricted role, or rewrote the selected organization, cannot commit.
- `tests/integration/identity/principal.test.ts` (16 tests): token verification, membership resolution, the
  tenant transaction, and typed error mapping through the real request path.
- `tests/integration/db/migrations.test.ts` (6 tests): clean-database application, idempotency, checksum
  drift, unknown applied version, full rollback of a failing migration, and the filename contract.
- Unit suites: `tests/unit/db-pool.test.ts` (18), `db-tenant-errors.test.ts` (6), `db-env.test.ts` (5),
  `identity-jwt.test.ts` (13), `identity-principal.test.ts` (12).

### RLS evidence (acceptance criteria)

| Acceptance criterion | Evidence |
| --- | --- |
| Normal request paths do not use a service-role bypass | `alia_app` is NOLOGIN, NOSUPERUSER, NOBYPASSRLS and owns no table (asserted in `schema-invariants.test.ts`). Every tenant transaction enters it with `set local role` and then verifies `current_user = alia_app`, `is_superuser = off`, and that the login behind the session is not a superuser, holds no `BYPASSRLS`, owns no relation, and is a member of no privileged role - before the work and again before commit. The request credential is `ALIA_DB_REQUEST_URL`, never the administrative `DATABASE_URL`; a privileged configured role or login is refused with `CONFIGURATION_ERROR`, and `tests/integration/db/credential-split.test.ts` proves the administrative connection is refused while the dedicated login succeeds. |
| Organization A cannot perform any CRUD operation on organization B rows | For all eleven tenant tables: 0 rows visible across organizations, every cross-organization insert refused (`42501`), every cross-organization update and delete affecting 0 rows with privileged counts unchanged, and a row cannot be moved into another organization (`42501`). |
| Membership in two organizations does not widen access | With the same principal resolved to A and then to B: unfiltered reads expose only the selected organization in every table, CRUD and resource-by-id access against the other organization is denied in both directions, tenant-key reassignment is refused (`42501`), a cross-tenant attachment is refused (`23503`), and a missing, forged, or foreign selection yields 0 rows and refuses writes. |
| Suspended membership loses access | Suspended and removed memberships resolve to no active membership (`FORBIDDEN`) and read 0 rows through the request path; a suspended principal still sees only its own membership row. |
| Individual workspaces cannot create or read organization-shared memory | The insert is refused by the RLS policy (`42501`) and by the composite foreign key `(organization_id, account_type) -> organizations(id, account_type)` even on a privileged connection (`23503`); reads return 0 rows. An organization that already holds shared memory cannot be converted into an individual workspace. |
| Migration and isolation tests pass from a clean database | `tests/integration/db/migrations.test.ts` creates fresh scratch databases and applies all three migrations in order, twice; CI applies the migrations to a clean Postgres service container before running the suites. |

Additional RLS evidence: append-only tables (learning events, decisions, usage, audit) have no update or
delete policy and no such grant is reachable; a viewer cannot read or write learner evidence while its own
audit append succeeds and cannot be attributed to another principal; organization memory approval is
owner/admin only; only approved, unexpired memory is visible to a retrieval path; the migration ledger is
unreadable by `alia_app` (`42501`); a session with no claim reads 0 rows everywhere and cannot insert; a
session with no selected organization can read only its own membership rows.

Cost and privacy impact: no model call, no queue, and no paid infrastructure were added. `pg` and `jose` are
free runtime dependencies. Shared memory stores only a normalized signature, an approved intervention, and
non-identifying provenance columns; learner references are pseudonymous and email-shaped or
whitespace-bearing values are rejected by check constraints. The repair adds two catalogue probes per
request transaction (a handful of indexed reads inside the same transaction, no extra round trip beyond one
statement) and no new service. No child data, credential, or raw transcript was introduced.
`embedded-postgres` is a pinned, test-only devDependency (see remaining risk).

## ALIA-001 evidence

Commands run in the repository root on Node 24.14.1 / npm 11.11.0:

- `npm run lint` (`eslint .`) -> exit 0, no findings.
- `npm run typecheck` (`tsc --noEmit`) -> exit 0, no findings.
- `npm test` (`vitest run`) -> 6 files passed, 36 tests passed, 0 failed.
- `npm run build` (`next build`) -> compiled successfully; routes `/` (static), `/_not-found` (static),
  `/api/v1/health` (dynamic).
- Live smoke test on the production build: `curl -i http://localhost:3000/api/v1/health` -> `HTTP/1.1 200`
  with the typed body, a generated `alia_<uuid>` trace id when none was supplied, `405` for `POST`, and
  `200` for `/`.
- Coordinator review repair (2026-09-24): an unvalidated environment value is never echoed (fixed
  `unknown` label), `jsonResponse` applies protected headers last so a caller cannot replace or duplicate
  them, and `docs/DEVELOPMENT.md` now matches implemented behaviour. Two live smoke tests on the
  production build proved a hostile environment value appears in neither the body nor the headers.

ALIA-001 RLS evidence: not applicable; that task introduced no table, policy, or data access path.

## Blockers

None. No production deployment, production database migration, secret change, billing change, or
destructive action is requested or authorized.

## Remaining risk

- No environment yet sets `ALIA_DB_REQUEST_URL`; until one does, a request path fails closed with
  `CONFIGURATION_ERROR` rather than falling back to `DATABASE_URL`. That is deliberate, and it means the
  first staging deployment must provision the dedicated login (a login role that is a member of `alia_app`,
  with no superuser, no `BYPASSRLS`, and no table ownership).
- ALIA-002 protects partner-backend principals (owner, admin, educator, viewer) and one-owner individual
  workspaces. A learner-scoped principal and a server-to-server client credential flow are not implemented;
  the partner backend is the only caller, so learner-private rows are role-scoped inside one organization.
- Membership rows are the one table a principal can read without a selected organization, limited to its own
  rows. That exception is what makes pre-selection resolution possible; it is asserted in the isolation suite
  and in `schema-invariants.test.ts` so it cannot widen silently.
- `alia_app` and the claim contract are ALIA's own; they are Supabase-compatible (Supabase's
  `authenticated` + `request.jwt.claim.*`) but have not yet been exercised against a live Supabase stack.
  The JWT path assumes the legacy HS256 symmetric secret; asymmetric signing keys are not supported yet, and
  a privileged role claim (`service_role`, `anon`, `supabase_admin`) is refused.
- Organization and membership lifecycle writes are not exposed to any request path: organizations have no
  insert/update/delete policy and rosters require an organization admin. Creating a workspace is currently an
  administrative database operation.
- `learning_events`, `decisions`, `model_usage`, and `audit_events` are append-only by design; retention and
  deletion workflows arrive with the deletion task in ALIA-007.
- `embedded-postgres` is pinned to the exact prerelease `18.4.0-beta.17` and is test-only. CI uses the
  official `postgres:18` service container instead, so the deployed service does not depend on it. In CI the
  harness's administrative connection is the service container's superuser; the request login it creates is
  unprivileged, which is the shape the guards are proved against.
- The RLS suites run serially (`fileParallelism: false`) because they share one database.
- No rate limiting, no trace export, and no structured log sink exist yet.
- `npm run lint` resolves `eslint` to ^9 because ESLint 10 currently breaks `eslint-config-next` 16
  (`scopeManager.addGlobals is not a function`). Revisit when the Next.js config supports ESLint 10.
- On this machine Next.js logs a root-inference warning because a `package-lock.json` exists in
  `C:\Users\USER`, outside the repository. It is environmental and does not affect CI.

## Quality gate

No production deployment, production database migration, secret change, billing change, or destructive
action is authorized. Non-production pull requests may be merged automatically only under the gates in
AGENTS.md.

## Handoff format

Every task pull request must record:

- task ID and acceptance criteria;
- changed files and architecture impact;
- tests and their exact results;
- RLS evidence when data access changed;
- cost and privacy impact;
- known limitations;
- next ready task.
