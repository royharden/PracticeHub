import { validateMappingForManifest } from '../mapping.js';
import type { WorkbenchContext } from '../types.js';
import { assertMappingSetScope, mapEhiRecord } from './ingest.js';
import { EhiIngestError, manifestForKind, sha256 } from './shapes.js';
import type { EhiStagingStore } from './staging.js';
import {
  ehiResourceKinds,
  type EhiDeltaOperation,
  type EhiDeltaPass,
  type EhiDriftRehearsal,
  type EhiIngestMappingSet,
  type EhiSourceRecord,
} from './types.js';

/** The live source the harness reads. `AthenaSimBulk` implements it. */
export interface EhiDeltaSource {
  readonly tenantId: string;
  readonly sourceSystemRef: string;
  readonly frozen: boolean;
  currentRecords(): readonly EhiSourceRecord[];
  tick(): number;
  freeze(): void;
}

/** Structurally matches athena-cutover's `EhiDeltaDouble` (wp068-ehi-delta-double/v1). */
export const ehiDeltaDrainVersion = 'wp068-ehi-delta-double/v1' as const;

export interface EhiDeltaDrain {
  readonly interfaceVersion: typeof ehiDeltaDrainVersion;
  remaining(panelRef: string): number;
  drainOne(panelRef: string): number;
}

interface DeltaScope {
  readonly context: WorkbenchContext;
  readonly source: EhiDeltaSource;
  readonly mappings: EhiIngestMappingSet;
  readonly staging: EhiStagingStore;
}

function assertScope(scope: DeltaScope): void {
  if (scope.source.tenantId !== scope.context.tenantId) {
    throw new EhiIngestError('delta source tenant differs from the workbench tenant');
  }
  assertMappingSetScope(scope.context, scope.source.sourceSystemRef, scope.mappings);
  const records = scope.source.currentRecords();
  const bulk = {
    tenantId: scope.source.tenantId,
    sourceSystemRef: scope.source.sourceSystemRef,
    exportRef: `delta:${scope.context.waveRef}`,
    exportHash: sha256(records),
    pages: ehiResourceKinds.map((kind) => ({
      pageRef: `delta:${kind}`,
      kind,
      structurallyReadable: true,
      records: records.filter((record) => record.kind === kind),
    })),
    synthetic: true as const,
  };
  for (const kind of ehiResourceKinds) {
    validateMappingForManifest(scope.mappings.byKind[kind], manifestForKind(bulk, kind));
  }
}

/**
 * Compares the live source (mapped through the current mapping versions) with
 * staging. Records the mapping would reject still count as delta: a rehearsal
 * cannot reach zero by leaving bad source rows behind.
 */
export function computeEhiDelta(scope: DeltaScope): readonly EhiDeltaOperation[] {
  assertScope(scope);
  const { context, source, mappings, staging } = scope;
  const operations: EhiDeltaOperation[] = [];
  const live = new Set<string>();
  for (const record of source.currentRecords()) {
    if (record.tenantId !== context.tenantId) {
      throw new EhiIngestError('delta source returned a record from another tenant');
    }
    live.add(`${record.kind}|${record.sourceRecordRef}`);
    const staged = staging.get(
      context.tenantId,
      context.waveRef,
      record.kind,
      record.sourceRecordRef,
    );
    const mapping = mappings.byKind[record.kind];
    const base = {
      op: 'upsert' as const,
      kind: record.kind,
      sourceRecordRef: record.sourceRecordRef,
    };
    if (staged === undefined) {
      operations.push({ ...base, reason: 'new' });
    } else if (staged.sourceContentHash !== sha256(record.values)) {
      operations.push({ ...base, reason: 'changed' });
    } else if (staged.mappingVersionHash !== mapping.mappingVersionHash) {
      operations.push({ ...base, reason: 'remapped' });
    }
  }
  for (const row of staging.rows(context.tenantId, context.waveRef)) {
    if (!live.has(`${row.kind}|${row.sourceRecordRef}`)) {
      operations.push({
        op: 'delete',
        kind: row.kind,
        sourceRecordRef: row.sourceRecordRef,
        reason: 'source-removed',
      });
    }
  }
  return operations;
}

/** Applies one operation. Returns false when the source record is rejected by its shape. */
export function applyEhiDeltaOperation(scope: DeltaScope, operation: EhiDeltaOperation): boolean {
  const { context, source, mappings, staging } = scope;
  if (operation.op === 'delete') {
    staging.delete(context.tenantId, context.waveRef, operation.kind, operation.sourceRecordRef);
    return true;
  }
  const record = source
    .currentRecords()
    .find(
      (item) => item.kind === operation.kind && item.sourceRecordRef === operation.sourceRecordRef,
    );
  if (record === undefined) {
    return false;
  }
  // The source is re-read here, so its tenant is re-checked before anything is staged.
  if (record.tenantId !== context.tenantId) {
    throw new EhiIngestError('delta source returned a record from another tenant');
  }
  const mapped = mapEhiRecord(record, mappings.byKind[record.kind], context.waveRef);
  if (!mapped.ok) {
    return false;
  }
  staging.put(mapped.row);
  return true;
}

/**
 * Drift-to-zero rehearsal. Each pass applies the whole delta, lets the source
 * drift, then re-measures. The source is frozen after `freezeAfterPass`; zero is
 * claimed only on a frozen source, and a rehearsal that exhausts `maxPasses`
 * reports not-converged rather than a partial zero.
 */
export function rehearseDriftToZero(
  scope: DeltaScope & { readonly maxPasses: number; readonly freezeAfterPass: number },
): EhiDriftRehearsal {
  if (!Number.isInteger(scope.maxPasses) || scope.maxPasses < 1) {
    throw new EhiIngestError('maxPasses must be a positive integer');
  }
  if (!Number.isInteger(scope.freezeAfterPass) || scope.freezeAfterPass < 1) {
    throw new EhiIngestError('freezeAfterPass must be a positive integer');
  }
  const passes: EhiDeltaPass[] = [];
  let finalDelta = computeEhiDelta(scope).length;
  for (let pass = 1; pass <= scope.maxPasses; pass += 1) {
    const delta = computeEhiDelta(scope);
    let applied = 0;
    for (const operation of delta) {
      if (applyEhiDeltaOperation(scope, operation)) {
        applied += 1;
      }
    }
    if (pass >= scope.freezeAfterPass && !scope.source.frozen) {
      scope.source.freeze();
    }
    const driftInjected = scope.source.tick();
    finalDelta = computeEhiDelta(scope).length;
    passes.push({
      pass,
      deltaBefore: delta.length,
      applied,
      driftInjected,
      deltaAfter: finalDelta,
    });
    if (finalDelta === 0 && scope.source.frozen) {
      break;
    }
  }
  return {
    tenantId: scope.context.tenantId,
    waveRef: scope.context.waveRef,
    outcome: finalDelta === 0 && scope.source.frozen ? 'reached-zero' : 'not-converged',
    passes,
    finalDelta,
    sourceFrozen: scope.source.frozen,
    synthetic: true,
  };
}

/**
 * The provider WP-114's cutover drains through (`EhiDeltaDouble`). `panelRef` is
 * the wave. `drainOne` refuses when only rejected records remain, so a caller's
 * drain loop cannot spin forever.
 */
export function createEhiDeltaDrain(scope: DeltaScope): EhiDeltaDrain {
  const assertPanel = (panelRef: string): void => {
    if (panelRef !== scope.context.waveRef) {
      throw new EhiIngestError('delta drain panel differs from the workbench wave');
    }
  };
  return {
    interfaceVersion: ehiDeltaDrainVersion,
    remaining(panelRef) {
      assertPanel(panelRef);
      return computeEhiDelta(scope).length;
    },
    drainOne(panelRef) {
      assertPanel(panelRef);
      const delta = computeEhiDelta(scope);
      if (delta.length === 0) {
        return 0;
      }
      if (!delta.some((operation) => applyEhiDeltaOperation(scope, operation))) {
        throw new EhiIngestError(
          'delta cannot drain: remaining records are rejected by the mapping shape',
        );
      }
      return computeEhiDelta(scope).length;
    },
  };
}
