---
doc_id: inventory-api
title: "inventory API — FROZEN contract (WP-075)"
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

Schema: `modules/inventory/migrations/0066-wp075-inventory.sql`.
