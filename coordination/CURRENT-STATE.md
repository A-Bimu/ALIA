# Current build state

Updated: 2026-09-24 (ALIA-002 tenant identity, schema, and RLS proof)

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
  organization resolution from verified membership, role checks, and a real-database RLS isolation proof.

## Active

- Next task: ALIA-003, Learning-event and mastery loop (now ready; depends on ALIA-002, completed).
- Owner: Hermes implementation worker.
- Reviewer/coordinator: Codex GitHub task.
- Open pull request: this task's pull request for `hermes/ALIA-002-tenant-identity-rls` (draft until CI is
  green). No other task is claimed.

## ALIA-002 evidence

Artifacts: `supabase/migrations/0001_foundation.sql`, `0002_learning_data.sql`,
`0003_governed_memory_and_controls.sql`, `scripts/migrate.ts`, `src/lib/db/migrations.ts`,
`src/lib/db/pool.ts`, `src/lib/db/tenant.ts`, `src/modules/identity/{roles,jwt,principal}.ts`,
`tests/support/*`, `tests/global-setup.ts`.

Commands run in the repository root on Node 24.14.1 / npm 11.11.0:

- `npm run verify` (lint, typecheck, `vitest run`, `next build`) -> exit 0.
  - `npm run lint` (`eslint .`) -> exit 0, no findings.
  - `npm run typecheck` (`tsc --noEmit`) -> exit 0, no findings.
  - `npm test` (`vitest run`) -> 15 files passed, 137 tests passed, 0 failed (36 pre-existing ALIA-001
    tests plus 101 new). One PostgreSQL 18.4 instance is started once per run by
    `tests/global-setup.ts`.
  - `npm run build` (`next build`) -> compiled successfully; routes `/` (static), `/_not-found` (static),
    `/api/v1/health` (dynamic).
- `npm run db:migrate` against a real PostgreSQL 18.4 started by the local harness:
  - without `DATABASE_URL` -> exit 1, `DATABASE_URL is not set. Nothing was applied.`
  - first run -> `applied 0001_foundation.sql`, `applied 0002_learning_data.sql`,
    `applied 0003_governed_memory_and_controls.sql`, `done: 3 applied, 0 already present`.
  - second run -> `done: 0 applied, 3 already present`.

Suites added for this task:

- `tests/integration/rls/isolation.test.ts` (24 tests): two organizations, a one-owner individual workspace, and a
  principal with no membership. Every request-path statement runs as the restricted `alia_app` role with a
  transaction-local claim, inside a transaction that is rolled back; denied writes are additionally counted
  on the privileged connection, so "no rows changed" is proved rather than assumed.
- `tests/integration/rls/schema-invariants.test.ts` (11 tests): the machine-checked form of the AGENTS.md
  invariants — forced RLS, explicit policy presence, no blanket-permissive policy, append-only tables, role
  attributes, helper search_path and grants, and the tenant-consistency foreign keys.
- `tests/integration/identity/principal.test.ts`: token verification, membership resolution, the tenant
  transaction, and typed error mapping through the real request path.
- `tests/integration/db/migrations.test.ts`: clean-database application, idempotency, checksum drift,
  unknown applied version, full rollback of a failing migration, and the filename contract.
- Unit suites: `tests/unit/db-pool.test.ts`, `db-tenant-errors.test.ts`, `db-env.test.ts`,
  `identity-jwt.test.ts`, `identity-principal.test.ts`.

### RLS evidence (acceptance criteria)

| Acceptance criterion | Evidence |
| --- | --- |
| Normal request paths do not use a service-role bypass | `alia_app` is NOLOGIN, NOSUPERUSER, NOBYPASSRLS and owns no table (asserted in `schema-invariants.test.ts`). Every tenant transaction enters it with `set local role` and then asserts `current_user = alia_app`, `is_superuser = off`, `rolbypassrls = false`; a privileged configured role is refused with `CONFIGURATION_ERROR` before any statement runs. The identity suite asserts `current_user = alia_app` and `is_superuser = off` inside a real request transaction. |
| Organization A cannot perform any CRUD operation on organization B rows | For all eleven tenant tables: 0 rows visible across organizations, every cross-organization insert refused (`42501`), every cross-organization update and delete affecting 0 rows with privileged counts unchanged, and a row cannot be moved into another organization (`42501`). |
| Suspended membership loses access | Suspended and removed memberships resolve to no active membership (`FORBIDDEN`) and read 0 rows through the request path; a suspended principal still sees only its own membership row. |
| Individual workspaces cannot create or read organization-shared memory | The insert is refused by the RLS policy (`42501`) and by the composite foreign key `(organization_id, account_type) -> organizations(id, account_type)` even on a privileged connection (`23503`); reads return 0 rows. An organization that already holds shared memory cannot be converted into an individual workspace. |
| Migration and isolation tests pass from a clean database | `tests/integration/db/migrations.test.ts` creates fresh scratch databases and applies all three migrations in order, twice; CI applies the migrations to a clean Postgres service container before running the suites. |

Additional RLS evidence: append-only tables (learning events, decisions, usage, audit) have no update or
delete policy and no such grant is reachable; a viewer cannot read or write learner evidence while its own
audit append succeeds and cannot be attributed to another principal; organization memory approval is
owner/admin only; only approved, unexpired memory is visible to a retrieval path; the migration ledger is
unreadable by `alia_app` (`42501`); a session with no claim reads 0 rows everywhere and cannot insert.

Cost and privacy impact: no model call, no queue, and no paid infrastructure were added. `pg` and `jose` are
free runtime dependencies. Shared memory stores only a normalized signature, an approved intervention, and
non-identifying provenance columns; learner references are pseudonymous and email-shaped or
whitespace-bearing values are rejected by check constraints. No child data, credential, or raw transcript
was introduced. `embedded-postgres` is a pinned, test-only devDependency (see remaining risk).

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

- ALIA-002 protects partner-backend principals (owner, admin, educator, viewer) and one-owner individual
  workspaces. A learner-scoped principal and a server-to-server client credential flow are not implemented;
  the partner backend is the only caller, so learner-private rows are role-scoped inside one organization.
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
  official `postgres:18` service container instead, so the deployed service does not depend on it.
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
