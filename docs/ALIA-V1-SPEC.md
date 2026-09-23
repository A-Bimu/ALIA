# Adaptive Learning Intelligence Agent: founding-pilot alpha specification

Status: implementation baseline  
Target: seven calendar days from 2026-09-23  
Release label: Founding-Pilot Alpha

## 1. Product promise

ALIA gives a learning platform one secure adaptive loop: accept evidence about a pseudonymous learner, update learner state, recognize a recurring misconception, choose the next learning action, and return a grounded tutoring strategy or response.

The pilot demonstrates working infrastructure. It must not claim proven learning impact, full production readiness, or error-free behavior before evidence exists.

## 2. System boundary

Partner platforms own curriculum, content, user-facing experience, consent collection, and their user identity. ALIA owns adaptive intelligence and exposes versioned contracts.

Eureka Learn and KidyCode are independent products and ALIA's first validation environments. Either product must continue operating when ALIA is unavailable.

## 3. Alpha API surface

All endpoints are versioned under /api/v1 and return a trace_id.

### POST /events

Accept one idempotent learning event.

Required concepts:

- external_event_id;
- pseudonymous_learner_id;
- skill_id;
- event_type;
- occurred_at;
- evidence containing only approved, minimum-necessary fields.

The authenticated context determines the organization. A body-supplied organization identifier is rejected or ignored.

### POST /adapt

Return:

- current mastery band and confidence;
- detected misconception code, when supported by evidence;
- recommended next action;
- reason codes;
- source: rule, organization_memory, cache, or model;
- whether an educator review is recommended.

### POST /tutor

Return a grounded tutoring response constrained by supplied curriculum context and age-aware policy. It must not create an open-ended child-to-model channel. The orchestration layer selects allowed context, strategy, token budget, and model route.

### GET /health

Return service health without secrets, tenant data, or dependency credentials.

## 4. Tenancy and Row Level Security

Use one organizations table as the isolation root. Its account_type is organization or individual. An individual account receives a one-owner private workspace, which keeps the isolation implementation consistent without enabling shared organization behavior.

Every tenant-owned row contains organization_id. Normal requests run with an authenticated principal and policies derive accessible organizations from active memberships. Enable and force RLS on every tenant-owned table. Start with no permissive policy.

Required policy behavior:

- active organization members can access only rows for their own organizations;
- role checks restrict administration and organization-memory approval;
- an individual workspace is accessible only by its owner;
- learner-private rows are further restricted to the authorized learner or approved educator role;
- no user in organization A can select, insert, update, or delete organization B data;
- removal or suspension of membership removes access immediately;
- normal request code cannot bypass RLS.

RLS integration tests must create two organizations, at least two members, and distinct learners, then prove denial in every CRUD direction. Tests must also prove that an individual workspace cannot insert or retrieve organization-shared memory.

## 5. Memory model

### Private learner memory

Private memory may store mastery evidence, prior intervention outcomes, preferences needed for learning, and misconception history. It is scoped to organization_id plus learner_id. It is not readable by other learners and is never automatically promoted into organization memory.

### Organization solution memory

Organization solution memory exists only for organizations whose account_type is organization. It stores generalized, reusable knowledge:

- normalized misconception signature;
- skill and curriculum scope;
- approved explanation or intervention;
- provenance and reviewer;
- quality score;
- usage and success counters;
- version, status, and expiry.

It must not store a learner name, email, raw chat, raw submission, or direct external learner identifier.

A recurring mistake can create a candidate only after a configurable recurrence threshold. Candidate status is pending. An organization admin or educator with approval permission must approve it before retrieval. Approved memory is visible only inside that organization. Rejected, expired, or retired memory is never served.

Use a deterministic fingerprint to suppress duplicates. Prefer normalized keys and PostgreSQL full-text search first. Embedding retrieval is optional behind a feature flag and is added only when measured recall justifies its cost.

## 6. Cost-control decision ladder

For every adapt or tutor request:

1. validate schema, authorization, idempotency, and safety policy;
2. apply deterministic mastery and intervention rules;
3. search an exact approved organization-memory fingerprint;
4. check a bounded response cache;
5. run inexpensive retrieval;
6. call the configured small Meta Llama route;
7. escalate to a stronger configured route only for low confidence, complexity, or safety review.

Controls:

- maximum input and output tokens;
- daily and monthly organization budgets;
- request and model timeouts;
- duplicate-request coalescing;
- bounded retry with jitter;
- provider circuit breaker;
- cache TTL and invalidation on memory version change;
- fail-closed behavior when budget or safety limits are exceeded;
- usage ledger with estimated cost and route reason.

The alpha uses PostgreSQL for queues, cache metadata, counters, and audit data where practical. Do not add Redis, a vector service, or a separate event platform without measured need.

## 7. Learner modelling

The alpha uses deterministic, explainable evidence weighting and mastery bands so decisions can be tested. Every state update records the evidence and algorithm version.

PyTorch remains the planned experimentation path for later mastery-estimation and learning-pattern models. It is not placed in the synchronous alpha request path until there is sufficient validated data and an evaluation showing improvement over the deterministic baseline.

## 8. Language-model boundary

Meta Llama is the controlled language and reasoning layer behind a provider adapter. Model names and providers are configuration, not business logic.

The model receives only:

- approved curriculum context;
- a generalized learner-state summary;
- an allowed tutoring strategy;
- safety and format constraints;
- the minimum memory excerpt needed.

The model never decides tenant access, memory approval, budget, or final safety policy. Validate structured output before use. Record model route and prompt-template version without logging child personal data.

## 9. Core records

The alpha requires records for:

- organizations and memberships;
- integration clients or scoped authenticated principals;
- learners with pseudonymous external references;
- learning events with organization-scoped idempotency;
- learner skill state and history;
- private learner memory;
- organization memory candidates and approved solutions;
- adaptive decisions and intervention outcomes;
- model usage and organization budgets;
- audit events.

Add database constraints for tenant-consistent foreign keys where supported.

## 10. Reliability and privacy

- Idempotent event ingestion.
- Structured error codes.
- Request IDs and trace IDs.
- Rate limits per organization and principal.
- Data retention fields and deletion workflow.
- Export and deletion operate within one organization boundary.
- No raw secrets in logs.
- No sensitive payloads in analytics.
- Graceful fallback to deterministic recommendations when a model is unavailable.
- Partner products remain usable when ALIA is unavailable.

## 11. Founding-pilot alpha exit criteria

The alpha is ready for a controlled pilot when:

- one clean environment can be created from documented steps;
- cross-organization RLS tests pass;
- individual accounts cannot use shared organization memory;
- the full event to state to adapt to tutor loop works;
- approved memory reuse demonstrably avoids a model call;
- budget and circuit-breaker behavior is tested;
- one independent client can call the versioned API;
- CI is green;
- basic observability and audit evidence are available;
- known limitations and incident rollback steps are documented.

Production readiness requires a later security review, load testing, backup/restore test, incident exercise, privacy review, production monitoring, and measured pilot evidence.
