---
doc_id: prior-auth
title: 'RCM prior authorization and medication continuity'
date: 2026-09-25
package_id: WP-082
module: M20
status: frozen
---

# Prior authorization and medication continuity (WP-082)

This sits on the WP-081 eligibility rail in `modules/rcm`. It does not import an eRx module.

## Continuity

The medication source is the WP-066 placeholder `Wp066MedicationSource`. The fixture is `modules/rcm/fixtures/wp-066-medication.json`.

`gapDays` is `nextFillInDays - daysOfSupplyRemaining`. The package threshold is 3 days.

When `gapDays` is greater than 3 and the alert is unacknowledged, it escalates one step: `open` to `covering-prescriber`, then `covering-prescriber` to `medical-director`. An acknowledged alert does not escalate.

## Interim source

A prior-auth clause with a non-empty `interimSource` is honored and kept. It is not dropped. The honored record names that source. A clause with no interim source and no native rule is dropped.
