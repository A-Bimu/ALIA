# Current build state

Updated: 2026-09-23

## Release

Founding-Pilot Alpha with a seven-day target. This is not an error-free or full-production claim.

## Completed

- Independent A-Bimu/ALIA repository created.
- Product boundary, security invariants, architecture, cost controls, and phased task queue defined.
- GitHub coordination and Hermes worker files initialized.
- CI governance checks initialized.

## Active

- Next task: ALIA-001, Foundation and executable contract.
- Owner: Hermes implementation worker.
- Reviewer/coordinator: Codex GitHub task.

## Blockers

None in the repository. The Hermes scheduled worker must be installed once on its Windows host after the repository is cloned.

## Quality gate

No production deployment, production database migration, secret change, billing change, or destructive action is authorized. Non-production pull requests may be merged automatically only under the gates in AGENTS.md.

## Handoff format

Every task pull request must record:

- task ID and acceptance criteria;
- changed files and architecture impact;
- tests and their exact results;
- RLS evidence when data access changed;
- cost and privacy impact;
- known limitations;
- next ready task.
