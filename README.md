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
- Tenant requests run as a restricted role over a dedicated least-privileged login; the migration/administrative credential is never used on a request path.
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
- [Local development and commands](docs/DEVELOPMENT.md)
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

## One-time Hermes link on Windows

Requirements: git, authenticated GitHub CLI, and the hermes command on PATH.

Run this in PowerShell:

~~~powershell
gh auth status
$aliaRepo = Join-Path $env:USERPROFILE "ALIA"
if (Test-Path (Join-Path $aliaRepo ".git")) {
    git -C $aliaRepo pull --ff-only
} else {
    gh repo clone A-Bimu/ALIA $aliaRepo
}
powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $aliaRepo "scripts\install-hermes-worker.ps1") -RepoPath $aliaRepo
~~~

The worker starts immediately, then runs every 15 minutes while the Windows user is signed in. Logs are stored under LocalAppData\Hermes\ALIA\logs.

## Status

Foundation and tenancy implemented. ALIA-001 (foundation and executable contract) and ALIA-002 (tenant
identity, schema, and RLS proof) are complete on `hermes/ALIA-002-tenant-identity-rls`; the next ready task
is ALIA-003 (learning-event and mastery loop). The alpha has eleven tenant tables with forced Row Level
Security, a transaction-bound selected organization so dual membership cannot widen access, trusted
organization resolution from verified membership, a dedicated least-privileged request login kept separate
from the migration credential, and an automated cross-organization isolation proof against a real
PostgreSQL. Setup, migration, and command reference:
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
