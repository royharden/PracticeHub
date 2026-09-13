import type { MigrationBatchRef, ValidationRunRef } from './types.js';

export type MigrationBatchEvent =
  | {
      readonly eventType: 'initialized';
      readonly tenantId: string;
      readonly batchRef: MigrationBatchRef;
      readonly version: 1;
      readonly sourceSystemRef: string;
      readonly synthetic: true;
    }
  | {
      readonly eventType: 'dry-run-recorded';
      readonly tenantId: string;
      readonly batchRef: MigrationBatchRef;
      readonly version: number;
      readonly runRef: ValidationRunRef;
      readonly readiness: 'blocked' | 'ready-for-review';
      readonly synthetic: true;
    }
  | {
      readonly eventType: 'review-workitem-linked';
      readonly tenantId: string;
      readonly batchRef: MigrationBatchRef;
      readonly version: number;
      readonly runRef: ValidationRunRef;
      readonly workItemRef: string;
      readonly workItemTenantId: string;
      readonly evidenceHash: string;
      readonly synthetic: true;
    };

export interface MigrationBatchState {
  readonly tenantId: string;
  readonly batchRef: MigrationBatchRef;
  readonly sourceSystemRef: string;
  readonly version: number;
  readonly runRefs: readonly ValidationRunRef[];
  readonly latestReadiness?: 'blocked' | 'ready-for-review';
  readonly reviewWorkItemRef?: string;
}

export function foldMigrationBatch(events: readonly MigrationBatchEvent[]): MigrationBatchState {
  if (events.length === 0 || events[0]?.eventType !== 'initialized') {
    throw new Error('migration batch must begin with initialized');
  }
  const first = events[0];
  if (first.synthetic !== true) {
    throw new Error('migration batch event lacks the synthetic watermark');
  }
  if (first.version !== 1) {
    throw new Error('migration batch initial event must be version 1');
  }
  const seenRuns = new Set<string>();
  let state: MigrationBatchState = {
    tenantId: first.tenantId,
    batchRef: first.batchRef,
    sourceSystemRef: first.sourceSystemRef,
    version: 1,
    runRefs: [],
  };
  for (const event of events.slice(1)) {
    if (event.synthetic !== true) {
      throw new Error('migration batch event lacks the synthetic watermark');
    }
    if (event.tenantId !== state.tenantId || event.batchRef !== state.batchRef) {
      throw new Error('migration batch event crossed tenant or aggregate scope');
    }
    if (event.version !== state.version + 1) {
      throw new Error(`migration batch event version gap: expected ${state.version + 1}`);
    }
    if (event.eventType === 'dry-run-recorded') {
      if (!['blocked', 'ready-for-review'].includes(event.readiness)) {
        throw new Error('migration batch event has an unknown readiness');
      }
      if (seenRuns.has(event.runRef)) {
        throw new Error('migration batch records a validation run more than once');
      }
      seenRuns.add(event.runRef);
      state = {
        tenantId: state.tenantId,
        batchRef: state.batchRef,
        sourceSystemRef: state.sourceSystemRef,
        version: event.version,
        runRefs: [...state.runRefs, event.runRef],
        latestReadiness: event.readiness,
      };
    } else if (event.eventType === 'review-workitem-linked') {
      if (state.latestReadiness !== 'ready-for-review') {
        throw new Error('review WorkItem cannot link to a blocked batch');
      }
      if (
        event.workItemTenantId !== state.tenantId ||
        event.runRef !== state.runRefs.at(-1) ||
        !/^[0-9a-f]{64}$/.test(event.evidenceHash)
      ) {
        throw new Error('review WorkItem is not bound to the latest tenant-scoped run evidence');
      }
      state = { ...state, version: event.version, reviewWorkItemRef: event.workItemRef };
    } else {
      throw new Error('initialized may appear only as the first migration batch event');
    }
  }
  return state;
}
