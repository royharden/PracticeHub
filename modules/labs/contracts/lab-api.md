---
doc_id: lab-api
title: 'Lab API v1 (FROZEN — WP-064)'
status: final
depends_on: [clinical contracts v2, workitem-sla-api]
---

# Lab API v1 (FROZEN)

Delivered by **WP-064** (M15). Module code: `modules/labs`. Schema:
`modules/labs/migrations/0064-labs.sql` (`labs`). Capability ceiling is
**simulated with synthetic data only**. This contract does not modify the
frozen clinical-contracts or WorkItem modules.

Storage hardening is published separately in
`modules/labs/migrations/0073-labs-hardening.sql`, after original 0064 and
device migration 0065. The trusted superuser that owns the labs schema supplies
one atomic transaction per migration.
0073 accepts the exact original six-table catalog or its own complete hardened
catalog, and refuses unknown/partial schema or incompatible legacy rows. It
does not backfill clinical decisions or read-back values.

0073 requires non-null manual read-back actor, instant and value, with the value
equal to the stored result. It enforces the result provisional shapes described
below and the complete supersession audit shape. These are storage guarantees;
calibration ordering, current-result selection and WorkItem decisions remain
the in-memory module's responsibility.

The migration creates `module_labs` with no login, superuser, RLS bypass, database
creation or role creation privilege. `practicehub_app` receives membership;
the role receives labs schema USAGE, SELECT/INSERT/UPDATE on the four core
tables and SELECT/INSERT on the two device tables. There are no DELETE,
TRUNCATE, CREATE, default-privilege or cross-schema additions. All six tables
retain ENABLE/FORCE RLS and their tenant policies. Existing unexpected roles,
ACLs and role dependencies are refused; a database-and-owner-bound role comment
records migration origin and is checked alongside the complete catalog and
dependency state.

`0073-labs-hardening.rollback.sql` is an atomic, guarded downgrade. It refuses
any supersession audit, result shape incompatible with original 0064, unknown
origin or external role dependency. Permitted downgrade preserves the six
tables and rows, restores original constraints, removes only 0073 columns and
proven role/grant effects, and permits reapply. It never fabricates data or
uses cascading removal. Original 0064's weaker read-back CHECK is restored on
downgrade, including its SQL-UNKNOWN permissiveness for a null read-back value.

## Placement

Orders and results are PracticeHub clinical resources from WP-060:

- an order stores a `ServiceRequest`
- a result stores an `Observation` and a `DiagnosticReport`

Both use `sourceVersion` `practicehub-clinical-contracts-v2` and a LOINC
coding. `assertPhClinicalResource` rejects a non-synthetic resource.

Accountable queues use the WP-022 WorkItem fold. The frozen origin vocabulary
has no lab token, and WP-064 does not edit that module. Lab work items use
origin `admin` with purpose `lab.critical-closure` or
`lab.expected-result-aging`.

## Orders and results

`placeOrder` records the order, the expected-result instant, and the service
request. `expectedResultBy` is after `orderedAt`.

`recordElectronicResult` posts one electronic result and makes it current.
`correctResult` appends a new result whose `supersedesResultId` names the prior
current result, with the same source as the result it corrects: a kept
(`adjudicated-manual`) manual value is corrected by a manual, final entry that
carries its own read-back (H-08, NR-143). The prior row stays readable through
`readResult` and `history`. A superseded row cannot be corrected again.

## Critical-result closure

A critical result opens a closure in phase `paged` and a critical WorkItem on
pool `lab-critical-results`. Closure is only this sequence:

1. `acknowledgeCritical` assigns the WorkItem.
2. `recordCriticalContact` stores the contact evidence.
3. `closeCritical` resolves the WorkItem.

Skipping a step fails. The paged result stays readable after closure.

A critical value rejected by a `keep-manual` adjudication ends its closure in
phase `superseded`: its WorkItem resolves, and `supersededBy`, `supersededAt`
and `supersededReason` record the adjudicator, instant and reason. It is never
left open or closed silently (H-08, NR-142).

## Expected-result aging

`ageExpectedResults` places each order that is still awaiting a result, and
whose expected instant is at or before the supplied instant, onto pool
`lab-expected-results`. An order that already has any result, or whose
expected instant is later, stays off that queue. Repeating the call keeps the
same WorkItem id.

## Outage manual entry

`enterOutageManual` requires a read-back: the confirmed value equals the
entered value, and the read-back names the actor and instant. The manual row
is always provisional. A mismatched read-back is rejected and stores nothing.

`reconcileElectronic` compares a later electronic value with that manual row:

- equal values match; the electronic row becomes current; the manual row stays
  provisional and readable
- different values conflict; the manual row stays current; neither value is
  dropped

`adjudicateConflict` records `keep-manual` or `accept-electronic`. Either
outcome results the order. Accepting the electronic value makes it current and
final and leaves the manual value provisional and readable. Keeping the manual
value makes it current and final (`adjudicated-manual`, not provisional) and
leaves the rejected electronic value provisional and readable. There is no
silent replacement.

A critical value is paged whenever it is stored: a critical electronic value
opens its closure at reconciliation, even while its conflict is open, unless a
matched manual row carrying the same value already paged it. Every critical
value that becomes current therefore has exactly one closure
(`closuresForOrder`).

The first result stored for an aged order resolves its aging WorkItem
(`agingFor`). `correctResult` also corrects a device result; the correction is
a device result and requires fresh calibration. A result still pending
reconciliation or in conflict cannot be corrected.

## Tables

`labs.lab_order`, `labs.lab_result`, `labs.critical_closure`, and
`labs.expected_result_age` are tenant-scoped. Manual rows require a read-back
equal to the stored value and stay provisional until `adjudicated-manual`. An
electronic or device row is provisional only while its reconciliation state is
`conflict`, or after it lost a `keep-manual` adjudication.

## Device ingestion and recall (WP-065)

`ingestDeviceResult` posts a `device` result. It requires calibration metadata:
`deviceId`, `lotId`, `calibratedAt`, and `method`. A missing calibration, or a
`calibratedAt` after the result's `recordedAt`, stores nothing (H-08, NR-110).

`widenRecallCohort` returns every device result for that device and lot and
marks each with the recall id (`recallIds`). A later result from the same
device and lot joins the cohort and is flagged at ingest. A different lot
stays out (H-08, NR-109). Schema: `modules/labs/migrations/0065-labs-device.sql`
(`labs.device_calibration`, `labs.device_recall`). The tracked copy of this
contract is `modules/labs/contracts/lab-api.md`.
