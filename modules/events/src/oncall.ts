/**
 * On-call schedule domain (WP-023, M05). Contract:
 * docs/contracts/oncall-coverage-api.md (FROZEN); behavioral seed
 * docs/contracts/sla-engine-spec.md §5.4 (after-hours on-call paging) + §5.6
 * (coverage). Requirements: REQ-ADM-016 (provisioned 24/7 on-call escalation
 * chain), REQ-ADM-041 (rotations, overrides, gap alerting), REQ-ADM-015 (skip an
 * on-call provider outside service scope).
 *
 * Pure, DB-free decision surface: resolve the currently on-call owner for a scope
 * at an instant (overrides win; a provider outside the required service scope is
 * skipped), detect coverage gaps over a window (a 24/7 rotation with any gap is a
 * provisioning defect), and validate/publish an effective-dated rotation version.
 * On-call rotations are effective-dated config data of record; version selection
 * reuses the platform-core effective-dating primitive (FWD-SR-019-TEMPORAL: one
 * temporal model, never a fork).
 */

import {
  resolveEffectiveAsOf,
  selectEffectiveVersion,
  type EffectiveDatedVersion,
} from '@practicehub/platform-core';

export class OnCallError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'OnCallError';
  }
}

/** 24x7 = the urgent rail (a gap is an alert); business = business-hours cover only. */
export const coverageModes = ['24x7', 'business'] as const;
export type CoverageMode = (typeof coverageModes)[number];

export const onCallSlotKinds = ['rotation', 'override'] as const;
export type OnCallSlotKind = (typeof onCallSlotKinds)[number];

export const onCallSlotStatuses = ['scheduled', 'overridden', 'vacated'] as const;
export type OnCallSlotStatus = (typeof onCallSlotStatuses)[number];

/** A member in the provisioned rotation with the service scopes they cover. */
export interface OnCallMember {
  readonly memberRef: string;
  readonly serviceScopes: readonly string[];
}

/**
 * An effective-dated, provisioned on-call rotation for one location (R8 §5.4).
 * Runtime-read-only config: versions arrive as change-controlled seed data via
 * `publishOnCallRotation` (the app role cannot INSERT — DB floor). The engine
 * covers whatever the effective version provisions.
 */
export interface OnCallRotation extends EffectiveDatedVersion {
  readonly rotationId: string;
  readonly version: number;
  readonly effectiveOn: string;
  readonly locationId: string;
  readonly coverageMode: CoverageMode;
  /** The service scopes this rotation is provisioned to cover 24/7. */
  readonly serviceScopes: readonly string[];
  /** The provisioned members, in rotation order, each with their qualified scopes. */
  readonly memberOrder: readonly OnCallMember[];
}

/**
 * A concrete coverage assignment: a member on call for `[windowStart, windowEnd)`.
 * An `override` slot wins over a `rotation` slot on the same window (REQ-ADM-041);
 * a `vacated` slot (departed member) covers nobody.
 */
export interface OnCallSlot {
  readonly slotId: string;
  readonly rotationId: string;
  readonly kind: OnCallSlotKind;
  readonly memberRef: string;
  /** The member's own qualified service scopes (skip-outside-scope, REQ-ADM-015). */
  readonly serviceScopes: readonly string[];
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly status: OnCallSlotStatus;
}

const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function parseInstant(iso: string, label: string): number {
  if (!isoInstantPattern.test(iso)) {
    throw new OnCallError(
      `${label} must be an ISO UTC instant (…Z); received ${JSON.stringify(iso)}`,
    );
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new OnCallError(`${label} is not a valid instant: ${JSON.stringify(iso)}`);
  }
  return ms;
}

/** Whether a slot is active (covers the instant) and not vacated. */
function slotCovers(slot: OnCallSlot, atMs: number): boolean {
  if (slot.status === 'vacated') {
    return false;
  }
  const start = parseInstant(slot.windowStart, 'windowStart');
  const end = parseInstant(slot.windowEnd, 'windowEnd');
  if (end <= start) {
    throw new OnCallError(`slot ${slot.slotId} windowEnd must be after windowStart`);
  }
  return atMs >= start && atMs < end;
}

/** A member is qualified for a case iff its service scopes include the requirement. */
function memberQualified(slot: OnCallSlot, requiredServiceScope?: string): boolean {
  return requiredServiceScope === undefined || slot.serviceScopes.includes(requiredServiceScope);
}

export interface OnCallResolution {
  readonly ownerRef: string;
  readonly slotId: string;
  readonly viaOverride: boolean;
}

/**
 * The currently on-call owner for a scope at an instant (REQ-ADM-016). Overrides
 * win over rotation slots on the same window; a covering member whose service
 * scopes do NOT include `requiredServiceScope` is SKIPPED so the case routes to
 * the next currently-qualified on-call owner (REQ-ADM-015). Returns `null` when no
 * qualified slot covers the instant — a coverage gap.
 */
export function resolveOnCall(
  slots: readonly OnCallSlot[],
  input: { readonly atIso: string; readonly requiredServiceScope?: string },
): OnCallResolution | null {
  const atMs = parseInstant(input.atIso, 'atIso');
  const covering = slots.filter(
    (slot) => slotCovers(slot, atMs) && memberQualified(slot, input.requiredServiceScope),
  );
  if (covering.length === 0) {
    return null;
  }
  // Override wins; among equal kinds the latest-starting window is the most
  // specific cover. Deterministic tie-break by slotId keeps resolution stable.
  const chosen = [...covering].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === 'override' ? -1 : 1;
    }
    const startDelta =
      parseInstant(right.windowStart, 'windowStart') -
      parseInstant(left.windowStart, 'windowStart');
    if (startDelta !== 0) {
      return startDelta;
    }
    return left.slotId < right.slotId ? -1 : left.slotId > right.slotId ? 1 : 0;
  })[0];
  if (chosen === undefined) {
    return null;
  }
  return {
    ownerRef: chosen.memberRef,
    slotId: chosen.slotId,
    viaOverride: chosen.kind === 'override',
  };
}

export const coverageGapReasons = [
  'no-qualified-oncall',
  'vacated-slot',
  'unfilled-window',
] as const;
export type CoverageGapReason = (typeof coverageGapReasons)[number];

export interface CoverageGap {
  readonly gapStart: string;
  readonly gapEnd: string;
  readonly reason: CoverageGapReason;
}

const isoOf = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/**
 * The sub-intervals of `[fromIso, toIso)` with no qualified covering slot
 * (REQ-ADM-041 gap alerting). Sweeps the window boundaries of every covering slot
 * plus the range endpoints; any segment whose midpoint resolves to no qualified
 * owner is a gap. A `vacated`-only cover reports `vacated-slot`; an unqualified-
 * only cover reports `no-qualified-oncall`; nothing at all reports
 * `unfilled-window`. A 24/7 rotation with any gap is a provisioning defect.
 */
export function detectCoverageGaps(
  slots: readonly OnCallSlot[],
  input: {
    readonly fromIso: string;
    readonly toIso: string;
    readonly requiredServiceScope?: string;
  },
): readonly CoverageGap[] {
  const from = parseInstant(input.fromIso, 'fromIso');
  const to = parseInstant(input.toIso, 'toIso');
  if (to <= from) {
    throw new OnCallError('detectCoverageGaps requires toIso after fromIso');
  }
  const boundaries = new Set<number>([from, to]);
  for (const slot of slots) {
    const start = parseInstant(slot.windowStart, 'windowStart');
    const end = parseInstant(slot.windowEnd, 'windowEnd');
    if (start > from && start < to) {
      boundaries.add(start);
    }
    if (end > from && end < to) {
      boundaries.add(end);
    }
  }
  const points = [...boundaries].sort((left, right) => left - right);
  const gaps: CoverageGap[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const segStart = points[index] as number;
    const segEnd = points[index + 1] as number;
    const mid = segStart + (segEnd - segStart) / 2;
    const qualified = resolveOnCall(slots, {
      atIso: isoOf(mid),
      ...(input.requiredServiceScope === undefined
        ? {}
        : { requiredServiceScope: input.requiredServiceScope }),
    });
    if (qualified !== null) {
      continue;
    }
    const reason = gapReasonAt(slots, mid, input.requiredServiceScope);
    // Coalesce adjacent gaps of the same reason into one interval.
    const previous = gaps[gaps.length - 1];
    if (
      previous !== undefined &&
      previous.gapEnd === isoOf(segStart) &&
      previous.reason === reason
    ) {
      gaps[gaps.length - 1] = { gapStart: previous.gapStart, gapEnd: isoOf(segEnd), reason };
    } else {
      gaps.push({ gapStart: isoOf(segStart), gapEnd: isoOf(segEnd), reason });
    }
  }
  return gaps;
}

function gapReasonAt(
  slots: readonly OnCallSlot[],
  atMs: number,
  requiredServiceScope?: string,
): CoverageGapReason {
  const present = slots.filter((slot) => {
    const start = parseInstant(slot.windowStart, 'windowStart');
    const end = parseInstant(slot.windowEnd, 'windowEnd');
    return atMs >= start && atMs < end;
  });
  if (present.length === 0) {
    return 'unfilled-window';
  }
  if (present.every((slot) => slot.status === 'vacated')) {
    return 'vacated-slot';
  }
  if (
    present.some(
      (slot) => slot.status !== 'vacated' && !memberQualified(slot, requiredServiceScope),
    )
  ) {
    return 'no-qualified-oncall';
  }
  return 'unfilled-window';
}

/**
 * The effective on-call rotation for a location as-of a date (REQ-ADM-041). Narrows
 * to the location, then selects the highest version with effectiveOn <= asOf via
 * the shared primitive; `undefined` when none is effective (the caller decides —
 * an unprovisioned location is itself a gap).
 */
export function resolveEffectiveRotation(
  rotations: readonly OnCallRotation[],
  locationId: string,
  asOf?: string,
): OnCallRotation | undefined {
  const on = resolveEffectiveAsOf(asOf);
  const forLocation = rotations.filter((rotation) => rotation.locationId === locationId);
  const selected = selectEffectiveVersion(forLocation, on);
  if (selected !== undefined) {
    assertRotationValid(selected);
  }
  return selected;
}

const refPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const idPattern = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
const scopePattern = /^[a-z0-9][a-z0-9:._-]{0,63}$/;

/**
 * Validate a rotation version for publication/use: a non-empty ordered member set,
 * grammar-clean ids/scopes, and — for a 24x7 rotation — every provisioned service
 * scope covered by at least one member (an unqualified 24/7 rotation is a defect,
 * not a silent gap).
 */
export function assertRotationValid(rotation: OnCallRotation): void {
  if (!idPattern.test(rotation.rotationId)) {
    throw new OnCallError(
      `rotation id ${JSON.stringify(rotation.rotationId)} is not grammar-clean`,
    );
  }
  if (rotation.version < 1) {
    throw new OnCallError(`rotation ${rotation.rotationId} version must be >= 1`);
  }
  if (!refPattern.test(rotation.locationId)) {
    throw new OnCallError(`rotation ${rotation.rotationId} locationId is not grammar-clean`);
  }
  if (!(coverageModes as readonly string[]).includes(rotation.coverageMode)) {
    throw new OnCallError(
      `rotation ${rotation.rotationId} unknown coverage mode ${rotation.coverageMode}`,
    );
  }
  if (rotation.serviceScopes.length === 0) {
    throw new OnCallError(
      `rotation ${rotation.rotationId} must declare at least one service scope`,
    );
  }
  for (const scope of rotation.serviceScopes) {
    if (!scopePattern.test(scope)) {
      throw new OnCallError(
        `rotation ${rotation.rotationId} service scope ${JSON.stringify(scope)} is not grammar-clean`,
      );
    }
  }
  if (rotation.memberOrder.length === 0) {
    throw new OnCallError(`rotation ${rotation.rotationId} must provision at least one member`);
  }
  for (const member of rotation.memberOrder) {
    if (!refPattern.test(member.memberRef)) {
      throw new OnCallError(
        `rotation ${rotation.rotationId} member ref ${JSON.stringify(member.memberRef)} is not grammar-clean`,
      );
    }
  }
  if (rotation.coverageMode === '24x7') {
    for (const scope of rotation.serviceScopes) {
      const covered = rotation.memberOrder.some((member) => member.serviceScopes.includes(scope));
      if (!covered) {
        throw new OnCallError(
          `rotation ${rotation.rotationId} is 24x7 but no provisioned member covers service scope ${JSON.stringify(scope)}`,
        );
      }
    }
  }
}

/**
 * Config-change audit input for an on-call rotation publication (mirrors the
 * WP-022 SlaPolicyAuditInput shape). The gated publishOnCallRotation command
 * emits this so no rotation-registry change escapes an audit record; the
 * config_ref is grammar-clean.
 */
export interface OnCallRotationAuditInput {
  readonly tenantId: string;
  readonly stream: 'config-change';
  readonly action: 'publish-oncall-rotation';
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly detail: { readonly config_ref: string };
}

/**
 * Validate an on-call rotation version for publication (validate-first; the row
 * lands as change-controlled seed via the owner connection — the app role cannot
 * INSERT). Returns the validated rotation + its config-change audit input; throws
 * before producing anything if the rotation is malformed.
 */
export function publishOnCallRotationVersion(input: {
  readonly tenantId: string;
  readonly rotation: OnCallRotation;
  readonly actorRef: string;
  readonly occurredAt: string;
}): { readonly rotation: OnCallRotation; readonly auditInput: OnCallRotationAuditInput } {
  assertRotationValid(input.rotation);
  if (!isoInstantPattern.test(input.occurredAt)) {
    throw new OnCallError(
      `occurredAt must be an ISO instant; received ${JSON.stringify(input.occurredAt)}`,
    );
  }
  const configRef = `oncall-rotation:${input.rotation.rotationId}:v${input.rotation.version}`;
  return {
    rotation: input.rotation,
    auditInput: {
      tenantId: input.tenantId,
      stream: 'config-change',
      action: 'publish-oncall-rotation',
      actorRef: input.actorRef,
      occurredAt: input.occurredAt,
      detail: { config_ref: configRef },
    },
  };
}
