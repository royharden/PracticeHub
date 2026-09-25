---
doc_id: ledger-api-v2
title: "Ledger API v2 — FROZEN contract (WP-056)"
status: frozen
depends_on: [IPF5-ADR-012, capability-registry, stripe-phi-linter-spec]
---

# Ledger API v2 (FROZEN)

Frozen by WP-056 per `planning/work-packages.csv` (`contracts: ledger API v2 + IC-3 frozen`).
Source architecture: ADR-012 Decision 2. Module: `@practicehub/payments-ledger`.
Schema: `payments_ledger` (`0019-cash-ledger.sql` plus `0021-ledger-v2.sql`).
Changing any frozen shape below requires an adjudicator ruling recorded in
`docs/architecture/adrs/`, never a silent edit of a posted journal.

WP-055 (`adapters/stripe`) is the settled processor port this contract builds
against. This contract does not change that adapter.

## Decisions this contract freezes

1. **A posted set balances, and a correction is a new reversal.** `postBalancedSet`
   accepts one journal on exactly one of three rails: `insurance`, `membership`,
   or `cash`. Omitted `rail` is `cash`, so the WP-031 cash path stays valid.
   For each currency in the journal, debit minor units equal credit minor units.
   The stored journal is not edited. A second post of the same `(tenantId, journalId)`
   is `IDEMPOTENCY_CONFLICT`. A correction is a new journal whose lines swap
   sides, whose rail and `payoutRef` match the original, and which names
   `reversalOfJournalId`. A second reversal, a reversal of a reversal, or a
   line that is not the exact swap is `MIXED_REVERSAL` or `ALREADY_REVERSED`.
   Across the tenant, debit minor units equal credit minor units per currency.

2. **Payout reconciliation matches to the penny and opens a work item on drift.**
   `reconcilePayoutToThePenny` sums cash-rail lines whose `accountRef` is `cash`
   and whose currency is the payout currency. Debits add and credits subtract.
   Membership and insurance lines are excluded. The processor amount is a
   non-negative minor-unit integer. `driftMinor = payoutAmountMinor - ledgerMinor`.
   Zero drift returns `workItem: null` and does not change the lines. Any other
   drift, including one cent, returns a `payout-reconciliation-drift` work item
   and does not change the lines.

3. **Write-off approval tiers reject an under-authorized write-off.** Reasons are
   `small-balance`, `contractual-adjustment`, `uncollectible`, and `charity`.
   Roles rank `billing-clerk` < `billing-supervisor` < `rcm-lead`.

   | reason | ceiling | who may approve |
   |---|---|---|
   | small-balance | 1000 minor | clerk up to 1000; a larger amount is `TIER_EXCEEDED` for every role |
   | contractual-adjustment | any safe integer | clerk to 1000; supervisor to 10000; lead above that |
   | uncollectible | any safe integer | supervisor to 10000; lead above that; clerk never |
   | charity | any safe integer | lead only |

   `authorizeWriteOff` throws `UNDER_AUTHORIZED` when the role is below that
   row. `postWriteOff` posts a new balanced pair (`write-off-expense` debit,
   `accounts-receivable` credit) and throws `APPROVAL_MISMATCH` if the approval
   bytes no longer match that amount, currency, reason, role, rail, and tenant.
   The approval cannot replace an existing journal.

4. **Billing authority below `membership.entitlement-ledger` simulated is denied.**
   `assertBillingAuthoritySimulated` is the simulated check for
   `finance.billing-authority` (IC-3). It denies when that prerequisite is
   missing, below `simulated`, or write-blocked, including when a billing grant
   already says `simulated`. It allows only when the entitlement grant satisfies
   `simulated` and the billing grant satisfies `simulated`.

## Files

- `modules/payments-ledger/src/ledger.ts`
- `modules/payments-ledger/src/payout-reconciliation.ts`
- `modules/payments-ledger/src/write-off.ts`
- `modules/payments-ledger/src/billing-authority.ts`
- `modules/payments-ledger/migrations/0021-ledger-v2.sql`
