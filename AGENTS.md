# ALIA agent operating rules

These instructions apply to every automated or human contributor in this repository.

## Product boundary

Adaptive Learning Intelligence Agent is an independent API/SDK intelligence layer. Eureka Learn and KidyCode are independent integration environments. Do not move their curriculum, product identity, authentication, or learner-facing UX into ALIA.

ALIA owns:

- pseudonymous learning-event ingestion;
- learner state and mastery estimation;
- misconception detection;
- next-action and intervention decisions;
- tutoring strategy and grounded response generation;
- private learner memory;
- approved organization solution memory;
- cost, safety, and decision audit logs.

## Source of truth and work protocol

1. Read README.md, docs/ALIA-V1-SPEC.md, docs/ARCHITECTURE.md, coordination/TASK-QUEUE.json, and coordination/CURRENT-STATE.md before editing.
2. GitHub main is the source of truth. Fetch and fast-forward before selecting work.
3. Work on exactly one ready task at a time.
4. Use a branch named hermes/<task-id>-<short-slug>.
5. Do not expand scope beyond that task's acceptance criteria.
6. Preserve unrelated work and never rewrite shared history.
7. Run all relevant tests, lint, type checks, builds, migration checks, and RLS isolation tests.
8. When all gates pass, update the task to completed and release only the next task whose dependencies are all completed. Make those queue changes in the same pull request.
9. Update coordination/CURRENT-STATE.md with evidence, remaining risk, and the exact next action.
10. Push the branch and open or update a pull request. Never push task code directly to main.

## Security invariants

- Every tenant-owned table enables and forces Row Level Security.
- Organization access is membership-based and deny-by-default.
- Organization identity is derived from authenticated membership. Never trust an organization identifier supplied in a request body.
- Individual workspaces use the same isolation boundary, but organization-shared memory is forbidden for them at the database layer.
- Private learner memory is never readable by another learner.
- Organization solution memory stores generalized mistake signatures and approved solutions, not raw learner chat or direct identifiers.
- Only approved, active organization memory may be retrieved.
- A browser never receives a service-role key, provider secret, or unrestricted database credential.
- The service role is not used for normal learner or organization requests.
- Never weaken RLS to make a test pass.
- Never commit secrets, tokens, production exports, child personal data, or raw model transcripts.
- Use pseudonymous learner identifiers and minimum necessary evidence.
- Destructive production changes, production migrations, secret rotation, billing changes, and data deletion require explicit human approval.

## Cost invariants

Use the cheapest safe path in this order:

1. schema validation and deterministic policy;
2. exact approved-memory match;
3. cache;
4. low-cost retrieval;
5. small configured language model;
6. stronger model only when confidence, safety, or complexity requires it.

Every model call must record organization, trace, route reason, token counts when available, estimated cost, latency, and outcome. Enforce per-request token limits, per-organization budgets, duplicate suppression, timeouts, retries with jitter, and a circuit breaker. Do not add paid infrastructure when PostgreSQL can safely carry the alpha workload.

## Merge authority

The Codex coordinator may merge a non-production alpha pull request without user input only when:

- the task scope and acceptance criteria are satisfied;
- CI and all relevant tests pass;
- no unresolved review thread or known security issue remains;
- RLS tests prove cross-organization denial when data access changed;
- the change does not deploy production, change secrets or billing, delete data, or weaken a safety boundary;
- the task queue and current state are correctly advanced.

Otherwise, request changes or record a blocker. Never bypass failed checks.

## Stop conditions

Stop, document the blocker in coordination/CURRENT-STATE.md, and request human input only for:

- missing or invalid credentials;
- billing or paid-plan approval;
- an irreversible or destructive action;
- a production deploy or production migration;
- a legal, privacy, or safeguarding decision not covered by the specification;
- conflicting requirements that materially change product behavior.

Do not stop for ordinary lint, type, test, merge-conflict, or implementation failures. Diagnose, fix, and rerun within the task scope.
