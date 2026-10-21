---
doc_id: rcm-clearinghouse-router
title: 'RCM clearinghouse router'
date: 2026-09-25
package_id: WP-085
module: M20
status: frozen
---

# Clearinghouse router (WP-085)

`ClearinghouseRouter` runs against synthetic `ch-sim-A` and `ch-sim-B` rails with a supplied transport or the simulated acknowledging default. It does not use a live rail credential or establish a production clearinghouse connection.

## Routing and enrollment

Per-payer routes name a primary and, in `dual-rail` mode, a distinct non-null secondary. `single-rail` uses the primary. Each 837 attempt checks payer enrollment on the selected rail. When per-rail enrollment is supplied, that list is authoritative; otherwise the legacy route-wide enrollment list supplies the check. A route missing the selected enrollment produces a held claim instead of a send.

Claims are identified by `(tenantId, payerId, claimId)`. The current API uses its default tenant scope when a caller omits `tenantId`; callers requiring tenant separation must provide it. Duplicate suppression spans batches within one router instance: repeated keys in one batch and keys already `in-flight` or `acknowledged` increment `duplicateCount` rather than sending again.

## Send outcomes and uncertainty

The router records the claim as `in-flight` before calling the transport, in its in-memory ledger. An `ack` marks it acknowledged and adds it to `submitted`. A definite `refused` answer means the claim was not received; in dual-rail mode the same claim may then be attempted once on the secondary.

A timeout or thrown transport error leaves that claim in flight. It is not resent on the other rail; later claims for that payer can use the secondary. A malformed or unknown answer also leaves the claim in flight and does not itself mark a rail outage or trigger failover. A `rejected` answer records `rejected-by-rail` and is reported in `railRejected`, rather than automatically resending that claim within the batch.

`resolveInFlight` records a caller-supplied status-inquiry finding: `holds` marks the claim acknowledged on the reported rail, while `not-held` releases it for resubmission. The router does not perform a real vendor inquiry. The synthetic `failPrimaryAfter` parameter exercises later-claim failover after the configured primary-send count; it does not make uncertain delivery safe to duplicate.

`held` identifies claims with no successful or uncertain delivery: enrollment or rail availability may prevent an attempt, or an attempted send may be definitively refused. It is not proof that no send was attempted. `inFlight`, `railRejected`, and `alreadySubmitted` preserve the other batch outcomes. Acknowledgments count only claims actually acknowledged in that batch, grouped by rail and mode. An empty batch records no acknowledgment; single-rail mode does not manufacture one.

## Manual switching and 835 acceptance

`manualSwitch` changes the payer's primary for later batches. Selecting the current secondary swaps the previous primary into the secondary position. The target must be enrolled for 837, and a non-empty reason is required. The switch log records payer, target, reason, actor, time, and previous primary. The current actor default is `unattributed`; this method/log alone is not evidence of an authorized human decision.

`acceptRemitOn(payerId, railId)` checks 835 enrollment for that exact rail. The standalone `acceptRemit(route, railId)` does likewise when a rail is supplied. Without `railId`, the standalone form accepts when any per-rail entry includes 835 (or the route-wide list does when no per-rail list exists); it cannot prove enrollment on the actual arrival rail without that identity.

## Durability and integration limits

Stored ledger entries are frozen when written, and the switch log returns frozen records. Their Maps/arrays live inside one router instance. Cross-batch suppression is not process-restart durability; persistent claim storage, real transport/status-inquiry wiring, and replay/recovery integration remain separate obligations. The WP-040, WP-056, WP-062, and WP-066 placeholders remain. WP-026's adapter boundary is not changed.

H-20's payer-side deposit sequence discriminator and NR-162/163 posting notes remain unresolved by this router contract. RCM-lead confirmation of WP-092's four gate identifiers also remains pending. This description grants no live-rail, capability, human-policy, database, full/local, or landing approval.
