/**
 * SLA policy + timer + escalation engine (WP-022, M05). Contract:
 * docs/contracts/workitem-sla-api.md (FROZEN); behavioral seed:
 * docs/contracts/sla-engine-spec.md §5. Architecture: the SLA engine is a
 * NATIVE build (R8-C22 — no OSS drop-in for thread-ownership timers +
 * escalation).
 *
 * Pure, DB-free decision surface: timer due computation, the honest-breach state
 * machine (RSK-02 — timers keep running through outages so a breach is real),
 * and escalation-step firing. SLA policies are effective-dated config data of
 * record; version selection reuses the platform-core effective-dating primitive
 * (FWD-SR-019-TEMPORAL discipline: one temporal model, never a fork — a second
 * effective-dated registry that re-derived the boundary rule would be a defect).
 */

import {
  resolveEffectiveAsOf,
  selectEffectiveVersion,
  type EffectiveDatedVersion,
} from '@practicehub/platform-core';

export class SlaError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SlaError';
  }
}

/** business = pause outside business hours; after_hours = keep running (urgent rail). */
export type SlaHoursMode = 'business' | 'after_hours';

/**
 * first_response starts on an inbound with no pending outbound (the ball is in
 * our court); next_response restarts on each subsequent inbound; resolution is
 * the holding-reply follow-up clock (REQ-TASK-029 A1).
 */
export const slaTimerTypes = ['first_response', 'next_response', 'resolution'] as const;
export type SlaTimerType = (typeof slaTimerTypes)[number];

/** A timer keeps running past its due (honest breach) — `breached` is not terminal. */
export const slaTimerStates = ['running', 'paused', 'breached', 'met'] as const;
export type SlaTimerState = (typeof slaTimerStates)[number];

export const escalationActions = [
  'notify_owner',
  'notify_supervisor',
  'page_oncall',
  'reassign_pool',
  'mark_priority_high',
] as const;
export type EscalationAction = (typeof escalationActions)[number];

export interface EscalationStep {
  /** Fires once this many minutes of ACTIVE (un-paused) time elapse from start. */
  readonly afterMinutes: number;
  readonly action: EscalationAction;
  /** Ref of the escalation target (supervisor/pool/on-call rotation). */
  readonly target: string;
}

/**
 * A per-tier SLA policy version (R8 §5.3). Effective-dated so a policy change is
 * a versioned data event, never a silent retune; the engine enforces whatever
 * the effective version sets.
 */
export interface SlaPolicy extends EffectiveDatedVersion {
  readonly policyId: string;
  readonly version: number;
  readonly effectiveOn: string;
  readonly memberTier: string;
  readonly hoursMode: SlaHoursMode;
  readonly firstResponseTargetMinutes: number;
  readonly nextResponseTargetMinutes: number;
  readonly resolutionTargetMinutes: number | null;
  /** Ordered non-decreasing by afterMinutes; validated at construction. */
  readonly escalationChain: readonly EscalationStep[];
  readonly quietHoursExempt: boolean;
}

/** Timer projection value (folded from the work-item event log). */
export interface SlaTimer {
  readonly timerType: SlaTimerType;
  readonly startedAt: string;
  /** Target deadline from start; accrued pauses push the effective breach point out. */
  readonly dueAt: string;
  readonly pausedTotalSeconds: number;
  readonly state: SlaTimerState;
}

const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function parseInstant(iso: string, label: string): number {
  if (!isoInstantPattern.test(iso)) {
    throw new SlaError(`${label} must be an ISO UTC instant (…Z); received ${JSON.stringify(iso)}`);
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new SlaError(`${label} is not a valid instant: ${JSON.stringify(iso)}`);
  }
  return ms;
}

/** ISO instant `base` shifted by `seconds` (UTC, millisecond-truncated to seconds). */
export function addSeconds(baseIso: string, seconds: number): string {
  const ms = parseInstant(baseIso, 'instant') + Math.round(seconds) * 1000;
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/**
 * Validate a policy's escalation chain: steps ordered non-decreasing by
 * afterMinutes, non-negative thresholds, known actions. A malformed chain is a
 * defect, not silently sorted.
 */
export function assertPolicyValid(policy: SlaPolicy): void {
  if (policy.firstResponseTargetMinutes <= 0 || policy.nextResponseTargetMinutes <= 0) {
    throw new SlaError(`policy ${policy.policyId} response targets must be positive`);
  }
  let previous = -1;
  for (const step of policy.escalationChain) {
    if (step.afterMinutes < 0) {
      throw new SlaError(`policy ${policy.policyId} escalation step afterMinutes must be >= 0`);
    }
    if (step.afterMinutes < previous) {
      throw new SlaError(
        `policy ${policy.policyId} escalation chain must be ordered non-decreasing by afterMinutes`,
      );
    }
    if (!(escalationActions as readonly string[]).includes(step.action)) {
      throw new SlaError(`policy ${policy.policyId} unknown escalation action ${step.action}`);
    }
    previous = step.afterMinutes;
  }
}

/**
 * The effective SLA policy for a tier as-of a date (R8 §5.3 + ADR-ADJ-002
 * effective-dating). Narrows to the tier, then selects the highest version with
 * effectiveOn <= asOf via the shared primitive; `undefined` when none is
 * effective (the caller decides — a work item with no effective policy carries
 * hasSla=false and sorts below SLA-bearing items, REQ-TASK-019 E1).
 */
export function resolveSlaPolicy(
  policies: readonly SlaPolicy[],
  memberTier: string,
  asOf?: string,
): SlaPolicy | undefined {
  const on = resolveEffectiveAsOf(asOf);
  const forTier = policies.filter((policy) => policy.memberTier === memberTier);
  const selected = selectEffectiveVersion(forTier, on);
  if (selected !== undefined) {
    assertPolicyValid(selected);
  }
  return selected;
}

export function targetMinutesFor(policy: SlaPolicy, timerType: SlaTimerType): number | null {
  switch (timerType) {
    case 'first_response':
      return policy.firstResponseTargetMinutes;
    case 'next_response':
      return policy.nextResponseTargetMinutes;
    case 'resolution':
      return policy.resolutionTargetMinutes;
  }
}

/**
 * The due instant for a freshly started timer: startedAt + target minutes. Null
 * target (no resolution target set) throws — the caller must not start a timer a
 * policy does not define.
 */
export function dueAtFor(policy: SlaPolicy, timerType: SlaTimerType, startedAtIso: string): string {
  const minutes = targetMinutesFor(policy, timerType);
  if (minutes === null) {
    throw new SlaError(`policy ${policy.policyId} defines no ${timerType} target`);
  }
  return addSeconds(startedAtIso, minutes * 60);
}

/**
 * The honest-breach state machine (RSK-02). A `met` timer is terminal (a
 * substantive reply stopped it); a `paused` timer's clock does not advance; a
 * running timer breaches once now passes its effective breach point (dueAt
 * pushed out by accrued paused seconds) — and STAYS running/breached, never
 * silently satisfied by an outage.
 */
export function computeTimerState(timer: SlaTimer, nowIso: string): SlaTimerState {
  if (timer.state === 'met') {
    return 'met';
  }
  if (timer.state === 'paused') {
    return 'paused';
  }
  const breachPoint = parseInstant(timer.dueAt, 'dueAt') + timer.pausedTotalSeconds * 1000;
  return parseInstant(nowIso, 'now') >= breachPoint ? 'breached' : 'running';
}

/** Active (un-paused) minutes elapsed since a timer started, as-of now. */
export function activeElapsedMinutes(timer: SlaTimer, nowIso: string): number {
  const elapsedMs =
    parseInstant(nowIso, 'now') -
    parseInstant(timer.startedAt, 'startedAt') -
    timer.pausedTotalSeconds * 1000;
  return Math.max(0, elapsedMs) / 60000;
}

/**
 * Config-change audit input for an SLA policy publication (mirrors the WP-019
 * ClockAuditInput shape). The gated publishSlaPolicy command emits this so no
 * change to the effective-dated policy registry escapes an audit record; the
 * config_ref is grammar-clean (lower-case, no prose).
 */
export interface SlaPolicyAuditInput {
  readonly tenantId: string;
  readonly stream: 'config-change';
  readonly action: 'publish-sla-policy';
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly detail: { readonly config_ref: string };
}

/**
 * Validate an SLA policy version for publication (review-016 F1 precedent:
 * validate-first; the actual row lands as change-controlled seed data via the
 * owner connection — the app role cannot INSERT). Returns the validated policy
 * and its config-change audit input. Throws before producing anything if the
 * policy is malformed (an unauditable/invalid publish never proceeds).
 */
export function publishSlaPolicyVersion(input: {
  readonly tenantId: string;
  readonly policy: SlaPolicy;
  readonly actorRef: string;
  readonly occurredAt: string;
}): { readonly policy: SlaPolicy; readonly auditInput: SlaPolicyAuditInput } {
  assertPolicyValid(input.policy);
  if (!isoInstantPattern.test(input.occurredAt)) {
    throw new SlaError(
      `occurredAt must be an ISO instant; received ${JSON.stringify(input.occurredAt)}`,
    );
  }
  const configRef = `sla-policy:${input.policy.policyId}:v${input.policy.version}`;
  return {
    policy: input.policy,
    auditInput: {
      tenantId: input.tenantId,
      stream: 'config-change',
      action: 'publish-sla-policy',
      actorRef: input.actorRef,
      occurredAt: input.occurredAt,
      detail: { config_ref: configRef },
    },
  };
}

export interface FiredEscalation {
  readonly stepIndex: number;
  readonly step: EscalationStep;
}

/**
 * The escalation steps that have fired for a timer as-of now (R8 §5.5): every
 * chain step whose afterMinutes threshold the active elapsed time has reached,
 * returned in chain order. The William 5h hard-escalation is just the step whose
 * afterMinutes is 300.
 */
export function planEscalation(
  policy: SlaPolicy,
  timer: SlaTimer,
  nowIso: string,
): readonly FiredEscalation[] {
  const elapsed = activeElapsedMinutes(timer, nowIso);
  const fired: FiredEscalation[] = [];
  policy.escalationChain.forEach((step, stepIndex) => {
    if (elapsed >= step.afterMinutes) {
      fired.push({ stepIndex, step });
    }
  });
  return fired;
}
