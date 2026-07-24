/**
 * Coverage / PTO / handoff domain (WP-023, M05). Contract:
 * docs/contracts/oncall-coverage-api.md (FROZEN §4–5); behavioral seed
 * docs/contracts/sla-engine-spec.md §5.6. Requirements: REQ-TASK-020 (coverage/PTO
 * planned handoff bulk-reassigns owned threads with context), REQ-TASK-003
 * (reassign owned threads BEFORE a planned absence breaches), REQ-TASK-034 (morning
 * handoff artifact for overnight urgent threads), REQ-TASK-033 (abrupt-departure
 * on-call vacate + owned-work bulk reassign — the buildable M05/M02 slice).
 *
 * Pure planners over the WP-022 reassignment-with-context mechanism. A bulk move
 * is fail-closed the WP-017-offboarding way: every owned item must carry a context
 * package or the whole plan throws — zero-orphaned is a construction property, not
 * a runtime hope. Execution (drive reassignWorkItem per item + record the handoff
 * manifest) lives in oncall-store.ts.
 */

import type { ContextPackage, WorkItemRisk } from './workitem.js';
import { OnCallError } from './oncall.js';

/** The reasons a coverage move records on the reassignment (WP-022 vocabulary subset). */
export const coverageReasons = ['pto', 'coverage'] as const;
export type CoverageReason = (typeof coverageReasons)[number];

export const coverageTargetKinds = ['owner', 'pool'] as const;
export type CoverageTargetKind = (typeof coverageTargetKinds)[number];

export const coverageWindowStatuses = ['planned', 'active', 'closed'] as const;
export type CoverageWindowStatus = (typeof coverageWindowStatuses)[number];

/** An owner's OOO/PTO window with the coverage target for their owned work. */
export interface CoverageWindow {
  readonly coverageId: string;
  readonly ownerRef: string;
  readonly fromAt: string;
  readonly toAt: string;
  readonly coverageTargetRef: string;
  readonly targetKind: CoverageTargetKind;
  readonly reason: CoverageReason;
  readonly status: CoverageWindowStatus;
}

/** An owned WorkItem to hand off, with the context package the new owner inherits. */
export interface OwnedItemHandoff {
  readonly workItemId: string;
  readonly contextPackage: ContextPackage;
}

/** One reassignment in a bulk plan — drives WP-022 reassignWorkItem when executed. */
export interface CoverageReassignment {
  readonly workItemId: string;
  readonly toOwnerRef: string;
  readonly reason: CoverageReason;
  readonly contextPackage: ContextPackage;
}

const refPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const idPattern = /^[a-z0-9][a-z0-9:._-]{0,127}$/;

function assertContextPackage(workItemId: string, pkg: ContextPackage | undefined): ContextPackage {
  if (pkg === undefined || pkg === null || !Array.isArray(pkg.timerState)) {
    throw new OnCallError(
      `coverage reassignment of ${JSON.stringify(workItemId)} must carry a context package with timerState`,
    );
  }
  return pkg;
}

/**
 * Build a bulk reassignment plan for a coverage/PTO window (REQ-TASK-020). One
 * entry per owned WorkItem, each carrying its context package, reason from the
 * window. Fail-closed BEFORE any move: an empty item set, a duplicate item, a
 * missing context package, or a pool target (not executable through WP-022's
 * owner-targeting reassignWorkItem — FWD-COVERAGE-030-POOL) throws. Because the
 * window is `planned`, the plan runs ahead of the absence — reassigning owned
 * threads before an SLA breach (REQ-TASK-003).
 */
export function planCoverageReassignment(input: {
  readonly window: CoverageWindow;
  readonly ownedItems: readonly OwnedItemHandoff[];
}): readonly CoverageReassignment[] {
  const { window, ownedItems } = input;
  if (window.targetKind !== 'owner') {
    throw new OnCallError(
      `coverage window ${JSON.stringify(window.coverageId)} targets a ${window.targetKind}; ` +
        'WP-023 executes owner-target coverage only (pool release: FWD-COVERAGE-030-POOL)',
    );
  }
  if (!refPattern.test(window.coverageTargetRef)) {
    throw new OnCallError(
      `coverage window ${JSON.stringify(window.coverageId)} target owner is not grammar-clean`,
    );
  }
  if (ownedItems.length === 0) {
    throw new OnCallError(
      `coverage window ${JSON.stringify(window.coverageId)} plan has no owned items`,
    );
  }
  const seen = new Set<string>();
  return ownedItems.map((item) => {
    if (!idPattern.test(item.workItemId)) {
      throw new OnCallError(
        `coverage item id ${JSON.stringify(item.workItemId)} is not grammar-clean`,
      );
    }
    if (seen.has(item.workItemId)) {
      throw new OnCallError(`coverage plan lists ${JSON.stringify(item.workItemId)} twice`);
    }
    seen.add(item.workItemId);
    if (item.workItemId === window.ownerRef) {
      // Defensive: a work item id can never equal an owner ref by grammar, but a
      // self-reassign to the departing owner would be a no-op orphan.
      throw new OnCallError(`coverage plan cannot reassign an item to the departing owner`);
    }
    return {
      workItemId: item.workItemId,
      toOwnerRef: window.coverageTargetRef,
      reason: window.reason,
      contextPackage: assertContextPackage(item.workItemId, item.contextPackage),
    };
  });
}

export const handoffKinds = ['morning-handoff', 'pto-coverage', 'departure'] as const;
export type HandoffKind = (typeof handoffKinds)[number];

/** A single item's line in a handoff manifest (a reference, never inline PHI). */
export interface HandoffManifestEntry {
  readonly workItemId: string;
  readonly risk: WorkItemRisk;
  readonly contextPackageRef: string;
}

/** The bulk-move / handoff audit artifact (CoverageHandoff, contract §2). */
export interface CoverageHandoff {
  readonly handoffId: string;
  readonly kind: HandoffKind;
  readonly fromOwnerRef: string | null;
  readonly toOwnerRef: string;
  readonly generatedAt: string;
  readonly itemCount: number;
  readonly manifest: readonly HandoffManifestEntry[];
}

/** An overnight urgent thread to summarize in a morning handoff. */
export interface OvernightItem {
  readonly workItemId: string;
  readonly risk: WorkItemRisk;
  readonly contextPackageRef: string;
}

const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function assertHandoffInputs(handoffId: string, toOwnerRef: string, generatedAt: string): void {
  if (!idPattern.test(handoffId)) {
    throw new OnCallError(`handoff id ${JSON.stringify(handoffId)} is not grammar-clean`);
  }
  if (!refPattern.test(toOwnerRef)) {
    throw new OnCallError(`handoff toOwnerRef ${JSON.stringify(toOwnerRef)} is not grammar-clean`);
  }
  if (!isoInstantPattern.test(generatedAt)) {
    throw new OnCallError(
      `handoff generatedAt must be an ISO instant; received ${JSON.stringify(generatedAt)}`,
    );
  }
}

/**
 * The morning-handoff artifact for overnight urgent threads (REQ-TASK-034): a
 * `morning-handoff` CoverageHandoff summarizing each overnight item with its risk
 * and a context-package reference. An artifact/record — not a reassignment (the
 * incoming provider picks items up; ownership moves only on an explicit claim).
 * Fails closed on a duplicate item so the manifest is exact.
 */
export function buildMorningHandoff(input: {
  readonly handoffId: string;
  readonly fromOwnerRef: string | null;
  readonly toOwnerRef: string;
  readonly overnightItems: readonly OvernightItem[];
  readonly generatedAt: string;
}): CoverageHandoff {
  assertHandoffInputs(input.handoffId, input.toOwnerRef, input.generatedAt);
  if (input.fromOwnerRef !== null && !refPattern.test(input.fromOwnerRef)) {
    throw new OnCallError(
      `handoff fromOwnerRef ${JSON.stringify(input.fromOwnerRef)} is not grammar-clean`,
    );
  }
  const seen = new Set<string>();
  const manifest: HandoffManifestEntry[] = input.overnightItems.map((item) => {
    if (seen.has(item.workItemId)) {
      throw new OnCallError(`morning handoff lists ${JSON.stringify(item.workItemId)} twice`);
    }
    seen.add(item.workItemId);
    return {
      workItemId: item.workItemId,
      risk: item.risk,
      contextPackageRef: item.contextPackageRef,
    };
  });
  return {
    handoffId: input.handoffId,
    kind: 'morning-handoff',
    fromOwnerRef: input.fromOwnerRef,
    toOwnerRef: input.toOwnerRef,
    generatedAt: input.generatedAt,
    itemCount: manifest.length,
    manifest,
  };
}

/** The on-call slots a departing member vacates + the gaps they leave. */
export interface DepartureVacate {
  readonly slotId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
}

export interface DepartureCoveragePlan {
  readonly vacatedSlots: readonly DepartureVacate[];
  readonly reassignments: readonly CoverageReassignment[];
  readonly handoff: CoverageHandoff;
}

/**
 * The buildable M05/M02 slice of REQ-TASK-033 (abrupt provider departure): vacate
 * the departing member's on-call slots (the caller raises gap alerts for the
 * uncovered windows) and bulk-reassign their owned work to the covering owner with
 * context (a `departure` handoff). Integrates with WP-017 offboarding evidence.
 * The cross-module residuals (clinical panel, in-flight order, patient
 * notification) are recorded forward (FWD-TASK-033-PANEL/-ORDER/-NOTIFY) — not
 * buildable at F0.
 */
export function planDepartureCoverage(input: {
  readonly handoffId: string;
  readonly departingOwnerRef: string;
  readonly coveringOwnerRef: string;
  readonly vacatedSlots: readonly DepartureVacate[];
  readonly ownedItems: readonly OwnedItemHandoff[];
  readonly generatedAt: string;
}): DepartureCoveragePlan {
  if (!refPattern.test(input.departingOwnerRef)) {
    throw new OnCallError(`departure departingOwnerRef is not grammar-clean`);
  }
  const window: CoverageWindow = {
    coverageId: `${input.handoffId}-cov`,
    ownerRef: input.departingOwnerRef,
    fromAt: input.generatedAt,
    toAt: input.generatedAt,
    coverageTargetRef: input.coveringOwnerRef,
    targetKind: 'owner',
    reason: 'coverage',
    status: 'active',
  };
  const reassignments = planCoverageReassignment({ window, ownedItems: input.ownedItems });
  const manifest: HandoffManifestEntry[] = reassignments.map((entry) => ({
    workItemId: entry.workItemId,
    risk: 'elevated',
    contextPackageRef: entry.contextPackage.priorOwnerNotesRef ?? `context:${entry.workItemId}`,
  }));
  assertHandoffInputs(input.handoffId, input.coveringOwnerRef, input.generatedAt);
  return {
    vacatedSlots: input.vacatedSlots,
    reassignments,
    handoff: {
      handoffId: input.handoffId,
      kind: 'departure',
      fromOwnerRef: input.departingOwnerRef,
      toOwnerRef: input.coveringOwnerRef,
      generatedAt: input.generatedAt,
      itemCount: manifest.length,
      manifest,
    },
  };
}
