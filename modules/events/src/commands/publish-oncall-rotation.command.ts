/**
 * On-call rotation governance command (WP-023). Publishing a version of the
 * effective-dated on-call rotation registry is AUTHORITY-BEARING (a scaffolded
 * tenant must not silently retune who provides 24/7 on-call coverage), so it moves
 * under `platform.tasking-engine` — the WP-022 capability, floored `simulated`.
 * WP-022 seeds the capability at `scaffolded` (the package ceiling), so the seeded
 * local grant DENIES a live publish; Riverbend (disabled) is the standing
 * opposite-state proof. No new capability is minted — WP-023 stays at the
 * tasking-engine ceiling.
 *
 * The command yields the AuthorityDecision (from the gate) AND a config-change
 * audit input (from the domain), so no rotation-registry write escapes an
 * authority decision + audit record. The row itself lands as change-controlled
 * seed data via the owner connection (the registry is runtime read-only for the
 * app role, REVOKE INSERT — DB-proven).
 *
 * OPERATIONAL coverage writes — slot vacate, gap-alert emission, coverage
 * reassignment, handoff records — are NEVER routed here and never
 * capability-gated: on-call coverage and the safety escalations that depend on it
 * must always fire (the WP-022 timer / consent-protective precedent).
 */

import { defineCommandHandler } from '@practicehub/platform-core';

import {
  publishOnCallRotationVersion,
  type OnCallRotation,
  type OnCallRotationAuditInput,
} from '../oncall.js';

export interface PublishOnCallRotationCommandInput {
  readonly tenantId: string;
  readonly rotation: OnCallRotation;
  readonly actorRef: string;
  readonly occurredAt: string;
}

export const publishOnCallRotationCommand = defineCommandHandler<
  PublishOnCallRotationCommandInput,
  { readonly rotation: OnCallRotation; readonly auditInput: OnCallRotationAuditInput }
>({
  capabilityId: 'platform.tasking-engine',
  minimumState: 'simulated',
  handle: (_context, input) =>
    publishOnCallRotationVersion({
      tenantId: input.tenantId,
      rotation: input.rotation,
      actorRef: input.actorRef,
      occurredAt: input.occurredAt,
    }),
});
