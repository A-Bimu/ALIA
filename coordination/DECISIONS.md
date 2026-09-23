# Architecture decision log

## ADR-001: Independent product boundary

Status: accepted, 2026-09-23

Adaptive Learning Intelligence Agent is an independent API/SDK service. Eureka Learn and KidyCode are independent products and first validation environments. They retain curriculum, identity, and learner experience.

## ADR-002: Modular monolith for alpha

Status: accepted, 2026-09-23

Use a TypeScript modular monolith with Supabase PostgreSQL/Auth. This is the fastest low-cost path to a secure pilot. Extract services only after measured need.

## ADR-003: Database-enforced tenancy

Status: accepted, 2026-09-23

All tenant data is rooted in organization_id and protected by forced RLS. Individual accounts receive one-owner isolated workspaces, but database rules prohibit organization-shared memory for them.

## ADR-004: Governed organization memory

Status: accepted, 2026-09-23

Only generalized, approved, active solutions are reused inside the same organization. Private learner memory is never automatically shared. Exact fingerprints and lexical retrieval precede optional embeddings.

## ADR-005: Cost-first model routing

Status: accepted, 2026-09-23

Rules, approved memory, cache, and retrieval precede a small configured Meta Llama route. Stronger model escalation requires an explicit reason. Budgets and circuit breakers are mandatory.

## ADR-006: Explainable alpha learner model

Status: accepted, 2026-09-23

Use deterministic evidence weighting in the synchronous alpha. Retain PyTorch as the planned evaluated experimentation path after sufficient pilot data exists.

## ADR-007: GitHub agent coordination

Status: accepted, 2026-09-23

Hermes implements one queued task per branch and pull request. Codex reviews and may merge non-production changes only after defined gates pass. Production actions remain human-approved.
