/**
 * Policy/clock governance command (WP-019). Recording a clock's
 * evidence-of-completion is an AUTHORITY-BEARING attestation (a scaffolded
 * tenant must not be able to attest that a legal deadline was met), so it moves
 * under `consent.policy-clocks`, floored at `simulated`. WP-019 seeds the
 * capability at `scaffolded` (the package ceiling), so the seeded local grant
 * DENIES a live satisfaction — the activation walk belongs to the package that
 * takes M03 into the reference loops. Riverbend (disabled) is the standing
 * opposite-state proof.
 *
 * PROTECTIVE/AUTOMATIC clock writes — trigger, escalate, cancel, and the
 * MHRA auto-expire — are NEVER routed here and never capability-gated: a legal
 * clock must always be able to start and a deadline must always be recordable
 * (the audit.emit / consent-protective precedent).
 */

import { defineCommandHandler } from '@practicehub/platform-core';

import {
  recordClockSatisfaction,
  type ClockAuditInput,
  type ObligationClock,
  type ObligationClockEvent,
} from '../clocks.js';

export interface RecordClockSatisfactionCommandInput {
  readonly instance: ObligationClock;
  readonly clockEventId: string;
  readonly occurredAt: string;
  readonly actorRef: string;
  readonly evidenceRef: string;
  readonly evidenceHash?: string;
}

export const recordClockSatisfactionCommand = defineCommandHandler<
  RecordClockSatisfactionCommandInput,
  {
    readonly event: ObligationClockEvent;
    readonly instance: ObligationClock;
    readonly auditInput: ClockAuditInput;
  }
>({
  capabilityId: 'consent.policy-clocks',
  minimumState: 'simulated',
  handle: (_context, input) =>
    recordClockSatisfaction(input.instance, {
      clockEventId: input.clockEventId,
      occurredAt: input.occurredAt,
      actorRef: input.actorRef,
      evidenceRef: input.evidenceRef,
      ...(input.evidenceHash !== undefined ? { evidenceHash: input.evidenceHash } : {}),
    }),
});
