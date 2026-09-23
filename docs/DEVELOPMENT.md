# Local development

ALIA is a TypeScript modular monolith (Next.js App Router) with Supabase as the
planned PostgreSQL/Auth layer. This document covers local setup, the command set,
and the boundaries that apply while working on it.

## Requirements

- Node.js 22 or newer (`node --version`);
- npm 10 or newer (`npm --version`);
- git.

Nothing else is required for the alpha foundation: no database, no provider key,
no paid infrastructure.

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
| `npm test` | Vitest unit and integration suites |
| `npm run test:watch` | Vitest in watch mode |
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

Missing Supabase configuration is expected until the identity task lands; the
health endpoint reports it as `checks.config = "incomplete"` and lists the key
names in `pending_configuration`.

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
