/**
 * Policy/clock governance commands (WP-019). Three AUTHORITY-BEARING writes move
 * under `consent.policy-clocks`, floored at `simulated`:
 *   - recordClockSatisfaction — attesting a legal deadline was met (a scaffolded
 *     tenant must not be able to attest completion);
 *   - publishPolicyDocumentVersion — publishing a counsel-owned policy document
 *     version (review-016 F1);
 *   - publishObligationClockPolicy — publishing a counsel-owned clock-duration
 *     policy version (review-016 F1).
 *
 * WP-019 seeds the capability at `scaffolded` (the package ceiling), so the
 * seeded local grant DENIES every one of these live — the activation walk
 * belongs to the package that takes M03 into the reference loops. Riverbend
 * (disabled) is the standing opposite-state proof. Each command yields the
 * AuthorityDecision (from the gate) AND a config-change audit input (from the
 * domain), so no counsel-registry write escapes an authority decision + audit
 * record.
 *
 * PROTECTIVE/AUTOMATIC clock writes — trigger, escalate, cancel, and the
 * MHRA auto-expire — are NEVER routed here and never capability-gated: a legal
 * clock must always be able to start and a deadline must always be recordable
 * (the audit.emit / consent-protective precedent).
 */

import { defineCommandHandler } from '@practicehub/platform-core';

import {
  publishObligationClockPolicy,
  recordClockSatisfaction,
  type ClockAuditInput,
  type ObligationClock,
  type ObligationClockEvent,
  type ObligationClockPolicy,
  type RulePackClosureEvidence,
} from '../clocks.js';
import {
  publishPolicyDocumentVersion,
  type PolicyDocumentVersion,
  type PolicyGovernanceAuditInput,
} from '../policy-registry.js';

export interface RecordClockSatisfactionCommandInput {
  readonly instance: ObligationClock;
  readonly clockEventId: string;
  readonly occurredAt: string;
  readonly actorRef: string;
  readonly evidenceRef?: string;
  readonly evidenceHash?: string;
  /** Required for a rule-pack-review clock (R6-SR-102 structured evidence). */
  readonly closureEvidence?: RulePackClosureEvidence;
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
      ...(input.evidenceRef !== undefined ? { evidenceRef: input.evidenceRef } : {}),
      ...(input.evidenceHash !== undefined ? { evidenceHash: input.evidenceHash } : {}),
      ...(input.closureEvidence !== undefined ? { closureEvidence: input.closureEvidence } : {}),
    }),
});

export interface PublishPolicyDocumentCommandInput {
  readonly document: PolicyDocumentVersion;
  readonly actorRef: string;
  readonly occurredAt: string;
}

export const publishPolicyDocumentCommand = defineCommandHandler<
  PublishPolicyDocumentCommandInput,
  { readonly version: PolicyDocumentVersion; readonly auditInput: PolicyGovernanceAuditInput }
>({
  capabilityId: 'consent.policy-clocks',
  minimumState: 'simulated',
  handle: (_context, input) =>
    publishPolicyDocumentVersion(input.document, {
      actorRef: input.actorRef,
      occurredAt: input.occurredAt,
    }),
});

export interface PublishObligationClockPolicyCommandInput {
  readonly policy: ObligationClockPolicy;
  readonly actorRef: string;
  readonly occurredAt: string;
}

export const publishObligationClockPolicyCommand = defineCommandHandler<
  PublishObligationClockPolicyCommandInput,
  { readonly policy: ObligationClockPolicy; readonly auditInput: ClockAuditInput }
>({
  capabilityId: 'consent.policy-clocks',
  minimumState: 'simulated',
  handle: (_context, input) =>
    publishObligationClockPolicy(input.policy, {
      actorRef: input.actorRef,
      occurredAt: input.occurredAt,
    }),
});
