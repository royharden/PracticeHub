---
doc_id: charge-capture
title: 'RCM charge capture and reconciliation'
date: 2026-09-25
package_id: WP-083
module: M20
status: frozen
---

# Charge capture (WP-083)

Charge lines come from the WP-062 placeholder `Wp062EncounterCharge`. The fixture is `modules/rcm/fixtures/wp-062-charges.json`. This package does not rebuild WP-062.

`reconcileCharges` compares expected lines to captured lines.

- A charge id present in expected and absent from captured is missing. It is listed on `missing` and is not added to `posted`.
- A charge id that appears more than once in captured is a duplicate. The first copy is posted. Later copies are listed on `duplicates` and are not posted again.
- Every run records a `ReconciliationHeartbeat` with `runId`, `at`, and the missing, duplicate, and posted counts.

The WP-040, WP-056, and WP-066 placeholders stay in place.
