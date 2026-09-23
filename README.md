# ALIA

**Adaptive Learning Intelligence Agent** is an independent B2B/B2B2C adaptive-intelligence service for learning platforms.

Eureka Learn and KidyCode remain independent products. They are ALIA's first integration and validation environments. Partner platforms keep control of curriculum, content, identity, and learner experience. ALIA provides learner modelling, misconception detection, next-action recommendations, tutoring strategy, governed memory, and intervention signals through an API/SDK.

## Current target

This repository is being built toward a **seven-day founding-pilot alpha**, not an unqualified full-production claim. The alpha must demonstrate one secure, observable learning loop:

1. receive a pseudonymous learning event;
2. update learner mastery;
3. detect a likely misconception;
4. retrieve an approved solution when one exists;
5. choose the next learning action;
6. return a grounded tutoring response;
7. record the decision, cost, and outcome.

## Non-negotiable boundaries

- Every tenant-owned row has an organization_id and enforced PostgreSQL Row Level Security.
- Organization memory is available only inside the same organization and only after approval.
- Individual accounts receive private learner memory only. Their mistakes and solutions never become shared cross-user memory.
- Tenant identity comes from verified authentication and membership, never from a client-supplied organization ID.
- Child-facing products send pseudonymous learner IDs and the minimum necessary learning evidence.
- Deterministic rules, retrieval, cache, and approved memory run before paid model generation.
- No service-role key is exposed to a browser.
- No autonomous production deployment, secret change, billing change, migration against production, or destructive data action.

## Repository map

- [Product and security specification](docs/ALIA-V1-SPEC.md)
- [Technical architecture](docs/ARCHITECTURE.md)
- [Agent operating rules](AGENTS.md)
- [Hermes execution prompt](coordination/HERMES-PROMPT.md)
- [Machine-readable task queue](coordination/TASK-QUEUE.json)
- [Current build state](coordination/CURRENT-STATE.md)
- [Architecture decisions](coordination/DECISIONS.md)

## Build workflow

GitHub is the coordination source of truth.

1. Hermes pulls main.
2. Hermes selects the first ready task from coordination/TASK-QUEUE.json.
3. Work happens on hermes/<task-id>-<slug>.
4. Hermes tests, commits, pushes, and opens a pull request.
5. Codex reviews scope, security, RLS, tests, and CI.
6. Codex may merge non-production alpha work only after every gate in AGENTS.md passes.
7. Production deployment, production migrations, secrets, billing, and destructive actions remain human-approved.

On Windows, run scripts/install-hermes-worker.ps1 once after cloning to register the local worker.

## Status

Foundation initialized. The next executable task is ALIA-001.
