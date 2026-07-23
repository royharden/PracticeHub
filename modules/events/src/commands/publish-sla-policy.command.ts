/**
 * SLA-policy governance command (WP-022). Publishing a version of the
 * effective-dated SLA policy registry is AUTHORITY-BEARING (a scaffolded tenant
 * must not be able to retune the response targets and escalation chain that
 * govern every accountable thread), so it moves under `platform.tasking-engine`,
 * floored at `simulated`. WP-022 seeds the capability at `scaffolded` (the
 * package ceiling), so the seeded local grant DENIES a live publish — the
 * activation walk belongs to the package that takes M05 into the reference
 * loops. Riverbend (disabled) is the standing opposite-state proof.
 *
 * The command yields the AuthorityDecision (from the gate) AND a config-change
 * audit input (from the domain), so no SLA-registry write escapes an authority
 * decision + audit record. The row itself lands as change-controlled seed data
 * via the owner connection (the registry is runtime read-only for the app role,
 * REVOKE INSERT — DB-proven).
 *
 * OPERATIONAL tasking writes — open, claim, reassign, holding-reply, the timer
 * lifecycle, and escalation firing — are NEVER routed here and never
 * capability-gated: a timer must keep running (honest breach, RSK-02) and an
 * escalation on a stale owned thread must always fire (the audit.emit /
 * consent-protective precedent).
 */

import { defineCommandHandler } from '@practicehub/platform-core';

import { publishSlaPolicyVersion, type SlaPolicy, type SlaPolicyAuditInput } from '../sla.js';

export interface PublishSlaPolicyCommandInput {
  readonly tenantId: string;
  readonly policy: SlaPolicy;
  readonly actorRef: string;
  readonly occurredAt: string;
}

export const publishSlaPolicyCommand = defineCommandHandler<
  PublishSlaPolicyCommandInput,
  { readonly policy: SlaPolicy; readonly auditInput: SlaPolicyAuditInput }
>({
  capabilityId: 'platform.tasking-engine',
  minimumState: 'simulated',
  handle: (_context, input) =>
    publishSlaPolicyVersion({
      tenantId: input.tenantId,
      policy: input.policy,
      actorRef: input.actorRef,
      occurredAt: input.occurredAt,
    }),
});
