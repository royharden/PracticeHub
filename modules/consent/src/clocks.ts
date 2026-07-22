/**
 * Obligation-clock engine (WP-019, ADR-007 Decision 4; generalizes C-05:
 * "clocks are obligation × jurisdiction, not one 60-day breach clock").
 * Contract: docs/contracts/clock-api.md (FROZEN §Obligation-clock engine).
 *
 * Legally-clocked duties as event-sourced timers (ADR-009): each clock carries
 * an obligation type, jurisdiction basis, trigger event, due computation, owner,
 * escalation, and evidence-of-completion. `obligation_clock_event` is the
 * append-only log; `obligation_clock` is the projection. Clocks surface as
 * WorkItems (WP-022, FWD-CLOCK-022-WORKITEMS).
 *
 * Two temporal layers, deliberately distinct: POLICY VERSION selection uses the
 * SHARED effective-dating primitive (calendar dates, ADR-ADJ-002 —
 * FWD-SR-019-TEMPORAL); clock DUE computation is timestamp + duration
 * arithmetic. Retention/destruction clocks are NOT here — WP-020 `retention.ts`
 * owns them.
 */

import {
  resolveEffectiveAsOf,
  selectEffectiveVersion,
  type JurisdictionBasis,
} from '@practicehub/platform-core';

import type { ConsentEventInput, ConsentJurisdiction, ConsentScope } from './consent.js';
import type { PolicyStatus } from './policy-registry.js';

export const obligationTypes = [
  'breach-notification',
  'mhra-renewal',
  'records-request-closure',
  'rule-pack-review',
] as const;
export type ObligationType = (typeof obligationTypes)[number];

export const clockEventKinds = [
  'trigger',
  'escalate',
  'satisfy',
  'cancel',
  'expire-fired',
] as const;
export type ClockEventKind = (typeof clockEventKinds)[number];

export const clockStatuses = ['pending', 'escalated', 'overdue', 'satisfied', 'cancelled'] as const;
export type ClockStatus = (typeof clockStatuses)[number];

export type ClockDueBasis = 'duration' | 'anchor';

/**
 * Per obligation type: how the deadline is computed, who owns it, and what
 * evidence closes it. Fixed across jurisdictions; only the durations vary (in
 * the effective-dated policies).
 */
export interface ObligationTypeSpec {
  readonly dueBasis: ClockDueBasis;
  readonly ownerRole: string;
  readonly closureEvidenceKind: string;
}

export const obligationTypeSpecs: Readonly<Record<ObligationType, ObligationTypeSpec>> = {
  // Per-jurisdiction breach clock (FL 30-day class vs HIPAA 60-day floor; C-05).
  'breach-notification': {
    dueBasis: 'duration',
    ownerRole: 'compliance',
    closureEvidenceKind: 'notification-sent',
  },
  // Anchors on the consent's expiresAt (WP-018 ledger); near-expiry renewal
  // worklist + auto-block (R6-SR-041).
  'mhra-renewal': {
    dueBasis: 'anchor',
    ownerRole: 'compliance',
    closureEvidenceKind: 'renewal-recorded',
  },
  // Right-of-access tracked closure (R6-REQ-010); federal 30-day floor.
  'records-request-closure': {
    dueBasis: 'duration',
    ownerRole: 'compliance',
    closureEvidenceKind: 'records-released',
  },
  // Statute-tracker re-derivation (R6-SR-102); periodic quarterly-class cadence.
  'rule-pack-review': {
    dueBasis: 'duration',
    ownerRole: 'compliance',
    closureEvidenceKind: 'rule-pack-bumped',
  },
};

/** The always-unioned floor policy (mirrors the registry's base variant). */
const basePolicyJurisdiction = 'floor';
const epochEffectiveDate = '1970-01-01';

const stateCodePattern = /^[A-Z]{2}$/;
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const refPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const changeRefPattern = /^[a-z0-9][a-z0-9-]{0,127}$/;

export class ClockError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ClockError';
  }
}

function assertIsoTimestamp(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new ClockError(`${label} must be an ISO timestamp; received ${JSON.stringify(value)}`);
  }
}

/** Add whole days to an ISO timestamp (clock due arithmetic; not calendar-date). */
export function addDays(isoTimestamp: string, days: number): string {
  assertIsoTimestamp(isoTimestamp, 'timestamp');
  if (!Number.isInteger(days)) {
    throw new ClockError(`days must be an integer; received ${JSON.stringify(days)}`);
  }
  return new Date(Date.parse(isoTimestamp) + days * 86_400_000).toISOString();
}

// --- Clock policies (counsel-owned, effective-dated) -----------------------

/**
 * One versioned, effective-dated clock-duration policy for an obligation type in
 * a jurisdiction. Counsel-owned change-controlled data (EW-025). `durationDays`
 * is required for `duration`-basis types and absent for `anchor` types (the
 * anchor supplies the due instant); `escalationLeadDays` sets the near-deadline
 * worklist point for both.
 */
export interface ObligationClockPolicy {
  readonly obligationType: ObligationType;
  /** Two-letter state code or `floor` (unioned into every resolution). */
  readonly jurisdiction: string;
  readonly version: number;
  readonly effectiveOn: string;
  readonly status: PolicyStatus;
  readonly counselSignoffRef?: string;
  readonly changeControlRef: string;
  /** Required for `duration`-basis types; omitted for `anchor` types. */
  readonly durationDays?: number;
  readonly escalationLeadDays: number;
  readonly sourceRef: string;
  readonly synthetic: true;
}

function isObligationType(value: string): value is ObligationType {
  return (obligationTypes as readonly string[]).includes(value);
}

export function assertObligationClockPolicyWellFormed(policy: ObligationClockPolicy): void {
  const label = `${policy.obligationType}/${policy.jurisdiction} v${policy.version}`;
  if (!isObligationType(policy.obligationType)) {
    throw new ClockError(`policy ${label}: unknown obligation type`);
  }
  if (
    !stateCodePattern.test(policy.jurisdiction) &&
    policy.jurisdiction !== basePolicyJurisdiction
  ) {
    throw new ClockError(
      `policy ${label}: jurisdiction must be a two-letter state code or '${basePolicyJurisdiction}'`,
    );
  }
  if (!Number.isInteger(policy.version) || policy.version < 1) {
    throw new ClockError(`policy ${label}: version must be a positive integer`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(policy.effectiveOn)) {
    throw new ClockError(`policy ${label}: effectiveOn must be a calendar date (YYYY-MM-DD)`);
  }
  if (!changeRefPattern.test(policy.changeControlRef)) {
    throw new ClockError(`policy ${label}: requires a change-control reference (fails closed)`);
  }
  if (policy.status === 'counsel-signed' && !policy.counselSignoffRef) {
    throw new ClockError(`policy ${label}: counsel-signed status requires a sign-off reference`);
  }
  const spec = obligationTypeSpecs[policy.obligationType];
  if (
    spec.dueBasis === 'duration' &&
    (!Number.isFinite(policy.durationDays) || (policy.durationDays ?? 0) < 1)
  ) {
    throw new ClockError(`policy ${label}: a duration-basis obligation requires durationDays >= 1`);
  }
  if (spec.dueBasis === 'anchor' && policy.durationDays !== undefined) {
    throw new ClockError(`policy ${label}: an anchor-basis obligation carries no durationDays`);
  }
  if (!Number.isInteger(policy.escalationLeadDays) || policy.escalationLeadDays < 0) {
    throw new ClockError(`policy ${label}: escalationLeadDays must be a non-negative integer`);
  }
  if (!policy.sourceRef.trim()) {
    throw new ClockError(`policy ${label}: sourceRef is required`);
  }
  if (policy.synthetic !== true) {
    throw new ClockError(`policy ${label}: missing the synthetic watermark`);
  }
}

/**
 * Validate the policy registry: every policy well-formed, no duplicate
 * (obligationType, jurisdiction, version), and every obligation type carries a
 * `floor` policy whose earliest version is the epoch sentinel — the federal
 * fail-closed floor is always effective (a jurisdiction with no pack resolves to
 * it, never to a permissive gap).
 */
export function assertObligationClockPolicyRegistryWellFormed(
  policies: readonly ObligationClockPolicy[],
): void {
  const seen = new Set<string>();
  for (const policy of policies) {
    assertObligationClockPolicyWellFormed(policy);
    const key = `${policy.obligationType}|${policy.jurisdiction}@${policy.version}`;
    if (seen.has(key)) {
      throw new ClockError(`duplicate clock policy ${key}`);
    }
    seen.add(key);
  }
  for (const obligationType of obligationTypes) {
    const floorVersions = policies.filter(
      (policy) =>
        policy.obligationType === obligationType && policy.jurisdiction === basePolicyJurisdiction,
    );
    if (floorVersions.length === 0) {
      throw new ClockError(
        `registry is missing the floor policy for ${obligationType} (fail-closed)`,
      );
    }
    const earliest = [...floorVersions].sort((left, right) => left.version - right.version)[0];
    if (earliest !== undefined && earliest.effectiveOn !== epochEffectiveDate) {
      throw new ClockError(
        `${obligationType} floor v${earliest.version}: the earliest floor policy must carry the ` +
          `epoch sentinel ${epochEffectiveDate} (always-effective floor)`,
      );
    }
  }
}

export interface ClockPolicyContribution {
  readonly fact: 'provider' | 'patient' | 'floor';
  readonly jurisdiction: string;
  readonly version: number;
  readonly effectiveOn: string;
  readonly status: PolicyStatus;
  readonly durationDays?: number;
  readonly escalationLeadDays: number;
  readonly defaultsApplied: boolean;
}

export interface ClockPolicyResolution {
  readonly obligationType: ObligationType;
  readonly dueBasis: ClockDueBasis;
  readonly ownerRole: string;
  readonly closureEvidenceKind: string;
  readonly asOf: string;
  /** Strictest (shortest) duration across contributions; undefined for anchor types. */
  readonly durationDays?: number;
  /** Strictest (shortest) escalation lead across contributions. */
  readonly escalationLeadDays: number;
  readonly contributions: readonly ClockPolicyContribution[];
  readonly defaultsApplied: boolean;
  readonly counselReviewPending: boolean;
}

function policyContribution(
  policies: readonly ObligationClockPolicy[],
  obligationType: ObligationType,
  fact: 'provider' | 'patient' | 'floor',
  state: string | null,
  asOf: string,
): ClockPolicyContribution {
  let jurisdiction: string;
  let defaultsApplied = false;
  if (fact === 'floor') {
    jurisdiction = basePolicyJurisdiction;
  } else if (state === null) {
    jurisdiction = basePolicyJurisdiction;
    defaultsApplied = true;
  } else if (!stateCodePattern.test(state)) {
    throw new ClockError(
      `${fact} state must be a two-letter state code or null; received ${JSON.stringify(state)}`,
    );
  } else {
    const forState = policies.filter(
      (policy) => policy.obligationType === obligationType && policy.jurisdiction === state,
    );
    if (selectEffectiveVersion(forState, asOf) === undefined) {
      // No pack, or none effective as-of the query — fall to the floor (the
      // federal fail-closed clock), the same route either way.
      jurisdiction = basePolicyJurisdiction;
      defaultsApplied = true;
    } else {
      jurisdiction = state;
    }
  }
  const selected = selectEffectiveVersion(
    policies.filter(
      (policy) => policy.obligationType === obligationType && policy.jurisdiction === jurisdiction,
    ),
    asOf,
  );
  if (selected === undefined) {
    throw new ClockError(
      `registry has no effective '${jurisdiction}' policy for ${obligationType} as-of ${asOf} (fail-closed)`,
    );
  }
  return {
    fact,
    jurisdiction,
    version: selected.version,
    effectiveOn: selected.effectiveOn,
    status: selected.status,
    ...(selected.durationDays !== undefined ? { durationDays: selected.durationDays } : {}),
    escalationLeadDays: selected.escalationLeadDays,
    defaultsApplied,
  };
}

/**
 * Resolve the effective clock policy for an obligation type over a jurisdiction
 * basis (C-05 obligation × jurisdiction). Strictest-law cascade like the
 * jurisdiction resolver: union provider + patient + floor and take the SHORTEST
 * deadline (a shorter statutory clock is stricter). Unknown/unpacked facts fall
 * to the floor (fail-closed — the federal floor), never a permissive gap.
 */
export function resolveObligationClockPolicy(
  policies: readonly ObligationClockPolicy[],
  obligationType: ObligationType,
  basis: JurisdictionBasis,
  asOf?: string,
): ClockPolicyResolution {
  if (!isObligationType(obligationType)) {
    throw new ClockError(`unknown obligation type ${JSON.stringify(obligationType)}`);
  }
  assertObligationClockPolicyRegistryWellFormed(policies);
  const resolvedAsOf = resolveEffectiveAsOf(asOf);
  const spec = obligationTypeSpecs[obligationType];
  const contributions = [
    policyContribution(policies, obligationType, 'provider', basis.providerState, resolvedAsOf),
    policyContribution(policies, obligationType, 'patient', basis.patientState, resolvedAsOf),
    policyContribution(policies, obligationType, 'floor', null, resolvedAsOf),
  ];
  const durations = contributions
    .map((contribution) => contribution.durationDays)
    .filter((value): value is number => value !== undefined);
  const escalationLeadDays = Math.min(...contributions.map((c) => c.escalationLeadDays));
  return {
    obligationType,
    dueBasis: spec.dueBasis,
    ownerRole: spec.ownerRole,
    closureEvidenceKind: spec.closureEvidenceKind,
    asOf: resolvedAsOf,
    ...(durations.length > 0 ? { durationDays: Math.min(...durations) } : {}),
    escalationLeadDays,
    contributions,
    defaultsApplied: contributions.some((contribution) => contribution.defaultsApplied),
    counselReviewPending: contributions.some(
      (contribution) => contribution.status !== 'counsel-signed',
    ),
  };
}

// --- Clock instances (event-sourced) ---------------------------------------

export interface ObligationClockEvent {
  readonly tenantId: string;
  readonly clockEventId: string;
  readonly clockId: string;
  readonly obligationType: ObligationType;
  readonly kind: ClockEventKind;
  readonly subjectRef: string;
  readonly occurredAt: string;
  readonly dueAt?: string;
  readonly evidenceRef?: string;
  readonly evidenceHash?: string;
  readonly actorRef: string;
  readonly reason?: string;
  readonly synthetic: true;
}

export interface ObligationClock {
  readonly tenantId: string;
  readonly clockId: string;
  readonly obligationType: ObligationType;
  readonly subjectRef: string;
  readonly triggerRef: string;
  readonly triggeredAt: string;
  readonly dueAt: string;
  readonly escalateAt: string;
  readonly status: ClockStatus;
  readonly ownerRole: string;
  readonly closureEvidenceRef?: string;
  readonly lastEventId: string;
  readonly synthetic: true;
}

export interface TriggerClockInput {
  readonly tenantId: string;
  readonly clockId: string;
  readonly clockEventId: string;
  readonly obligationType: ObligationType;
  readonly subjectRef: string;
  readonly triggerRef: string;
  readonly triggeredAt: string;
  readonly actorRef: string;
  /** Jurisdiction basis for duration-basis policy resolution. */
  readonly basis: JurisdictionBasis;
  /** Required for anchor-basis obligations (mhra-renewal = consent expiresAt). */
  readonly anchorDueAt?: string;
  readonly policies: readonly ObligationClockPolicy[];
}

/**
 * Start a clock (PROTECTIVE — never capability-gated; a legal clock must always
 * be able to start). Computes `dueAt` from the resolved duration policy or the
 * supplied anchor, and `escalateAt = dueAt − escalationLeadDays`. Emits a
 * `trigger` event and the initial projection row (status `pending`).
 */
export function triggerClock(input: TriggerClockInput): {
  readonly event: ObligationClockEvent;
  readonly instance: ObligationClock;
  readonly resolution: ClockPolicyResolution;
} {
  if (!idPattern.test(input.clockId)) {
    throw new ClockError(`clockId ${JSON.stringify(input.clockId)} is malformed`);
  }
  if (!idPattern.test(input.clockEventId)) {
    throw new ClockError(`clockEventId ${JSON.stringify(input.clockEventId)} is malformed`);
  }
  if (!refPattern.test(input.subjectRef)) {
    throw new ClockError(`subjectRef ${JSON.stringify(input.subjectRef)} is malformed`);
  }
  if (!refPattern.test(input.triggerRef)) {
    throw new ClockError(`triggerRef ${JSON.stringify(input.triggerRef)} is malformed`);
  }
  assertIsoTimestamp(input.triggeredAt, 'triggeredAt');
  const resolution = resolveObligationClockPolicy(
    input.policies,
    input.obligationType,
    input.basis,
    input.triggeredAt.slice(0, 10),
  );

  let dueAt: string;
  if (resolution.dueBasis === 'duration') {
    if (resolution.durationDays === undefined) {
      throw new ClockError(`duration-basis ${input.obligationType} resolved no durationDays`);
    }
    dueAt = addDays(input.triggeredAt, resolution.durationDays);
  } else {
    if (input.anchorDueAt === undefined) {
      throw new ClockError(
        `anchor-basis ${input.obligationType} requires anchorDueAt (e.g. the consent expiresAt)`,
      );
    }
    assertIsoTimestamp(input.anchorDueAt, 'anchorDueAt');
    dueAt = input.anchorDueAt;
  }
  const escalateAt = addDays(dueAt, -resolution.escalationLeadDays);
  const event: ObligationClockEvent = {
    tenantId: input.tenantId,
    clockEventId: input.clockEventId,
    clockId: input.clockId,
    obligationType: input.obligationType,
    kind: 'trigger',
    subjectRef: input.subjectRef,
    occurredAt: input.triggeredAt,
    dueAt,
    actorRef: input.actorRef,
    synthetic: true,
  };
  const instance: ObligationClock = {
    tenantId: input.tenantId,
    clockId: input.clockId,
    obligationType: input.obligationType,
    subjectRef: input.subjectRef,
    triggerRef: input.triggerRef,
    triggeredAt: input.triggeredAt,
    dueAt,
    escalateAt,
    status: 'pending',
    ownerRole: resolution.ownerRole,
    lastEventId: input.clockEventId,
    synthetic: true,
  };
  return { event, instance, resolution };
}

/**
 * Pure status as-of an instant: `satisfied`/`cancelled` are terminal; else
 * `overdue` once the deadline passes, `escalated` once the near-deadline
 * worklist point passes, else `pending`.
 */
export function computeClockStatus(
  instance: Pick<ObligationClock, 'status' | 'dueAt' | 'escalateAt'>,
  asOf: string,
): ClockStatus {
  assertIsoTimestamp(asOf, 'asOf');
  if (instance.status === 'satisfied' || instance.status === 'cancelled') {
    return instance.status;
  }
  const asOfMs = Date.parse(asOf);
  if (asOfMs >= Date.parse(instance.dueAt)) {
    return 'overdue';
  }
  if (asOfMs >= Date.parse(instance.escalateAt)) {
    return 'escalated';
  }
  return 'pending';
}

function clockEvent(
  instance: ObligationClock,
  kind: ClockEventKind,
  fields: {
    readonly clockEventId: string;
    readonly occurredAt: string;
    readonly actorRef: string;
    readonly evidenceRef?: string;
    readonly evidenceHash?: string;
    readonly reason?: string;
  },
): ObligationClockEvent {
  if (!idPattern.test(fields.clockEventId)) {
    throw new ClockError(`clockEventId ${JSON.stringify(fields.clockEventId)} is malformed`);
  }
  assertIsoTimestamp(fields.occurredAt, 'occurredAt');
  return {
    tenantId: instance.tenantId,
    clockEventId: fields.clockEventId,
    clockId: instance.clockId,
    obligationType: instance.obligationType,
    kind,
    subjectRef: instance.subjectRef,
    occurredAt: fields.occurredAt,
    ...(fields.evidenceRef !== undefined ? { evidenceRef: fields.evidenceRef } : {}),
    ...(fields.evidenceHash !== undefined ? { evidenceHash: fields.evidenceHash } : {}),
    actorRef: fields.actorRef,
    ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
    synthetic: true,
  };
}

/** Escalate (PROTECTIVE — a near-deadline worklist entry must always land). */
export function escalateClock(
  instance: ObligationClock,
  fields: { readonly clockEventId: string; readonly occurredAt: string; readonly actorRef: string },
): { readonly event: ObligationClockEvent; readonly instance: ObligationClock } {
  const event = clockEvent(instance, 'escalate', fields);
  return {
    event,
    instance: { ...instance, status: 'escalated', lastEventId: fields.clockEventId },
  };
}

/** Config-change audit input for governance clock actions (R6-REQ-006/052 trail). */
export interface ClockAuditInput {
  readonly tenantId: string;
  readonly stream: 'config-change';
  readonly action: string;
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly correlationRef: string;
  readonly detail: Readonly<Record<string, string>>;
  readonly synthetic: true;
}

/** The audit chain is whole-second UTC (audit-emit.md); truncate sub-second. */
function toAuditInstant(occurredAt: string): string {
  assertIsoTimestamp(occurredAt, 'occurredAt');
  return `${new Date(Date.parse(occurredAt)).toISOString().slice(0, 19)}Z`;
}

function clockAudit(
  instance: ObligationClock,
  action: string,
  actorRef: string,
  occurredAt: string,
  extra: Readonly<Record<string, string>>,
): ClockAuditInput {
  return {
    tenantId: instance.tenantId,
    stream: 'config-change',
    action,
    actorRef,
    occurredAt: toAuditInstant(occurredAt),
    correlationRef: instance.clockId,
    detail: {
      config_ref: `clock:${instance.clockId}`,
      obligation_type: instance.obligationType,
      ...extra,
    },
    synthetic: true,
  };
}

/**
 * Record evidence-of-completion — AUTHORITY-BEARING (the `consent.policy-clocks`
 * gated command routes here). Evidence is mandatory; the satisfy event closes
 * the clock and yields a config-change audit input.
 */
export function recordClockSatisfaction(
  instance: ObligationClock,
  fields: {
    readonly clockEventId: string;
    readonly occurredAt: string;
    readonly actorRef: string;
    readonly evidenceRef: string;
    readonly evidenceHash?: string;
  },
): {
  readonly event: ObligationClockEvent;
  readonly instance: ObligationClock;
  readonly auditInput: ClockAuditInput;
} {
  if (instance.status === 'satisfied' || instance.status === 'cancelled') {
    throw new ClockError(`clock ${instance.clockId} is already ${instance.status}`);
  }
  if (!refPattern.test(fields.evidenceRef)) {
    throw new ClockError('recordClockSatisfaction requires evidence-of-completion (evidenceRef)');
  }
  if (fields.evidenceHash !== undefined && !hashPattern.test(fields.evidenceHash)) {
    throw new ClockError('evidenceHash must be a sha-256 hex digest');
  }
  const event = clockEvent(instance, 'satisfy', fields);
  return {
    event,
    instance: {
      ...instance,
      status: 'satisfied',
      closureEvidenceRef: fields.evidenceRef,
      lastEventId: fields.clockEventId,
    },
    auditInput: clockAudit(
      instance,
      'obligation-clock-satisfied',
      fields.actorRef,
      fields.occurredAt,
      {
        evidence_ref: fields.evidenceRef,
      },
    ),
  };
}

/**
 * Cancel a clock whose obligation is mooted (a records request withdrawn, a
 * consent revoked cancelling its renewal clock). PROTECTIVE + reasoned; audited.
 */
export function cancelClock(
  instance: ObligationClock,
  fields: {
    readonly clockEventId: string;
    readonly occurredAt: string;
    readonly actorRef: string;
    readonly reason: string;
  },
): {
  readonly event: ObligationClockEvent;
  readonly instance: ObligationClock;
  readonly auditInput: ClockAuditInput;
} {
  if (instance.status === 'satisfied' || instance.status === 'cancelled') {
    throw new ClockError(`clock ${instance.clockId} is already ${instance.status}`);
  }
  if (!fields.reason.trim()) {
    throw new ClockError('a clock cancellation requires a reason (the obligation is mooted)');
  }
  const event = clockEvent(instance, 'cancel', fields);
  // The prose cancellation reason lives on the clock EVENT (event.reason); the
  // audit detail is grammar-checked refs only (audit-emit.md), so it records the
  // action + clock pointer, never the prose.
  return {
    event,
    instance: { ...instance, status: 'cancelled', lastEventId: fields.clockEventId },
    auditInput: clockAudit(
      instance,
      'obligation-clock-cancelled',
      fields.actorRef,
      fields.occurredAt,
      {},
    ),
  };
}

// --- WorkItem surfaces (WP-022) --------------------------------------------

export interface ClockWorkItem {
  readonly obligationType: ObligationType;
  readonly clockId: string;
  readonly subjectRef: string;
  readonly ownerRole: string;
  readonly dueAt: string;
  readonly status: ClockStatus;
  readonly directive: string;
}

const workItemDirectives: Readonly<Record<ObligationType, string>> = {
  'breach-notification': 'complete regulatory breach notification before the deadline',
  'mhra-renewal': 'obtain a renewal of the records-disclosure consent before expiry',
  'records-request-closure': 'release the requested records before the access deadline',
  'rule-pack-review': 're-derive statutes and bump the affected jurisdiction rule-pack versions',
};

/**
 * The WorkItem an escalated/overdue clock surfaces (WP-022 consumes; ADR-007 D4
 * "surfaced as WorkItems"). Every obligation clock renders through here.
 */
export function clockWorkItem(instance: ObligationClock, asOf: string): ClockWorkItem {
  return {
    obligationType: instance.obligationType,
    clockId: instance.clockId,
    subjectRef: instance.subjectRef,
    ownerRole: instance.ownerRole,
    dueAt: instance.dueAt,
    status: computeClockStatus(instance, asOf),
    directive: workItemDirectives[instance.obligationType],
  };
}

export interface RulePackReviewWorkItem extends ClockWorkItem {
  readonly obligationType: 'rule-pack-review';
  /** The rule-pack scope counsel must re-derive (the trigger names it). */
  readonly rulePackScopeRef: string;
}

/**
 * The rule-pack-review WorkItem class (R6-SR-102; FWD-SR-102-TRACKER): the
 * statute-tracker obligation directs counsel to re-derive statutes and bump the
 * WP-011 rule packs; the truth-table harness is the regression gate for every
 * re-derivation. `subjectRef` names the affected rule-pack scope.
 */
export function rulePackReviewWorkItem(
  instance: ObligationClock,
  asOf: string,
): RulePackReviewWorkItem {
  if (instance.obligationType !== 'rule-pack-review') {
    throw new ClockError(
      `rulePackReviewWorkItem is only for rule-pack-review clocks; got ${instance.obligationType}`,
    );
  }
  return {
    ...clockWorkItem(instance, asOf),
    obligationType: 'rule-pack-review',
    rulePackScopeRef: instance.subjectRef,
  };
}

// --- MHRA renewal auto-expire (R6-SR-041; FWD-CONSENT-019-RENEWAL) ----------

export interface RenewalExpiryInput {
  readonly instance: ObligationClock;
  readonly asOf: string;
  /** Whether a renewal was recorded (the clock is satisfied) — no auto-fire then. */
  readonly renewalRecorded: boolean;
  /** The consent context whose expire event fires when the renewal window lapses. */
  readonly personRef: string;
  readonly scope: ConsentScope;
  readonly jurisdiction: ConsentJurisdiction;
  readonly policyVersion: string;
  readonly expireEventId: string;
  readonly expireClockEventId: string;
  readonly actorRef: string;
}

export type RenewalExpiryOutcome =
  | { readonly fired: false; readonly reason: 'not-yet-due' | 'renewal-recorded' }
  | {
      readonly fired: true;
      /** The consent `expire` event to append (SAME module — no cross-module write). */
      readonly consentExpireEvent: ConsentEventInput;
      readonly clockEvent: ObligationClockEvent;
    };

/**
 * Run the MHRA renewal clock at `asOf` (R6-SR-041 auto-block). A recorded
 * renewal before the due instant cancels the auto-fire; otherwise, once the
 * consent's expiry (the anchor `dueAt`) passes, the clock AUTO-FIRES the consent
 * `expire` event input and an `expire-fired` clock event. The caller appends the
 * consent event via `appendConsentEvent`. MHRA expiry blocks third-party
 * disclosure only, never the patient's own access (ADR-007 C-06).
 */
export function runRenewalExpiry(input: RenewalExpiryInput): RenewalExpiryOutcome {
  const { instance } = input;
  if (instance.obligationType !== 'mhra-renewal') {
    throw new ClockError(
      `runRenewalExpiry is only for mhra-renewal clocks; got ${instance.obligationType}`,
    );
  }
  assertIsoTimestamp(input.asOf, 'asOf');
  if (input.renewalRecorded || instance.status === 'satisfied') {
    return { fired: false, reason: 'renewal-recorded' };
  }
  if (Date.parse(input.asOf) < Date.parse(instance.dueAt)) {
    return { fired: false, reason: 'not-yet-due' };
  }
  if (input.scope.type !== 'disclosure') {
    throw new ClockError('an MHRA renewal clock governs a disclosure-scope consent');
  }
  const consentExpireEvent: ConsentEventInput = {
    consentEventId: input.expireEventId,
    tenantId: instance.tenantId,
    personRef: input.personRef,
    scope: input.scope,
    action: 'expire',
    effectiveAt: instance.dueAt,
    source: 'staff_entry',
    jurisdiction: input.jurisdiction,
    policyVersion: input.policyVersion,
    synthetic: true,
  };
  const clockEventRecord = clockEvent(instance, 'expire-fired', {
    clockEventId: input.expireClockEventId,
    occurredAt: input.asOf,
    actorRef: input.actorRef,
    reason: 'renewal window lapsed — consent auto-expired (R6-SR-041)',
  });
  return { fired: true, consentExpireEvent, clockEvent: clockEventRecord };
}

/**
 * Fold a clock event log into projections — one row per clock, carrying the
 * latest event's derived status. A pure function of the log (the DB projection
 * equals this; drift-tested). Terminal statuses (satisfied/cancelled) win over
 * later time-derived ones.
 */
export function foldClocks(
  events: readonly ObligationClockEvent[],
  triggers: readonly ObligationClock[],
): Map<string, ObligationClock> {
  const byClock = new Map<string, ObligationClock>();
  for (const instance of triggers) {
    byClock.set(`${instance.tenantId}|${instance.clockId}`, instance);
  }
  for (const event of events) {
    const key = `${event.tenantId}|${event.clockId}`;
    const current = byClock.get(key);
    if (current === undefined) {
      continue;
    }
    if (event.kind === 'escalate' && current.status === 'pending') {
      byClock.set(key, { ...current, status: 'escalated', lastEventId: event.clockEventId });
    } else if (event.kind === 'satisfy') {
      byClock.set(key, {
        ...current,
        status: 'satisfied',
        ...(event.evidenceRef !== undefined ? { closureEvidenceRef: event.evidenceRef } : {}),
        lastEventId: event.clockEventId,
      });
    } else if (event.kind === 'cancel') {
      byClock.set(key, { ...current, status: 'cancelled', lastEventId: event.clockEventId });
    }
  }
  return byClock;
}
