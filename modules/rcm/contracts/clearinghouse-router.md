---
doc_id: rcm-clearinghouse-router
title: 'RCM clearinghouse router'
date: 2026-09-25
package_id: WP-085
module: M20
status: frozen
---

# Clearinghouse router (WP-085)

Per-payer routes name a primary rail and, in `dual-rail` mode, a distinct secondary. `single-rail` mode uses only the primary.

`submitBatch` emits each claim id once. A repeated id increments `duplicateCount` and is not submitted again. In `dual-rail`, `failPrimaryAfter` moves later claims in that payer's batch to the secondary. Claims already sent to the primary stay there.

`manualSwitch` changes the payer's primary for later batches and appends `{ payerId, target, reason }` to the switch log.

`single-rail` records exactly one acknowledgment: `{ railId, mode: "single-rail", claimCount }`.

`acceptRemit` rejects an 835 when `835` is absent from `enrolledTransactions`, with reason `enrollment-constraint`.

Rails are `ch-sim-A` and `ch-sim-B`. This router does not use a live rail credential. The WP-040, WP-056, WP-062, and WP-066 placeholders stay in place. WP-026 is settled and is not edited.
