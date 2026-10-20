import type { MappingVersion, ValidationFinding } from '../types.js';

/**
 * WP-068 EHI ingest shapes. Every value here is synthetic. The Athena source is
 * EW-ATH-01 (external wait): this package runs only against `athena-sim-bulk`.
 */
export const ehiResourceKinds = ['patient', 'encounter', 'problem', 'medication'] as const;

export type EhiResourceKind = (typeof ehiResourceKinds)[number];

export type EhiFieldType = 'ref' | 'text' | 'date' | 'code';

export interface EhiFieldShape {
  readonly name: string;
  readonly type: EhiFieldType;
  readonly required: boolean;
}

export interface EhiResourceShape {
  readonly kind: EhiResourceKind;
  readonly idField: string;
  readonly fields: readonly EhiFieldShape[];
}

/** One source record from a bulk page or a delta read. Values are transient inputs. */
export interface EhiSourceRecord {
  readonly tenantId: string;
  readonly kind: EhiResourceKind;
  readonly sourceRecordRef: string;
  readonly values: Readonly<Record<string, string>>;
  readonly synthetic: true;
}

export interface EhiBulkPage {
  readonly pageRef: string;
  readonly kind: EhiResourceKind;
  readonly structurallyReadable: boolean;
  readonly records: readonly EhiSourceRecord[];
}

export interface EhiBulkExport {
  readonly tenantId: string;
  readonly sourceSystemRef: string;
  readonly exportRef: string;
  readonly exportHash: string;
  readonly pages: readonly EhiBulkPage[];
  readonly synthetic: true;
}

/** A versioned mapping set: one approved MappingVersion per resource kind. */
export interface EhiIngestMappingSet {
  readonly tenantId: string;
  readonly sourceSystemRef: string;
  readonly mappingSetRef: string;
  readonly byKind: Readonly<Record<EhiResourceKind, MappingVersion>>;
  readonly synthetic: true;
}

export interface EhiStagingRow {
  readonly tenantId: string;
  readonly waveRef: string;
  readonly kind: EhiResourceKind;
  readonly sourceRecordRef: string;
  readonly sourceContentHash: string;
  readonly mappingVersionRef: string;
  readonly mappingVersionHash: string;
  /** Mapped target fields only; excluded and unmapped source fields never reach staging. */
  readonly targetValues: Readonly<Record<string, string>>;
  readonly synthetic: true;
}

export interface EhiIngestReport {
  readonly tenantId: string;
  readonly waveRef: string;
  readonly exportRef: string;
  readonly exportHash: string;
  readonly mappingSetRef: string;
  readonly stagedCountByKind: Readonly<Record<EhiResourceKind, number>>;
  readonly sourceCountByKind: Readonly<Record<EhiResourceKind, number>>;
  readonly rejectedRecordRefs: readonly string[];
  readonly findings: readonly ValidationFinding[];
  readonly targetDataWrites: 0;
  readonly synthetic: true;
}

export type EhiDeltaOperation =
  | {
      readonly op: 'upsert';
      readonly kind: EhiResourceKind;
      readonly sourceRecordRef: string;
      readonly reason: 'new' | 'changed' | 'remapped';
    }
  | {
      readonly op: 'delete';
      readonly kind: EhiResourceKind;
      readonly sourceRecordRef: string;
      readonly reason: 'source-removed';
    };

export interface EhiDeltaPass {
  readonly pass: number;
  readonly deltaBefore: number;
  readonly applied: number;
  readonly driftInjected: number;
  readonly deltaAfter: number;
}

export interface EhiDriftRehearsal {
  readonly tenantId: string;
  readonly waveRef: string;
  readonly outcome: 'reached-zero' | 'not-converged';
  readonly passes: readonly EhiDeltaPass[];
  readonly finalDelta: number;
  readonly sourceFrozen: boolean;
  readonly synthetic: true;
}

export interface EhiStagingPurgeReceipt {
  readonly tenantId: string;
  readonly waveRef: string;
  readonly reasonRef: string;
  readonly purgedByKind: Readonly<Record<EhiResourceKind, number>>;
  readonly purgedRowCount: number;
  readonly remainingRowCount: 0;
  readonly synthetic: true;
}
