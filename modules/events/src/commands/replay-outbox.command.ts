/**
 * Event-spine governance command (WP-021). REPLAY is an authority-bearing
 * platform operation — re-driving a delivery can re-trigger an external effect —
 * so it moves under `platform.event-spine`, floored at `simulated`. WP-021 seeds
 * the capability at `scaffolded` (the package ceiling), so the seeded local
 * grant DENIES a live replay; the activation walk belongs to the package that
 * takes the spine into the reference loops. Riverbend (disabled) is the standing
 * opposite-state proof.
 *
 * The handler is pure: it returns the recovery-epoch fence decision, which never
 * re-sends an effect that already published or was already consumed — replay is
 * safe by construction, and gating governs WHO may initiate it. Automatic
 * draining (`drainOnce`) re-checks each event's OWN consumer capability at drain
 * (FWD-CAP-QUEUE) and is not routed through this command.
 */

import { defineCommandHandler } from '@practicehub/platform-core';
import {
  recoveryFenceDecision,
  type OutboxDelivery,
  type ReplayResendDecision,
} from '@practicehub/platform';

export interface ReplayOutboxCommandInput {
  readonly delivery: OutboxDelivery;
  /** Whether the target consumer already recorded this event in its inbox. */
  readonly alreadyConsumed: boolean;
}

export const replayOutboxCommand = defineCommandHandler<
  ReplayOutboxCommandInput,
  ReplayResendDecision
>({
  capabilityId: 'platform.event-spine',
  minimumState: 'simulated',
  handle: (_context, input) => recoveryFenceDecision(input.delivery, input.alreadyConsumed),
});
