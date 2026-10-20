---
doc_id: charge-capture
title: 'RCM charge capture and reconciliation'
date: 2026-09-25
package_id: WP-083
module: M20
status: frozen
---

# Charge capture (WP-083)

`reconcileCharges` compares expected and captured `Wp062EncounterCharge` lines. The WP-062 input is still a named placeholder, with fixture `modules/rcm/fixtures/wp-062-charges.json`; this module does not rebuild the encounter source or establish its runtime binding.

## Identity and reconciliation outcomes

Charge identity is `(tenantId, encounterId, chargeId)`, not `chargeId` alone. Amount and currency must agree when comparing lines. Amounts are non-negative safe integers. Repeating an expected key with divergent amount/currency is refused.

- An expected key absent from captures is `missing` and is not posted.
- Identical captured copies contribute their later copies to `duplicates`. One representative is considered for posting only if it matches an expected line.
- Divergent amount/currency copies under the same captured key all become `conflicts`; none is posted.
- A representative whose amount/currency differs from its expected line is an `amountMismatch` and is held, not posted.
- A representative with no expected line is `unexpected` and is held, not posted.
- Only a captured representative matching its expected line appears in `posted`.

These are reconciliation results; returning `posted` is not evidence of a live payment-rail effect.

## Heartbeats and replay

Every successful reconciliation records a `ReconciliationHeartbeat` containing `runId`, `at`, `missingCount`, `duplicateCount`, `postedCount`, `conflictCount`, `amountMismatchCount`, and `unexpectedCount` through the supplied `ReconciliationHeartbeatSink`. The default is the module-owned in-memory `chargeReconciliationHeartbeats`.

The scope contains the sorted tenant set and an input digest of `at`, the ordered expected lines, and the ordered captured lines. The default sink keys records by `(tenantKey, runId)`. An identical replay records no additional heartbeat; the same run identifier under another tenant scope is a separate run. A divergent replay of a recorded default-sink input is refused before charge computation by `assertReplayable`.

`assertReplayable` is optional on a custom sink. A custom implementation only provides the pre-computation refusal guarantee when it implements that method. A custom `record` method alone does not establish it. The default sink is in memory and does not prove restart persistence. Input validation or a refused replay throws instead of producing a successful heartbeat.

## Integration boundary

The WP-040, WP-056, WP-062, and WP-066 placeholders remain. Package dependencies, real posting/persistence adapters, combined checks, and landing are separate obligations. This text reflects the compound-key and replay controls already present in the implementation; it does not revive the superseded global-runId or chargeId-only behavior.
