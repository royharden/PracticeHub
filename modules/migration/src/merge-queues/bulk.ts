import { createHash } from 'node:crypto';

import type { CapabilityGrantSnapshot } from '../types.js';
import type {
  EngineLineageRecord,
  EngineMergeArtifact,
  EngineMergeEvent,
  IdentityMergeEnginePort,
} from './engine-port.js';
import { MergeQueueError, type ImportMergeQueue, type MergeQueueLane } from './queue.js';

/** Append-only merge/unmerge record for one tenant: events, lineage and bulk runs. */
export class MergeLedger {
  readonly #events: EngineMergeEvent[] = [];
  readonly #lineage: EngineLineageRecord[] = [];
  readonly #runs = new Map<string, BulkMergeRun>();

  public constructor(public readonly tenantId: string) {}

  public append(
    events: readonly EngineMergeEvent[],
    lineage: readonly EngineLineageRecord[],
  ): void {
    for (const item of [...events, ...lineage]) {
      if (item.tenantId !== this.tenantId || item.synthetic !== true) {
        throw new MergeQueueError('ledger refuses a cross-tenant or unwatermarked record');
      }
    }
    const known = new Set(this.#events.map((event) => event.eventId));
    for (const event of events) {
      if (known.has(event.eventId)) {
        throw new MergeQueueError(`merge event ${event.eventId} is already recorded`);
      }
      known.add(event.eventId);
    }
    this.#events.push(...events);
    this.#lineage.push(...lineage);
  }

  public events(): readonly EngineMergeEvent[] {
    return [...this.#events];
  }

  public lineage(): readonly EngineLineageRecord[] {
    return [...this.#lineage];
  }

  public event(eventId: string): EngineMergeEvent | undefined {
    return this.#events.find((event) => event.eventId === eventId);
  }

  public isReversed(eventId: string): boolean {
    return this.#events.some(
      (event) => event.kind === 'unmerge' && event.reversesEventId === eventId,
    );
  }

  public run(runRef: string): BulkMergeRun | undefined {
    return this.#runs.get(runRef);
  }

  public recordRun(run: BulkMergeRun): void {
    if (this.#runs.has(run.runRef)) {
      throw new MergeQueueError(`bulk run ${run.runRef} is already recorded`);
    }
    this.#runs.set(run.runRef, run);
  }
}

/**
 * Engine event ids use identity's id alphabet (/^[a-z0-9][a-z0-9-]{0,63}$/), so the
 * free-form run ref is hashed into it: bm-<16 hex of sha256(runRef)>-<nnnn>.
 */
export function bulkMergeEventId(runRef: string, ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > BULK_MERGE_MAX_BATCH) {
    throw new MergeQueueError('bulk merge ordinal must be 1..9999');
  }
  const digest = createHash('sha256').update(runRef).digest('hex').slice(0, 16);
  return `bm-${digest}-${String(ordinal).padStart(4, '0')}`;
}

/** Governance policy as data, not code. */
export interface BulkMergePolicy {
  readonly maxBatchSize: number;
  /** Batches of at least this many cases need a second, distinct approver. */
  readonly dualControlMinSize: number;
  readonly eligibleLanes: readonly MergeQueueLane[];
  readonly minScore: number;
}

/** The largest batch a run can hold: engine event ids carry a 4-digit ordinal (bulkMergeEventId). */
export const BULK_MERGE_MAX_BATCH = 9999;

/**
 * Refuse a policy that a run could not honour, before anything is merged
 * (NR-147): a batch above BULK_MERGE_MAX_BATCH would fail mid-run once the
 * ordinal overflows, after earlier merges were already recorded.
 */
export function assertBulkMergePolicy(policy: BulkMergePolicy): void {
  const problems: string[] = [];
  if (
    !Number.isSafeInteger(policy.maxBatchSize) ||
    policy.maxBatchSize < 1 ||
    policy.maxBatchSize > BULK_MERGE_MAX_BATCH
  ) {
    problems.push(`maxBatchSize must be 1..${String(BULK_MERGE_MAX_BATCH)}`);
  }
  if (!Number.isSafeInteger(policy.dualControlMinSize) || policy.dualControlMinSize < 1) {
    problems.push('dualControlMinSize must be a whole number of at least 1');
  }
  if (!Number.isFinite(policy.minScore)) {
    problems.push('minScore must be a finite number');
  }
  if (!Array.isArray(policy.eligibleLanes) || policy.eligibleLanes.length === 0) {
    problems.push('eligibleLanes must name at least one lane');
  }
  if (problems.length > 0) {
    throw new MergeQueueError(`bulk merge policy invalid: ${problems.join('; ')}`);
  }
}

export const defaultBulkMergePolicy: BulkMergePolicy = {
  maxBatchSize: 100,
  dualControlMinSize: 2,
  eligibleLanes: ['high-confidence'],
  minScore: 900,
};

export interface BulkMergeRequest {
  readonly runRef: string;
  readonly caseIds: readonly string[];
  readonly approvedBy: string;
  readonly secondApprover?: string;
  readonly evidenceRef: string;
  readonly rationale: string;
  /** Artifacts currently owned by the imported (merged-away) person. */
  readonly artifactsOf: (personId: string) => readonly EngineMergeArtifact[];
  readonly sourceIdRefsOf: (personId: string) => readonly string[];
}

export interface BulkMergeItem {
  readonly caseId: string;
  readonly outcome: 'merged' | 'refused';
  readonly reason?: string;
  readonly eventId?: string;
  readonly lineageCount?: number;
}

export interface BulkMergeRun {
  readonly runRef: string;
  readonly tenantId: string;
  readonly waveRef: string;
  readonly approvedBy: string;
  readonly secondApprover?: string;
  readonly items: readonly BulkMergeItem[];
  readonly mergedCount: number;
  readonly refusedCount: number;
  readonly evidenceHash: string;
  readonly synthetic: true;
}

const refPattern = /^[a-z0-9][a-z0-9:._-]{0,127}$/;
const stateRank: Readonly<Record<CapabilityGrantSnapshot['state'], number>> = {
  disabled: 0,
  scaffolded: 1,
  simulated: 2,
  shadow: 3,
  pilot: 4,
  active: 5,
  'read-only': -1,
  retiring: -1,
};

/** Reasons bulk execution is not authorized; empty means allowed. */
export function bulkMergeCapabilityGaps(
  tenantId: string,
  grants: readonly CapabilityGrantSnapshot[],
): readonly string[] {
  const gaps: string[] = [];
  for (const capabilityId of ['identity.merge-governance', 'migration.workbench']) {
    const grant = grants.find(
      (item) => item.tenantId === tenantId && item.capabilityId === capabilityId,
    );
    if (grant === undefined || stateRank[grant.state] < stateRank.simulated) {
      gaps.push(`${capabilityId}-below-simulated`);
    }
  }
  return gaps;
}

/**
 * Bulk-merge governance. The whole request is refused before any merge when
 * capability, scope, size, attribution or dual control fail. Each case is then
 * checked on its own (open, lane, score, no conflicts, person used once per
 * run) and merged through the engine, which re-applies the authorization floor
 * and artifact fail-safe. A refused case is reported, never partially merged.
 * The run ref is idempotent: re-submitting it returns the recorded run.
 */
export function executeBulkMerge(input: {
  readonly engine: IdentityMergeEnginePort;
  readonly queue: ImportMergeQueue;
  readonly ledger: MergeLedger;
  readonly grants: readonly CapabilityGrantSnapshot[];
  readonly request: BulkMergeRequest;
  readonly policy?: BulkMergePolicy;
}): BulkMergeRun {
  const { engine, queue, ledger, request } = input;
  const policy = input.policy ?? defaultBulkMergePolicy;
  assertBulkMergePolicy(policy);
  const { tenantId, waveRef } = queue.context;
  if (ledger.tenantId !== tenantId) {
    throw new MergeQueueError('ledger and queue tenants differ');
  }
  const prior = ledger.run(request.runRef);
  if (prior !== undefined) {
    return prior;
  }
  const gaps = bulkMergeCapabilityGaps(tenantId, input.grants);
  if (gaps.length > 0) {
    throw new MergeQueueError(`bulk merge not authorized: ${gaps.join(', ')}`);
  }
  for (const ref of [request.runRef, request.approvedBy, request.evidenceRef]) {
    if (!refPattern.test(ref)) {
      throw new MergeQueueError('bulk merge run, approver and evidence must be constrained refs');
    }
  }
  if (!request.rationale.trim()) {
    throw new MergeQueueError('bulk merge requires a documented rationale');
  }
  if (request.caseIds.length === 0 || request.caseIds.length > policy.maxBatchSize) {
    throw new MergeQueueError(`bulk merge size must be 1..${policy.maxBatchSize}`);
  }
  if (new Set(request.caseIds).size !== request.caseIds.length) {
    throw new MergeQueueError('bulk merge lists a case more than once');
  }
  if (request.caseIds.length >= policy.dualControlMinSize) {
    if (request.secondApprover === undefined || !refPattern.test(request.secondApprover)) {
      throw new MergeQueueError('bulk merge at this size requires a second approver');
    }
    if (request.secondApprover === request.approvedBy) {
      throw new MergeQueueError('dual control requires two distinct approvers');
    }
  }

  const usedPersons = new Set<string>();
  const items: BulkMergeItem[] = [];
  for (const [index, caseId] of request.caseIds.entries()) {
    const queued = queue.get(caseId);
    const refuse = (reason: string): void => {
      items.push({ caseId, outcome: 'refused', reason });
    };
    if (queued === undefined) {
      refuse('not-queued');
      continue;
    }
    if (queued.engineCase.status !== 'open') {
      refuse('not-open');
      continue;
    }
    if (!policy.eligibleLanes.includes(queued.lane)) {
      refuse(`lane-not-eligible:${queued.lane}`);
      continue;
    }
    if (queued.score < policy.minScore) {
      refuse('below-min-score');
      continue;
    }
    if (queued.engineCase.conflictingAttributes.length > 0) {
      refuse('conflicting-attributes');
      continue;
    }
    if (usedPersons.has(queued.importedPersonId) || usedPersons.has(queued.existingPersonId)) {
      refuse('person-already-in-run');
      continue;
    }
    const eventId = bulkMergeEventId(request.runRef, index + 1);
    try {
      const execution = engine.executeMerge({
        mergeCase: queued.engineCase,
        basis: {
          comparedAttributes: queued.engineCase.matchedAttributes,
          decidedBy: request.approvedBy,
        },
        eventId,
        survivorPersonId: queued.existingPersonId,
        mergedPersonId: queued.importedPersonId,
        artifacts: request.artifactsOf(queued.importedPersonId),
        mergedPersonSourceIdRefs: request.sourceIdRefsOf(queued.importedPersonId),
        rationale: request.rationale,
        evidenceRef: request.evidenceRef,
      });
      ledger.append([execution.event], execution.lineage);
      queue.recordResolution(execution.resolvedCase);
      usedPersons.add(queued.importedPersonId);
      usedPersons.add(queued.existingPersonId);
      items.push({ caseId, outcome: 'merged', eventId, lineageCount: execution.lineage.length });
    } catch (error) {
      refuse(`engine-refused:${error instanceof Error ? error.message : 'unknown'}`);
    }
  }
  const mergedCount = items.filter((item) => item.outcome === 'merged').length;
  const run: BulkMergeRun = {
    runRef: request.runRef,
    tenantId,
    waveRef,
    approvedBy: request.approvedBy,
    ...(request.secondApprover === undefined ? {} : { secondApprover: request.secondApprover }),
    items,
    mergedCount,
    refusedCount: items.length - mergedCount,
    evidenceHash: createHash('sha256')
      .update(JSON.stringify({ runRef: request.runRef, evidenceRef: request.evidenceRef, items }))
      .digest('hex'),
    synthetic: true,
  };
  ledger.recordRun(run);
  return run;
}
