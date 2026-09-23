# Current build state

Updated: 2026-09-23 (ALIA-001)

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

## ALIA-001 evidence

Commands run in the repository root on Node 24.14.1 / npm 11.11.0:

- `npm run lint` (`eslint .`) -> exit 0, no findings.
- `npm run typecheck` (`tsc --noEmit`) -> exit 0, no findings. Also re-run with `.next` and
  `next-env.d.ts` removed to confirm a clean checkout typechecks without build artifacts.
- `npm test` (`vitest run`) -> 5 files passed, 27 tests passed, 0 failed.
  - `tests/unit/env.test.ts`: defaults parse without credentials; empty string treated as unset; numeric
    coercion and rejection of non-positive limits; unknown log level and malformed URL rejected; a typed
    `CONFIGURATION_ERROR` is thrown while the offending value never appears in the message; the
    non-throwing inspector reports key names only; Supabase server config fails closed; the public slice
    is allowlisted, frozen, and secret-free.
  - `tests/unit/trace.test.ts`: 50 generated IDs are unique and well-formed; a safe inbound ID is honoured;
    empty, short, spaced, control-character, oversized, underscore-led, and non-ASCII values are rejected
    and replaced.
  - `tests/unit/errors.test.ts`: stable status mapping; typed body for known errors; internal and
    configuration messages, details, and stacks are withheld; unknown thrown values degrade without
    leaking; the log-safe projection contains no message, payload, or cause.
  - `tests/unit/health-report.test.ts`: healthy with a bare environment; degraded with invalid
    configuration by key name only; declared environment reported without echoing other values.
  - `tests/integration/health.test.ts`: the real route handler returns 200 with the typed schema,
    `no-store`, and `nosniff`; a safe inbound trace id is echoed in the header and the body; an unsafe one
    is replaced; stubbed Supabase and provider credentials never appear in the body or headers; incomplete
    configuration is reported by key name only.
- `npm run build` (`next build`) -> compiled successfully; routes `/` (static), `/_not-found` (static),
  `/api/v1/health` (dynamic).
- Live smoke test on the production build: `npm run build && npm start`, then
  `curl -i http://localhost:3000/api/v1/health` -> `HTTP/1.1 200`, body
  `{"status":"ok","service":"alia","api_version":"v1","environment":"local","version":"0.1.0",
  "uptime_seconds":36,"timestamp":"2026-09-23T18:54:36.376Z","trace_id":"partner-smoke-0001",
  "checks":{"config":"ok"},"pending_configuration":[]}`. A request without a trace header received a
  generated `alia_<uuid>`; `x-trace-id: short` was replaced; `POST` returned 405; `/` returned 200.

RLS evidence: not applicable. ALIA-001 introduces no table, policy, or data access path. No database
credential, service-role key, or tenant row exists in the codebase, and `pending_configuration` exposes
key names only.

Cost and privacy impact: no model call, no queue, no cache, and no paid infrastructure were added.
`/health` returns service identity and timing only; configuration values are validated and never
returned; error responses withhold internal messages; the log-safe error projection carries no message
or payload.

## Blockers

None. The Hermes scheduled worker still requires its one-time install on the Windows host.

## Remaining risk

- The scaffold does not yet authenticate anything. Every future route must resolve tenant identity from
  trusted membership before it is reachable; `/api/v1/health` is deliberately the only route.
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
