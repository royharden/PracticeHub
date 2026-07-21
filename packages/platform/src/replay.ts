/**
 * Replay, recovery epochs, and reconciliation (WP-021; ADR-009 Decision 5).
 * Contract: docs/contracts/event-spine.md (FROZEN). REQ-PLAT-018 (integration
 * idempotency and replay receipt).
 *
 * Three pure pieces the platform reuses:
 * - `replayEquivalent`: rebuilding a projection from its event log must byte-
 *   match the live projection (replay-rebuild equivalence per aggregate).
 * - the RECOVERY-EPOCH FENCE: a restore is fenced by a manifest checkpoint;
 *   replaying events across a restore must never re-fire an effect that already
 *   landed. The fence resolves an already-published or already-consumed effect
 *   to "no resend" — the "no duplicate external send on replay" invariant.
 * - RECONCILIATION HEARTBEAT: silent loss must be detectable. A reconciliation
 *   that observes fewer effects than the expected volume (or does not run at
 *   all) raises an alarm — a dead reconciliation is not a clean night.
 */

import { type DeliveryStatus, type OutboxDelivery } from './outbox.js';

/**
 * Two projections (their canonical serializations) are replay-equivalent iff
 * byte-identical. A single differing byte means the rebuild diverged from the
 * live projection — surfaced, never smoothed over.
 */
export function replayEquivalent(rebuilt: string, live: string): boolean {
  return rebuilt === live;
}

export interface RecoveryEpoch {
  /** Manifest checkpoint that fences the restore (RE-000-class fencing). */
  readonly manifestCheckpoint: string;
}

export type ReplayResendDecision = 'resend-safe' | 'reconciled-no-resend';

/**
 * Recovery-epoch fence: during replay after a restore, an effect that already
 * published, or that the consumer already recorded in its inbox, is NEVER
 * re-sent — the fence resolves it to `reconciled-no-resend`. Only a delivery
 * that has NOT yet produced its effect is `resend-safe`.
 */
export function recoveryFenceDecision(
  delivery: OutboxDelivery,
  alreadyConsumed: boolean,
): ReplayResendDecision {
  if (delivery.status === 'published' || delivery.status === 'dead' || alreadyConsumed) {
    return 'reconciled-no-resend';
  }
  return 'resend-safe';
}

/**
 * Resolve an `unknown` (outcome-uncertain) delivery from reconciliation
 * evidence: a vendor/inbox receipt proves the effect landed (`published`); no
 * receipt means it did not (`failed`, safe to retry). Never guessed.
 */
export function reconcileUnknownDelivery(
  delivery: OutboxDelivery,
  receiptFound: boolean,
): DeliveryStatus {
  if (delivery.status !== 'unknown') {
    throw new Error(
      `reconcileUnknownDelivery only resolves 'unknown' deliveries; received '${delivery.status}'`,
    );
  }
  return receiptFound ? 'published' : 'failed';
}

export interface ReconciliationObservation {
  readonly expectedVolume: number;
  readonly observedVolume: number;
  /** False when the reconciliation job did not run this window at all. */
  readonly ran: boolean;
}

/**
 * Heartbeat alarm: fire when reconciliation did not run, or observed fewer
 * effects than expected (silent loss). Observing MORE than expected also fires
 * (double-processing / duplication). Only an exact match is quiet.
 */
export function reconciliationAlarm(observation: ReconciliationObservation): boolean {
  if (!observation.ran) {
    return true;
  }
  return observation.observedVolume !== observation.expectedVolume;
}
