---
doc_id: lab-api
title: "Lab API v1 (FROZEN — WP-064)"
status: final
depends_on: [clinical contracts v2, workitem-sla-api]
---

# Lab API v1 (FROZEN)

Delivered by **WP-064** (M15). Module code: `modules/labs`. Schema:
`modules/labs/migrations/0064-labs.sql` (`labs`). Capability ceiling is
**simulated with synthetic data only**. This contract does not modify the
frozen clinical-contracts or WorkItem modules.

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
`correctResult` appends a new electronic result whose `supersedesResultId`
names the prior current result. The prior row stays readable through
`readResult` and `history`. A superseded row cannot be corrected again.

## Critical-result closure

A critical result opens a closure in phase `paged` and a critical WorkItem on
pool `lab-critical-results`. Closure is only this sequence:

1. `acknowledgeCritical` assigns the WorkItem.
2. `recordCriticalContact` stores the contact evidence.
3. `closeCritical` resolves the WorkItem.

Skipping a step fails. The paged result stays readable after closure.

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

`adjudicateConflict` records `keep-manual` or `accept-electronic`. Accepting
the electronic value makes it current and leaves the manual value readable.
There is no silent replacement.

## Tables

`labs.lab_order`, `labs.lab_result`, `labs.critical_closure`, and
`labs.expected_result_age` are tenant-scoped. Manual rows require a read-back
equal to the stored value. An electronic row is provisional only while its
reconciliation state is `conflict`.

## Device ingestion and recall (WP-065)

`ingestDeviceResult` posts a `device` result. It requires calibration metadata:
`deviceId`, `lotId`, `calibratedAt`, and `method`. A missing calibration stores
nothing.

`widenRecallCohort` returns every device result for that device and lot. A
later result from the same device and lot joins the cohort. A different lot
stays out. Schema: `modules/labs/migrations/0065-labs-device.sql`
(`labs.device_calibration`, `labs.device_recall`). The tracked copy of this
contract is `modules/labs/contracts/lab-api.md`.
