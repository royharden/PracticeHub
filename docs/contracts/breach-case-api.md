---
doc_id: breach-case-api
title: "Breach Case API v1 (PROPOSED — WP-098)"
status: proposed
depends_on: [clock-api, audit-emit, elevation-api]
---

# Breach Case API v1 (PROPOSED)

WP-098 owns the breach-case consumer boundary for R6-REQ-006 and R6-SR-033. The
capability ceiling is **simulated with synthetic data only**. This contract does
not modify or duplicate the frozen consent clock, audit chain/retention, identity
break-glass, WorkItem, event-spine, or communications contracts.

## Aggregate and invariants

`BreachCase` is event sourced. Incident time and discovery time are distinct;
notification duties anchor on discovery. Every key is tenant scoped. Events,
four-factor assessments, affected-scope versions, jurisdiction-duty links,
notification evidence, and genetic targeted-review evidence are append only.
The projection is a fold and is never an independent source of truth. Persisted
event tuples and canonical semantic hashes are verified before fold; raw replay
must satisfy the same closed shapes and transitions as commands.

The four factors are: nature/extent of PHI, unauthorized recipient, acquisition
or viewing, and mitigation. Missing or unknown input fails closed: it may be
recorded as an incomplete assessment but cannot support a low-probability or
reportable determination. Each assessment binds to the current affected-scope
version, so a new scope requires a new assessment. A determination requires a
rationale reference, attributed assessor, and distinct human approver.

Affected scope is audit-derived, content-addressed, versioned, and
limitation-aware. An incomplete audit result must carry a limitation reference
and cannot be presented as complete. New scope appends a version and reopens the
assessment without erasing prior facts.

Every provider-returned federal/state duty and required-audience set remains
visible. The earliest open provider-returned due instant drives the case alert;
WP-098 performs no statutory date arithmetic. Notice preparation, independent
human approval, persisted effect intent, transport result, reconciliation, and
terminal evidence are distinct. `accepted` and `unknown` are never delivered
evidence. Orchestration persists the effect-intended aggregate before calling
the notification port.

An exact WP-017 source carrying both `elevated-genetic` and `gipa-genetic` opens
one critical targeted review linked to its grant, audit event, mandatory-review
WorkItem, and source-supplied `reviewDueAt`. The targeted deadline is not the
WP-019 `rule-pack-review` obligation. The targeted reviewer cannot be the
accessor or initiator.

## Literal v1 ports

- `BreachClockPortV1` owns provider-computed notification duties and clock-event
  references. It is the only source of policy versions and due instants.
- `BreachAuditPortV1` queries affected scope, appends breach audit linkage, and
  binds retention/legal-hold evidence. Breach records contain refs, never a
  second audit chain.
- `BreachNotificationPortV1` prepares, sends an approved intent, and reconciles
  terminal transport evidence with stable tenant/case/duty keys.
- `GeneticElevationSourceV1` supplies the exact public WP-017 facts required by
  the targeted-review consumer.

Each port exposes literal `version: 'v1'`. Recording doubles are part of this
module. Provider adapters may be added only by a separately owned assignment.

## Closure

A reportable case closes only after every applicable duty carries provider
satisfaction evidence and every required audience has terminal delivered
notification evidence. A low-probability case closes only with complete known
factors, rationale, approval, and provider clock cancellation/satisfaction
evidence. Either path requires an affected-scope version, retention evidence,
and completion of any genetic targeted review. Closure retains the full event
timeline and all prior versions.

## Forward dispositions

- `FWD-CLOCK-098-BREACH`: consumed through `BreachClockPortV1`; production
  provider binding and shared local-runner wiring remain integrator owned.
- `FWD-ELEVATION-098-GENETIC`: consumed through
  `GeneticElevationSourceV1`; identity provider bytes remain unchanged.
- `FWD-MERGE-098-BREACH`: accepted as a versioned `wrong-disclosure` intake;
  live event-spine binding remains forward until separately assigned.
- Notification delivery uses the v1 notification port and recording double;
  production communications binding is not claimed.

Canonical clause mapping: REQ-ADM-021 supplies the assessment/notification
workflow carrier; REQ-ADM-035 supplies retention/evidence linkage; and
REQ-COMM-026 supplies notification effect/receipt semantics. R6-REQ-006 consumes
those clauses through FWD-CLOCK-098-BREACH and FWD-MERGE-098-BREACH. R6-SR-033
consumes WP-017 facts only through FWD-ELEVATION-098-GENETIC. Provider parity,
event-spine binding, capability registration, and shared runner wiring remain
forwarded to integrator-owned work.

## Verification boundary

Four-class fixtures for R6-REQ-006 and R6-SR-033 execute domain behavior.
Package gates include transition/property tests, port-double conformance,
generated RLS/seed drift, forward/rollback/forward migration, forced-RLS and
least-privilege probes, two-client races, transaction rollback, projection-fold
parity, and fresh-connection idempotency. Repository, stack, hooks, provider
parity, capability registration, and shared routing require later grants.
