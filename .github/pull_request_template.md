## Task

Task ID:

## Outcome

Describe the completed behavior and why it satisfies the queued acceptance criteria.

## Acceptance criteria

- [ ] Every criterion in coordination/TASK-QUEUE.json is satisfied.
- [ ] Scope is limited to one task.
- [ ] coordination/TASK-QUEUE.json and coordination/CURRENT-STATE.md are advanced correctly.

## Verification

List exact commands and results.

## Security and privacy

- [ ] No secret, production data, raw child data, or unrestricted credential was added.
- [ ] Tenant identity comes from trusted authentication.
- [ ] RLS remains enabled and forced on affected tenant tables.
- [ ] Cross-organization CRUD denial tests pass when data access changed.
- [ ] Individual workspaces cannot access organization-shared memory.
- [ ] Normal request paths do not use a service-role bypass.

RLS evidence or not applicable:

## Cost and resilience

State whether this changes model calls, tokens, cache, storage, queues, provider cost, timeouts, retries, or fallback behavior.

## Known limitations

List remaining limitations honestly. Do not claim production readiness or measured learning impact without evidence.
