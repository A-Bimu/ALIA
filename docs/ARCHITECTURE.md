# ALIA technical architecture

## Alpha shape

Build a modular monolith first:

- Next.js with TypeScript for the API, thin pilot console, and orchestration;
- Supabase Auth and PostgreSQL for identity, RLS, data, audit, and initial cache metadata;
- a provider adapter for controlled Meta Llama access;
- deterministic learner-state and policy modules inside the application;
- Vitest for unit and integration coverage, plus focused end-to-end smoke tests;
- Vercel and Supabase for a staging deployment only after explicit approval.

This shape reduces moving parts and cost while keeping module boundaries extractable later.

## Request path

1. Authenticate the principal.
2. Resolve active membership and organization from trusted claims or server-side lookup.
3. Validate request schema and organization-scoped idempotency.
4. Run RLS-protected database operations.
5. Update or read deterministic learner state.
6. Apply safety and curriculum policy.
7. Search approved organization memory, then bounded cache.
8. Call the configured model only when earlier stages cannot satisfy the request.
9. Validate the response.
10. Write decision, usage, cost estimate, and audit records.
11. Return a versioned response with a trace ID.

## Module boundaries

- auth: principal, membership, role, organization resolution;
- events: validation, idempotency, ingestion;
- learner-model: evidence weighting, mastery, confidence, misconception rules;
- memory-private: learner-specific state and intervention history;
- memory-organization: candidate creation, approval, retrieval, expiry;
- policy: age-aware safety, curriculum grounding, escalation;
- routing: memory, cache, small-model, strong-model decision;
- providers: replaceable language-model adapters;
- decisions: next-action selection and explanation;
- usage: budgets, limits, cost estimates, circuit breaker;
- audit: privacy-safe traces and administration events;
- sdk: versioned TypeScript client contract.

Modules communicate through typed interfaces. Provider-specific payloads do not leak into domain modules.

## Trust boundaries

Partner backends call ALIA. Child-facing clients must not call unrestricted model providers or hold ALIA provider credentials. For the alpha, authenticated Supabase principals and memberships protect routes. A later server-to-server client credential flow must map credentials to exactly one organization and use a scoped principal; it must not turn ordinary requests into unrestricted service-role operations.

The service role is limited to named administrative background jobs. Each use requires a wrapper, an audit event, and a test showing it cannot be reached from a public route.

## Tenancy model

The organizations table is the isolation root. The account_type field distinguishes a multi-member organization from a one-owner individual workspace. Both receive RLS isolation. A database constraint or trigger prevents organization-memory rows for individual workspaces.

All tenant foreign keys include organization_id. Policies use active membership helper functions designed to avoid recursive RLS. Security-definer helpers, if necessary, must have a fixed search_path, minimal execute grants, and tests.

### Request transaction and tenant role

A partner request resolves its principal as follows: verify the bearer token, then read
the principal's active membership row. Both steps happen inside one transaction that has
already entered the restricted `alia_app` role and published the verified claim as a
transaction-local `request.jwt.claim.sub`, so the memberships policy itself is the
boundary. A client-supplied organization identifier is refused rather than trusted.

`alia_app` is NOLOGIN, has no superuser, no BYPASSRLS, and owns nothing; a scoped login
role enters it with `set local role`. Every tenant transaction re-verifies that the live
session is neither a superuser nor BYPASSRLS before running a statement, and a
privileged role name is refused as configuration. The service role therefore cannot be
reached from a partner request path at all, which is what AGENTS.md requires.

Tenant-consistent composite foreign keys (`(organization_id, learner_id)` to
`learners(organization_id, id)`, and `(organization_id, account_type)` to
`organizations(id, account_type)` for organization memory) make a cross-tenant or
shared-memory-in-an-individual-workspace row unrepresentable, independent of policy.

## Memory lifecycle

Candidate -> pending review -> approved -> active use -> expired or retired.

Only active approved rows are retrieved. Raw learner work stays in protected learning evidence and is not copied into shared memory. The stored organization artifact is a generalized signature plus an approved intervention. Updating an artifact creates a new version and invalidates dependent cache keys.

## Cost and resilience

The router emits a reason code for every stage. Exact approved-memory hits return without a model call. Cache keys include organization, curriculum version, skill, normalized need, policy version, and memory version, but no direct learner identifier.

PostgreSQL is the initial durable system. Use an outbox table with skip-locked workers for asynchronous work if needed. Add a dedicated queue, Redis, or vector service only after metrics show a bottleneck.

Budgets are enforced before provider calls. When the provider circuit is open, ALIA returns deterministic guidance or a typed temporarily-unavailable result. Partner products keep their own non-ALIA fallback.

## Later evolution

After pilot evidence:

- move PyTorch experiments into an offline learner-model service;
- add evaluated embeddings if lexical retrieval is insufficient;
- add a durable external queue if the PostgreSQL outbox becomes a bottleneck;
- introduce scoped OAuth client credentials for partner backends;
- separate high-throughput modules only when measurements justify it.
