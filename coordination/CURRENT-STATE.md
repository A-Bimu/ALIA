# Current build state

Updated: 2026-09-24 (ALIA-001 review repair)

## Release

Founding-Pilot Alpha with a seven-day target. This is not an error-free or full-production claim.

## Completed

- Independent A-Bimu/ALIA repository created.
- Product boundary, security invariants, architecture, cost controls, and phased task queue defined.
- GitHub coordination and Hermes worker files initialized.
- CI governance checks initialized.
- ALIA-001, Foundation and executable contract: TypeScript modular monolith scaffold, typed environment
  validation with a secret-free `.env.example`, structured error contract, trace IDs, `GET /api/v1/health`,
  lint/typecheck/test/build scripts, and a Vitest harness. Branch `hermes/ALIA-001-foundation-contract`.

## Active

- Next task: ALIA-002, Tenant identity, schema, and RLS proof (now ready; depends on ALIA-001, completed).
- Owner: Hermes implementation worker.
- Reviewer/coordinator: Codex GitHub task.
- Open pull request: #1 `hermes/ALIA-001-foundation-contract` (draft; the coordinator review repair was
  pushed on 2026-09-24 and is awaiting re-review). ALIA-002 work starts only after that pull request is
  reviewed; no other task is claimed.

## ALIA-001 evidence

Commands run in the repository root on Node 24.14.1 / npm 11.11.0:

- `npm run lint` (`eslint .`) -> exit 0, no findings.
- `npm run typecheck` (`tsc --noEmit`) -> exit 0, no findings.
- `npm test` (`vitest run`) -> 6 files passed, 36 tests passed, 0 failed.
- `npm run build` (`next build`) -> compiled successfully; routes `/` (static), `/_not-found` (static),
  `/api/v1/health` (dynamic).
- Live smoke test on the production build: `npm run build && npm start`, then
  `curl -i http://localhost:3000/api/v1/health` -> `HTTP/1.1 200`, body
  `{"status":"ok","service":"alia","api_version":"v1","environment":"local","version":"0.1.0",
  "uptime_seconds":36,"timestamp":"2026-09-23T18:54:36.376Z","trace_id":"partner-smoke-0001",
  "checks":{"config":"ok"},"pending_configuration":[]}`. A request without a trace header received a
  generated `alia_<uuid>`; `x-trace-id: short` was replaced; `POST` returned 405; `/` returned 200.

Test suites:

- `tests/unit/env.test.ts`: defaults parse without credentials; empty string treated as unset; numeric
  coercion and rejection of non-positive limits; unknown log level and malformed URL rejected; a typed
  `CONFIGURATION_ERROR` is thrown while the offending value never appears in the message; the
  non-throwing inspector reports key names only; the public environment label comes from a validated
  value only; Supabase server config fails closed; the public slice is allowlisted, frozen, and
  secret-free.
- `tests/unit/trace.test.ts`: 50 generated IDs are unique and well-formed; a safe inbound ID is honoured;
  empty, short, spaced, control-character, oversized, underscore-led, and non-ASCII values are rejected
  and replaced.
- `tests/unit/errors.test.ts`: stable status mapping; typed body for known errors; internal and
  configuration messages, details, and stacks are withheld; unknown thrown values degrade without
  leaking; the log-safe projection contains no message, payload, or cause.
- `tests/unit/http.test.ts`: the response invariants hold by default; a caller status is honoured; an
  unprotected caller header is preserved; caller attempts to override `content-type`, `cache-control`,
  `x-content-type-options`, or `x-trace-id` are refused, including mixed-case names, and no protected
  header is duplicated.
- `tests/unit/health-report.test.ts`: healthy with a bare environment; degraded with invalid
  configuration by key name only; declared environment reported without echoing other values; an invalid
  environment value is never echoed (fixed `unknown` label); the fixed label is used whenever any other
  configuration value is invalid.
- `tests/integration/health.test.ts`: the real route handler returns 200 with the typed schema,
  `no-store`, and `nosniff`; a safe inbound trace id is echoed in the header and the body; an unsafe one
  is replaced; no protected header is duplicated; stubbed Supabase and provider credentials never appear
  in the body or headers; a hostile invalid `ALIA_ENV` is absent from the body and the headers and is
  reported as `unknown`; incomplete configuration is reported by key name only.

RLS evidence: not applicable. ALIA-001 introduces no table, policy, or data access path. No database
credential, service-role key, or tenant row exists in the codebase, and `pending_configuration` exposes
key names only.

Cost and privacy impact: no model call, no queue, no cache, and no paid infrastructure were added.
`/health` returns service identity and timing only; configuration values are validated and never
returned; error responses withhold internal messages; the log-safe error projection carries no message
or payload.

## ALIA-001 coordinator review repair (2026-09-24)

Pull request #1 received three blocking review findings. All three are fixed inside ALIA-001 scope:

1. Public health response could echo an unvalidated environment value. `inspectEnv` now returns an
   `environment` label taken from the successfully parsed schema and the fixed sentinel
   `UNKNOWN_ENVIRONMENT_LABEL` (`unknown`) when validation fails; `buildHealthReport` uses that label
   instead of reading `source.ALIA_ENV`. Unit tests (`tests/unit/env.test.ts`,
   `tests/unit/health-report.test.ts`) and a route-level test (`tests/integration/health.test.ts`) prove
   a hostile value is absent from both the body and the headers.
2. `jsonResponse` applied caller headers after the mandatory ones, so a caller could defeat
   `content-type`, `cache-control`, `x-content-type-options`, and `x-trace-id`. The helper now sets
   caller headers first and the protected headers last through `Headers.set`, which replaces entries
   case-insensitively; the protected names are exported as `PROTECTED_RESPONSE_HEADERS`.
   `tests/unit/http.test.ts` proves an override attempt cannot replace or duplicate them.
3. `docs/DEVELOPMENT.md` now matches implemented behavior: optional Supabase and provider values being
   absent does not degrade the service (`checks.config = "ok"`, empty `pending_configuration`), and
   `checks.config = "incomplete"` appears only when a supplied value fails validation. A short
   "Response invariants" section documents the protected headers.

Verification after the repair (repository root, Node 24.14.1 / npm 11.11.0):

- `npm run lint` (`eslint .`) -> exit 0, no findings.
- `npm run typecheck` (`tsc --noEmit`) -> exit 0, no findings.
- `npm test` (`vitest run`) -> 6 files passed, 36 tests passed, 0 failed.
- `npm run build` (`next build`) -> compiled successfully; `/` (static), `/_not-found` (static),
  `/api/v1/health` (dynamic).
- Live production-build smoke test with an invalid `ALIA_ENV` value shaped like a database connection
  string (fake user and password segments, no real credential) on port 3101: `HTTP/1.1 200`, body
  `{"status":"degraded","service":"alia","api_version":"v1","environment":"unknown","version":"0.1.0",
  "uptime_seconds":94,"timestamp":"2026-09-24T11:18:35.118Z",
  "trace_id":"alia_ec5ffdc2-c143-4d29-abff-7dbebdc87fdb","checks":{"config":"incomplete"},
  "pending_configuration":["ALIA_ENV"]}`. The invalid value and its password segment appear in neither
  the body nor the headers, and the headers carried exactly one `cache-control: no-store`, one
  `x-content-type-options: nosniff`, and one `x-trace-id`.
- Live production-build smoke test with a bare environment on port 3102: `HTTP/1.1 200`, body
  `{"status":"ok","service":"alia","api_version":"v1","environment":"local","version":"0.1.0",
  "uptime_seconds":32,"timestamp":"2026-09-24T11:18:13.441Z",
  "trace_id":"alia_5245a52f-29ff-4958-bda5-1cf2e18bb6b7","checks":{"config":"ok"},
  "pending_configuration":[]}`.

## Blockers

None. The Hermes scheduled worker is installed on its Windows host and the ALIA-001 run completed; pull
request #1 is open and awaiting coordinator re-review. No production deployment, production database
migration, secret change, billing change, or destructive action is requested or authorized.

## Remaining risk

- The scaffold does not yet authenticate anything. Every future route must resolve tenant identity from
  trusted membership before it is reachable; `/api/v1/health` is deliberately the only route.
- The public `environment` label fails closed: if any configuration value is invalid, the label is
  `unknown` even when `ALIA_ENV` itself is valid. This is intentional; the operator sees the offending
  key name in `pending_configuration`.
- `npm run lint` resolves `eslint` to ^9 because ESLint 10 currently breaks `eslint-config-next` 16
  (`scopeManager.addGlobals is not a function`). Revisit when the Next.js config supports ESLint 10.
- On this machine Next.js logs a root-inference warning because a `package-lock.json` exists in
  `C:\Users\USER`, outside the repository. It is environmental and does not affect CI.
- No rate limiting, no trace export, and no structured log sink exist yet.

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
