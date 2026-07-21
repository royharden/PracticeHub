/**
 * Drain orchestration (WP-021, M05). Contract: docs/contracts/event-spine.md
 * (FROZEN). Executes FWD-CAP-QUEUE: the drainer RE-INVOKES `requireCapability`
 * at checkpoint `'drain'` for every claimed event BEFORE its side effect, and
 * drain is authoritative — a kill-switch/rollback that lowered the grant after
 * the event was enqueued parks the event instead of firing it. Enqueue-time
 * checks live with the producing command (`defineCommandHandler`); this is the
 * authoritative second half.
 */

import type { EventEnvelope } from '@practicehub/contracts';
import {
  CapabilityDeniedError,
  requireCapability,
  type CapabilityGrant,
  type CapabilityId,
  type CapabilityRegistry,
  type CapabilityScope,
  type CapabilityState,
} from '@practicehub/platform-core';
import { inboxKey, type DrainAction, type RetryPolicy } from '@practicehub/platform';

import { claimPendingDeliveries, deliverClaimedEvent, type Queryable } from './store.js';

export interface DrainConsumerSpec {
  /** The inbox consumer id — the dedup identity. */
  readonly consumer: string;
  /** The capability whose grant gates this consumer's side effect at drain. */
  readonly capabilityId: CapabilityId;
  /** Grant-state floor; defaults to `simulated` (synthetic/simulator boundary). */
  readonly minimumState?: CapabilityState;
  /** The capability scope to check for an event; defaults to root `{}`. */
  readonly scopeForEvent?: (event: EventEnvelope<unknown>) => CapabilityScope;
  /** The consumer's transactional side effect (runs only when it wins dedup). */
  readonly sideEffect?: (exec: Queryable, event: EventEnvelope<unknown>) => Promise<void>;
}

export interface DrainRequest {
  readonly registry: CapabilityRegistry;
  readonly grants: readonly CapabilityGrant[];
  readonly consumer: DrainConsumerSpec;
  readonly retryPolicy: RetryPolicy;
  readonly limit: number;
  readonly nowIso: string;
}

export interface DrainEventOutcome {
  readonly eventId: string;
  readonly action: DrainAction;
  readonly effected: boolean;
}

export interface DrainReport {
  readonly claimed: number;
  readonly published: number;
  readonly skipped: number;
  readonly parked: number;
  readonly outcomes: readonly DrainEventOutcome[];
}

/**
 * Claim due deliveries and advance each. The capability is re-checked at drain
 * per event; a denial (`CapabilityDeniedError`) parks the event without ever
 * running its side effect. Runs on the caller's tenant-bound transaction (RLS
 * scopes the claim); the caller commits.
 */
export async function drainOnce(exec: Queryable, request: DrainRequest): Promise<DrainReport> {
  const claimedEvents = await claimPendingDeliveries(exec, {
    nowIso: request.nowIso,
    limit: request.limit,
  });
  // Pre-read which of the claimed events this consumer has already processed
  // (a crash between the inbox insert and the delivery mark leaves a processed
  // event still 'pending'); a redelivery then resolves to skip-duplicate.
  const alreadyProcessed = await loadProcessed(
    exec,
    request.consumer.consumer,
    claimedEvents.map((claimed) => claimed.envelope.eventId),
  );

  const outcomes: DrainEventOutcome[] = [];
  let published = 0;
  let skipped = 0;
  let parked = 0;
  const minimumState = request.consumer.minimumState ?? 'simulated';
  for (const claimed of claimedEvents) {
    const scope = request.consumer.scopeForEvent?.(claimed.envelope) ?? {};
    let capabilityAllowed: boolean;
    try {
      requireCapability(
        request.registry,
        request.grants,
        { tenantId: claimed.envelope.tenantId, scope },
        request.consumer.capabilityId,
        { minimumState, checkpoint: 'drain' },
      );
      capabilityAllowed = true;
    } catch (error) {
      if (!(error instanceof CapabilityDeniedError)) {
        throw error;
      }
      capabilityAllowed = false;
    }
    const deliverInput = {
      claimed,
      consumer: request.consumer.consumer,
      capabilityAllowed,
      seen: alreadyProcessed,
      retryPolicy: request.retryPolicy,
      ...(request.consumer.sideEffect !== undefined
        ? { sideEffect: request.consumer.sideEffect }
        : {}),
    };
    const outcome = await deliverClaimedEvent(exec, deliverInput);
    if (outcome.action === 'publish') {
      published += 1;
    } else if (outcome.action === 'skip-duplicate') {
      skipped += 1;
    } else if (outcome.action === 'park-denied') {
      parked += 1;
    }
    outcomes.push({
      eventId: claimed.envelope.eventId,
      action: outcome.action,
      effected: outcome.effected,
    });
  }
  return { claimed: claimedEvents.length, published, skipped, parked, outcomes };
}

async function loadProcessed(
  exec: Queryable,
  consumer: string,
  eventIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const seen = new Set<string>();
  if (eventIds.length === 0) {
    return seen;
  }
  const result = await exec.query(
    `SELECT event_id FROM events.inbox WHERE consumer = $1 AND event_id = ANY($2::text[])`,
    [consumer, eventIds],
  );
  for (const row of result.rows) {
    seen.add(inboxKey(consumer, String(row['event_id'])));
  }
  return seen;
}
