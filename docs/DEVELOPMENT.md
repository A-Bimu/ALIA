# Local development

ALIA is a TypeScript modular monolith (Next.js App Router) with Supabase as the
planned PostgreSQL/Auth layer. This document covers local setup, the command set,
and the boundaries that apply while working on it.

## Requirements

- Node.js 22 or newer (`node --version`);
- npm 10 or newer (`npm --version`);
- git.

Nothing else is required to start the service: no database, no provider key, no paid
infrastructure. The migration and RLS suites need a real PostgreSQL 18. CI provides
one as a service container; locally the test harness starts one by itself from the
`embedded-postgres` devDependency (no Docker, no administrator rights).

## Setup

~~~bash
git clone https://github.com/A-Bimu/ALIA.git
cd ALIA
npm ci            # or: npm install
cp .env.example .env
~~~

`.env` is ignored by git. `.env.example` never contains a credential, and the
service starts with defaults, so an empty `.env` is enough for the health
endpoint.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local server on http://localhost:3000 |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run lint` | ESLint over the repository |
| `npm run typecheck` | `tsc --noEmit` over src and tests |
| `npm test` | Vitest unit and integration suites (starts a local PostgreSQL for the RLS suites) |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:rls` | Only the migration, RLS isolation, and identity suites |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `npm run verify` | lint, typecheck, test, and build in order |

## Smoke test

~~~bash
npm run build
npm start &
curl -i http://localhost:3000/api/v1/health
~~~

Expected: HTTP 200 with a JSON body that contains `status`, `service`,
`api_version`, `environment`, `version`, `uptime_seconds`, `timestamp`,
`trace_id`, `checks.config`, and `pending_configuration`. No credential, tenant
row, or connection string appears in the response.

## Configuration contract

Configuration is validated by `src/config/env.ts`. Rules:

- a value is read through the typed schema, never ad hoc;
- an invalid value fails closed with a `CONFIGURATION_ERROR`;
- an error names the offending key and never echoes the value;
- only `PUBLIC_ENV_KEYS` may reach a browser, and no public key may look like a
  secret;
- Supabase and provider credentials are server-only. A browser must never receive
  a service-role key, a provider secret, or an unrestricted database credential.

Missing Supabase and provider configuration is expected until the identity task
lands and does not by itself degrade the service: those keys are optional and are
validated only when present. A bare `.env` therefore reports
`checks.config = "ok"` with an empty `pending_configuration`, and
`/api/v1/health` still answers `200`.

`checks.config` becomes `"incomplete"` with `status = "degraded"` and
`pending_configuration` lists the offending key names (never their values) only
when a supplied value fails validation, for example an unknown `ALIA_ENV` or a
malformed `SUPABASE_URL`. The public `environment` field is taken from the
validated schema only; when validation fails it reports the fixed label
`unknown`, so an invalid value is never echoed into a response.

## Database, migrations, and tenancy

The schema lives in `supabase/migrations/` as plain SQL, applied in filename order by
`npm run db:migrate` and recorded in `app.schema_migrations` with a sha256 checksum. A
migration that changed after it was applied is refused, so a shared database cannot
drift silently. Each file runs in its own transaction and rolls back completely on
failure.

~~~bash
export DATABASE_URL="postgres://user:password@host:5432/postgres"
npm run db:migrate
~~~

Rules the code and the database enforce together:

- **Tenant identity comes from membership.** `resolvePrincipal` verifies the bearer
  token (`SUPABASE_JWT_SECRET`), then reads the principal's active membership row
  inside an RLS-scoped transaction. A body or query value named `organization_id`,
  `organizationId`, `org_id`, or `tenant_id` is refused with `VALIDATION_ERROR`.
- **The request path runs as `alia_app`.** `withPrincipalScope` / `withTenant` open one
  transaction, `set local role alia_app`, publish the verified claim as
  `request.jwt.claim.sub`, and then verify the session is not a superuser and does not
  hold `BYPASSRLS`. A privileged role (a service role, a database owner) is refused as
  configuration before any query runs, and the refusal is also checked on the live
  session.
- **RLS is enabled and forced on every tenant table.** Policies are attached to
  `alia_app` only; a table with a missing policy denies by default.
- **Individual workspaces are private-only.** `organization_memory` carries
  `account_type` pinned to `organization` and a composite foreign key to
  `organizations(id, account_type)`, so an organization-shared memory row in a
  one-owner workspace is unrepresentable, and an organization that already has shared
  memory cannot be converted into an individual workspace. The RLS insert policy
  refuses it as well.
- **The migration ledger is not readable by `alia_app`.**

### How the RLS proof runs

`tests/global-setup.ts` starts one PostgreSQL for the whole run, applies the
migrations, and creates a test-only login role that is a member of `alia_app`. Set
`ALIA_TEST_DATABASE_URL` to use an existing database instead (CI points it at the
Postgres service container). The admin connection seeds fixtures and makes privileged
assertions only; every request-path statement runs as `alia_app` with a
transaction-local claim inside a transaction that is rolled back, so denied writes are
proved to have changed nothing.

`tests/integration/rls/schema-invariants.test.ts` also fails the suite if a future
migration adds a tenant table without forced RLS, drops a policy, introduces a
blanket-permissive policy, or hands `alia_app` a privileged attribute.

## Response invariants

`src/lib/http.ts` owns the single JSON response shape. `content-type`,
`cache-control: no-store`, `x-content-type-options: nosniff`, and `x-trace-id`
are protected: they are applied after any caller-supplied headers, so a caller
can neither replace nor duplicate them, including with a differently-cased name.

## Traces and errors

- Every response carries `x-trace-id`. A partner may supply a safe inbound value
  (8-128 characters of `A-Za-z0-9._:-`); anything else is replaced.
- `src/lib/errors.ts` is the only place that maps a failure to an HTTP status.
  Internal and configuration failures return a default message and never the
  original message, stack, or details.
- `toLogSafeError` is the only projection intended for logs: it carries a trace
  id, a code, and an error name. Do not log raw error messages or payloads.

## Boundaries that apply to every change

- Tenant identity comes from authenticated membership, never from a request body.
- Every tenant-owned table enables and forces Row Level Security.
- Deterministic rules, approved memory, and cache precede any paid model call.
- No service-role bypass on a normal request path; no production deploy,
  migration, secret change, or destructive action without explicit human
  approval.
- Curriculum, product identity, and learner-facing UX stay in the partner
  products (Eureka Learn, KidyCode). ALIA owns adaptive intelligence only.
