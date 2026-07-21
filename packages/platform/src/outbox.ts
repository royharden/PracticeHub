/**
 * Transactional-outbox delivery model + drain plan (WP-021; ADR-009 Decision 3).
 * Contract: docs/contracts/event-spine.md (FROZEN).
 *
 * The outbox row (the envelope) is immutable evidence; DELIVERY is a separate
 * mutable projection that the drainer advances. This module is the PURE half:
 * the legal delivery-status transitions, and `planDrainAction` — the decision a
 * drainer makes for one claimed event given (a) its current delivery state,
 * (b) the capability check RE-EVALUATED at drain (FWD-CAP-QUEUE: drain is
 * authoritative, so a kill-switch/rollback that landed after enqueue parks the
 * event instead of firing its side effect), and (c) whether this consumer has
 * already processed the event (inbox dedup). The SKIP-LOCKED claim, the side
 * effect, and the row writes live in the module bound to the `events` schema.
 */

import { type InboxDecision } from './inbox.js';

export const deliveryStatuses = [
  'pending',
  'publishing',
  'published',
  'failed',
  'unknown',
  'dead',
] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

/**
 * Legal delivery-status transitions. `unknown` is the explicit
 * outcome-uncertain state after a side effect whose result was lost to a crash
 * (ADR-009 Decision 3): reconciliation resolves it to `published` (receipt
 * found) or `failed` (no effect), never a silent guess. `dead` is terminal
 * (exhausted retries → a WorkItem, never a silent drop).
 */
const deliveryTransitions: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  pending: ['publishing'],
  publishing: ['published', 'failed', 'unknown'],
  failed: ['publishing', 'dead'],
  unknown: ['published', 'failed'],
  published: [],
  dead: [],
};

export class OutboxError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OutboxError';
  }
}

export function isLegalDeliveryTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return deliveryTransitions[from].includes(to);
}

export interface OutboxDelivery {
  readonly status: DeliveryStatus;
  readonly attempts: number;
}

/**
 * The action a drainer takes for one claimed event.
 * - `park-denied`: capability denied AT DRAIN — leave pending, run NO side
 *   effect (kill-switch/rollback drains safely; FWD-CAP-QUEUE).
 * - `skip-duplicate`: this consumer already processed the event — mark the
 *   delivery published WITHOUT re-running the side effect (exactly-once effect
 *   under at-least-once delivery).
 * - `publish`: run the side effect, record the inbox key, mark published — all
 *   in one transaction.
 * - `noop`: the delivery is already terminal (published/dead) — nothing to do.
 */
export type DrainAction = 'publish' | 'skip-duplicate' | 'park-denied' | 'noop';

export interface DrainInputs {
  readonly delivery: OutboxDelivery;
  /** requireCapability re-evaluated at checkpoint 'drain' (drain authoritative). */
  readonly capabilityAllowed: boolean;
  /** inboxDedupDecision for (consumer, eventId). */
  readonly inbox: InboxDecision;
}

/**
 * Drain decision. Capability is checked FIRST and authoritatively: a denial
 * never runs a side effect regardless of dedup state. Terminal deliveries are a
 * noop. Otherwise a first sighting publishes and a redelivery skips.
 */
export function planDrainAction(inputs: DrainInputs): DrainAction {
  if (inputs.delivery.status === 'published' || inputs.delivery.status === 'dead') {
    return 'noop';
  }
  if (!inputs.capabilityAllowed) {
    return 'park-denied';
  }
  return inputs.inbox === 'skip-duplicate' ? 'skip-duplicate' : 'publish';
}

export interface RetryPolicy {
  /** Attempts (inclusive) after which a failed delivery is dead-lettered. */
  readonly maxAttempts: number;
}

export type FailureAction = 'retry-later' | 'dead-letter';

/**
 * After a failed publish, retry until `maxAttempts` is reached, then
 * dead-letter (a `dead` delivery opens a WorkItem downstream — never a silent
 * drop). `attempts` is the count INCLUDING the attempt that just failed.
 */
export function planFailureAction(delivery: OutboxDelivery, policy: RetryPolicy): FailureAction {
  if (policy.maxAttempts < 1) {
    throw new OutboxError(`retry policy maxAttempts must be >= 1; received ${policy.maxAttempts}`);
  }
  return delivery.attempts >= policy.maxAttempts ? 'dead-letter' : 'retry-later';
}
