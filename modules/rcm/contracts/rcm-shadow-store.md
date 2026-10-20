---
doc_id: rcm-shadow-store
title: "RCM shadow store — sealed 835/837 mirror and historical backload"
date: 2026-09-25
package_id: WP-080
module: M20
status: frozen
---

# RCM shadow store (WP-080)

`modules/rcm/contracts/rcm-shadow-store.md` is the module API contract. `docs/contracts/rcm-shadow-store.md` is its byte-identical publication copy; updates to the module text are synchronized to that copy. The distinct clearinghouse-router integration contract is separate.

## Owned surface and boundary

`modules/rcm` provides an in-memory shadow store of sealed synthetic 835/837 mirrors and historical backload reconciliation. Shadow mode computes outcomes without live rail credentials or production side effects (ADR-011). The named WP-056 port remains a placeholder; this contract does not establish a real payments-ledger adapter, persistence, or production authorization.

## Mirror body and seal

A mirror body is `{ tenantId, kind, controlNumber, amountMinor, currency, payload }`. `kind` is `837` or `835`; `amountMinor` is a non-negative safe integer and `currency` is `USD`. Tenant and control identifiers follow the constrained token format enforced by `assertMirrorBody`. The payload is a non-empty synthetic internal string of at most 4,000 characters, not an X12 document.

`canonicalMirror` serializes JSON keys in this order: `amountMinor`, `controlNumber`, `currency`, `kind`, `payload`, `tenantId`. `sealCanonical` returns the lowercase hexadecimal SHA-256 of those UTF-8 bytes. The mirror identity is `(tenantId, kind, controlNumber)`.

`ShadowStore.append` stores a private frozen copy of the body and freezes the returned record, shadow credential, and recorded posting. Re-appending the same sealed body returns the existing record. A different seal under the same identity throws `SEAL_CONFLICT`; it does not replace the earlier mirror or record another posting. `list()` returns a frozen array of the stored records. These guarantees describe one store instance, not durable storage across process restart.

## Credentials and shadow ledger guard

A presented credential is `{ class: 'shadow', credentialId }` or `{ class: 'live', credentialId, railId }`. Append rejects live credentials, invalid shadow credential identifiers, and shadow identifiers found in the supplied live-credential set. Live rail credentials are not copied into the sealed record.

Construction requires a `Wp056LedgerPort` with `packageId: 'WP-056'` and `journal: 'shadow'`. A missing or different journal value is refused with `SHADOW_JOURNAL_REQUIRED`, including a live port cast to the TypeScript interface. This is a declared-flag check, not proof of a port's underlying effects. A real live-ledger implementation must not advertise `journal: 'shadow'`; real WP-056 binding still needs the corresponding integration proof.

An accepted `835` records `{ packageId: 'WP-056', postingId, tenantId, amountMinor, currency: 'USD', sourceSeal }` through that shadow port. An `837` records no posting. The posting identifier is derived from the seal, and `sourceSeal` is the mirror seal. No live M19 posting is authorized by this interface.

## Historical backload

`reconcileBackload` validates incumbent rows and groups both inputs by `(tenantId, kind, controlNumber)`. Verification checks that the canonical bytes hash to the seal and that the supplied body re-canonicalizes to those same bytes. When sealed canonical data can be parsed and verified, it supplies the shadow key used for comparison.

- `matched`: both sides exist, the shadow seal/body checks hold, and amount and payload agree.
- `unmatched`: a valid key exists only on the incumbent or shadow side.
- `conflicting`: amount, payload, or seal verification differs, or repeated rows/mirrors share a key. Duplicate conflicts carry `reason: 'duplicate'` and `occurrences`; an invalid shadow seal is a conflict even without an incumbent row. Malformed incumbent rows are refused rather than silently matched.

Every report contains all three collections. Reconciliation reports findings; it does not write a live ledger.

## Limits and integration obligations

The non-negative amount model cannot represent 835 recoupments or negative adjustments. Signed adjustments or another explicit representation remain required before real WP-056 wiring can claim to support those cases. The port, fixture `modules/rcm/fixtures/wp-056-ledger.json`, simulator boundary, and separate-credential proof remain in place. Documentation synchronization does not discharge adapter, database, full/local verification, or landing gates.
