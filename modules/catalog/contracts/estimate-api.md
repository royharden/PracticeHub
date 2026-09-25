---
doc_id: estimate-api
title: "estimate API — FROZEN contract (WP-051)"
status: frozen
depends_on: [tenancy-types, audit-emit]
---

# Good Faith Estimate API (FROZEN)

Frozen by WP-051 per `planning/work-packages.csv` (estimate API frozen; estimate tables).
Changing any frozen shape below requires an adjudicator ruling recorded in
`docs/architecture/adrs/`. Compliance trace: R6-REQ-035, R6-REQ-050, R6-REQ-051,
R6-REQ-052. Audit retention class `gfe-record` is defined by WP-020
(`docs/contracts/audit-emit.md`, forward obligation `FWD-AUD-051-GFE`).

## Owned behavior

1. **Self-pay total.** `gfeTotalMinor` is the sum of `non-covered` line expected
   amounts. Expected amount is the PFS or CLFS fixture unit amount times quantity,
   in integer minor units. `claimTotalMinor` is the sum of `covered` line expected
   amounts and is excluded from the GFE.
2. **$400 boundary.** A variance is flagged when `actualTotalMinor - gfeTotalMinor`
   is greater than or equal to `40000` ($400.00). A delta of `39999` ($399.99) is
   not flagged. A flagged variance produces a PPDR artifact carrying the GFE ref,
   both totals, the delta, and closed-vocabulary notices.
3. **Line attribution.** Every line names one provider or one facility. Exactly
   one convening party is named on the estimate, and at least one line uses role
   `convening` for that party. Other provider lines are `co-provider`. Other
   facility lines are `co-facility`. `aggregateByParty` sums self-pay and claim
   amounts per party for later aggregation.
4. **Retention.** Every issued estimate registers `recordClass: gfe-record`,
   the GFE ref, and the canonical content sha-256, with `packageId: WP-051`.

## Tables

`catalog.fee_schedule_rate`, `catalog.good_faith_estimate`, and `catalog.gfe_line`
in `modules/catalog/migrations/0061-wp051-catalog-gfe.sql`. Append-only for
`module_catalog`. Cash purchase binding lives in `@practicehub/catalog-cash`
`CashGfeIssuer` and refuses a GFE total that exceeds the self-pay sum.

## Fixtures

`modules/catalog/fixtures/WP-051.PFS.json`, `WP-051.CLFS.json`, and the four-class
set `WP-051.HAPPY.json`, `WP-051.BOUNDARY.json`, `WP-051.FAILURE.json`,
`WP-051.RECOVERY.json`.
