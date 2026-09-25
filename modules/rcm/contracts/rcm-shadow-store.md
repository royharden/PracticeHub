---
doc_id: rcm-shadow-store
title: "RCM shadow store — sealed 835/837 mirror and historical backload"
date: 2026-09-25
package_id: WP-080
module: M20
status: frozen
---

# RCM shadow store (WP-080)

Frozen contract for the M20 shadow store. Shadow means full compute with sealed, append-only outputs, credentials that are not live rail credentials, and no production side effects (ADR-011).

## Owned surface

`modules/rcm` implements this contract. The ledger this store would post into is package WP-056 and is not imported. Callers use the named placeholder `Wp056LedgerPosting` and the fixture `modules/rcm/fixtures/wp-056-ledger.json`.

## Mirror body

A mirror body is `{ tenantId, kind, controlNumber, amountMinor, currency, payload }`.

- `kind` is `837` (claim) or `835` (remittance).
- `amountMinor` is a non-negative safe integer. `currency` is `USD`.
- `payload` is a synthetic internal string. It is not an X12 document.
- `tenantId` and `controlNumber` are non-empty tokens without whitespace.

## Seal

The canonical bytes are JSON with keys in this order: `amountMinor`, `controlNumber`, `currency`, `kind`, `payload`, `tenantId`. The seal is the lowercase hex SHA-256 of those UTF-8 bytes. The same body always seals the same way. Any change to a sealed field changes the seal. A stored mirror is kept only when `SHA-256(canonical)` equals `seal`.

The identity of a mirror is `(tenantId, kind, controlNumber)`. Appending the same body again returns the existing sealed record. Appending a different body for the same identity is rejected and does not replace the stored seal.

## Credentials

A presented credential is either `{ class: "shadow", credentialId }` or `{ class: "live", credentialId, railId }`.

The store is constructed with the set of live rail credential ids. Append accepts only `class: "shadow"` whose `credentialId` is absent from that set. A live credential is never copied onto a sealed record. Shadow credential ids and live rail credential ids are different values.

## Ledger placeholder (WP-056)

An accepted `835` asks the WP-056 placeholder port to record one `Wp056LedgerPosting`:

`{ packageId: "WP-056", postingId, tenantId, amountMinor, currency: "USD", sourceSeal }`.

`sourceSeal` is the mirror seal. The port's `packageId` is `WP-056`. An `837` records no posting. This package does not write the payments ledger.

## Historical backload

Reconciliation compares incumbent rows to sealed mirrors on `(tenantId, kind, controlNumber)`.

- `matched`: both sides exist, amounts are equal, payloads are equal, and the shadow seal verifies.
- `unmatched`: the key is present on only one side (`incumbent` or `shadow`).
- `conflicting`: both sides exist and the amount, the payload, or the seal check differs.

The report contains all three collections on every run.
