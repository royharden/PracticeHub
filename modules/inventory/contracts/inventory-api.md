---
doc_id: inventory-api
title: 'inventory API — FROZEN contract (WP-075)'
status: frozen
depends_on: [tenancy-types]
---

# Inventory API (FROZEN)

Frozen by WP-075. Products, lots, units, dispense ties, and recall drills live in
`modules/inventory`. Changing a frozen shape requires an adjudicator ruling.

1. A lot carries an expiry date. A dispense on that date is allowed. A dispense
   on a later date is refused and creates no tie.
2. A unit is dispensed at most once.
3. A recall drill lists every unit received on the lot. Units already tied to a
   dispense stay on the drill with that dispense ref. Units not dispensed stay
   on the drill with a null dispense ref.
4. A receive is all-or-nothing. A refused receive creates no lot, no unit and
   no change to an existing lot's units, so a drill can never miss a unit.
5. A drill ref is a point-in-time snapshot. Re-running it returns the same
   report while nothing on the lot has changed, and is refused
   (`DRILL_CONFLICT`) once it has; a later drill uses a new ref.
6. A recall contains its lot (REQ-INV-001 AC-2). While a recall is open, no
   undispensed unit of the lot can be dispensed (`LOT_RECALLED`) and no unit can
   be received into it. Units already dispensed stay tied and stay on the drill.
   One recall may be open per lot. Only a named human actor (`human:<name>`) may
   release a recall (`RELEASE_REQUIRES_HUMAN` otherwise); release is recorded,
   never deleted.

Items 4 to 6 were added by WP-075 rework 1 (review `D48-WP-075-a1-review-1`,
findings F1, F4 and F2); items 1 to 3 are unchanged.

Schema: `modules/inventory/migrations/0066-wp075-inventory.sql` is the immutable
historical six-table epoch. `0074-inventory-recall-events.sql` adds the accepted
`lot_recall_event` storage with tenant/composite lot foreign keys, token checks,
nonblank reason, synthetic watermark, one row per tenant/recall/kind and a human
actor for release. The module role has SELECT/INSERT only on this event table.

This storage does not itself enforce clause 6 containment, opening-before-release,
same-lot pairing across event kinds, date ordering or a single active recall per
lot. Those barriers belong to the existing in-memory application methods; this
migration makes no concurrent database containment guarantee.

0074 requires the historical six tables and their forced RLS. It rejects unexpected
existing event shape/policy/ACL and validates the seven-table RLS epoch. The caller
(migration journal or controlled proof harness) owns the atomic transaction.
`0074-inventory-recall-events.rollback.sql` removes only the event table without
CASCADE and validates the six-table epoch. Preserve/export event history before
rollback and switch consumers to a compatible capability/version; reapplication
alone does not recover event history. Existing six-table data, ACLs and role
memberships survive this bounded rollback.
