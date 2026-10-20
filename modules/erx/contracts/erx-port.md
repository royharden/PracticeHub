---
doc_id: erx-port
title: 'eRx vendor embed port — transmit, refill and renewal queues'
date: 2026-09-26
package_id: WP-066
module: M16
status: proposed-frozen
---

# eRx port (WP-066)

`ErxEmbed.transmit({ tenantId, vendorId, kind, jurisdiction, itemId, medicationRef })` sends one prescription action to the vendor embed. `kind` is `new`, `refill` or `renewal`. Only the fixture vendor `fixture-vendor` is accepted until a real vendor is contracted; any other vendor throws `UNKNOWN_VENDOR`.

**Idempotency.** A transmit is keyed by `(tenantId, itemId)`. A repeat with the same vendor, kind, jurisdiction and medication reference returns the first result and has no second side effect. A repeat with any of those changed throws `IDEMPOTENCY_CONFLICT`. A blocked transmit sends nothing and is not recorded, so a retry is judged again.

**Queues.** A completed `refill` lands only in the refill queue and a completed `renewal` only in the renewal queue, each item carrying `tenantId`, `itemId`, `kind` and `medicationRef`. A `new` prescription queues nothing.

**Jurisdiction.** Legality comes from an `ErxJurisdictionPort` for platform topic `erx-epcs-pdmp`. A transmit is blocked (`{ completed: false, blocked: 'jurisdiction' }`) when the jurisdiction does not resolve, when the decision is for another topic, or when the obligations include `jurisdiction-unverified-hard-block`. The fixture port marks FL legal and XX illegal. Binding the platform-core resolver is a forward obligation.

**Medication list.** The medication list is WP-062's; this module names it by placeholder only.

Not in this contract yet: rx tables (schema), the erx simulator (WP-028), EPCS two-factor and PDMP checks.
