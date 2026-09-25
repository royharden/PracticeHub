---
doc_id: eligibility-port
title: 'RCM eligibility port — booking, T-48, and day-of'
date: 2026-09-25
package_id: WP-081
module: M20
status: frozen
---

# Eligibility port (WP-081)

Frozen port for the M20 eligibility rail. It sits on the WP-080 shadow store in `modules/rcm`. It does not transmit to a live payer rail.

## Port

`EligibilityPort.check` is the only decision path. `runBookingCheck`, `runT48Check`, and `runDayOfCheck` each call that port with their own checkpoint.

A check takes `now`, payer `answers`, and one WP-040 coverage answer. The coverage answer's checkpoint must match the check.

## Answers

An answer is `{ sourceId, receivedAt, covered }`. `receivedAt` and `now` are `YYYY-MM-DDTHH:MM:SSZ`.

The check age is the whole hours from the newest `receivedAt` to `now`.

Maximum age:

- booking: 24h
- t48: 48h
- day-of: 12h

If the age is above the maximum, the disposition is `stale-denied`, `cleanYes` is false, and `trace` contains `check age <N>h`.

If the newest answer is fresh and that UTC day contains both `covered: true` and `covered: false`, the disposition is `contradictory` and `cleanYes` is false. A contradiction is not a clean yes.

A fresh unanimous yes is `eligible` and `cleanYes` is true. A fresh unanimous no is `ineligible` and `cleanYes` is false.

## Placeholder (WP-040)

Scheduling is package WP-040 and is not imported. The coverage answer type is `Wp040CoverageAnswer`:

`{ packageId: "WP-040", appointmentId, tenantId, checkpoint, serviceAt }`.

The fixture is `modules/rcm/fixtures/wp-040-coverage.json`.

The WP-056 ledger placeholder from WP-080 stays in place.
