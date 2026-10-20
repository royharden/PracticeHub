/**
 * Podium export completeness and history import (REQ-MIG-002).
 *
 * The export manifest is hashed. Each contracted object type reconciles as a
 * WP-110 control total: source record refs against imported record refs,
 * where a difference is acceptable only when every missing record carries a
 * documented, reason-coded omission. Until every object type reconciles and
 * every sampled trace is complete or reason-coded, Podium stays searchable
 * and read-only and termination is blocked by a named owner.
 */

import { createHash } from 'node:crypto';

import { reconcileControlTotals } from '../reconciliation.js';
import { requireInstant } from './instant.js';
import type { ControlTotal, ReconciledControlTotal } from '../types.js';

export const podiumObjectTypes = [
  'contacts',
  'conversations',
  'messages',
  'notes',
  'calls',
  'consent',
  'reviews',
  'assignments',
  'audit',
] as const;

export type PodiumObjectType = (typeof podiumObjectTypes)[number];

export type ExportSource = 'contracted-full-export' | 'contact-csv' | 'inbound-ftp' | 'api-subset';

export interface PodiumHistoryRecord {
  readonly objectType: PodiumObjectType;
  readonly recordRef: string;
  readonly locationRef: string;
  readonly occurredAt: string;
  readonly numberRef?: string;
  readonly contactRef?: string;
  readonly deleted: boolean;
  readonly attachmentRefs: readonly string[];
}

export interface DocumentedOmission {
  readonly objectType: PodiumObjectType;
  readonly recordRef: string;
  readonly reasonCode: string;
}

export interface PodiumExportManifest {
  readonly tenantId: string;
  readonly exportRef: string;
  readonly source: ExportSource;
  readonly objects: readonly {
    readonly objectType: PodiumObjectType;
    readonly count: number;
    readonly earliest: string | null;
    readonly latest: string | null;
    readonly locationRefs: readonly string[];
    readonly attachmentCount: number;
    readonly deletionCount: number;
    readonly recordSetHash: string;
  }[];
  readonly omissions: readonly DocumentedOmission[];
  readonly manifestHash: string;
  readonly synthetic: true;
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const recordSetHash = (refs: readonly string[]): string =>
  sha256(JSON.stringify([...new Set(refs)].sort()));

function manifestBodyHash(manifest: Omit<PodiumExportManifest, 'manifestHash'>): string {
  return sha256(
    JSON.stringify([
      manifest.tenantId,
      manifest.exportRef,
      manifest.source,
      manifest.objects,
      [...manifest.omissions]
        .map((omission) => [omission.objectType, omission.recordRef, omission.reasonCode])
        .sort(),
    ]),
  );
}

export function buildExportManifest(input: {
  readonly tenantId: string;
  readonly exportRef: string;
  readonly source: ExportSource;
  readonly records: readonly PodiumHistoryRecord[];
  readonly omissions: readonly DocumentedOmission[];
}): PodiumExportManifest {
  const objects = podiumObjectTypes.map((objectType) => {
    const records = input.records.filter((record) => record.objectType === objectType);
    const times = records
      .map((record) => ({
        at: record.occurredAt,
        ms: requireInstant(record.occurredAt, 'occurredAt'),
      }))
      .sort((left, right) => left.ms - right.ms)
      .map((time) => time.at);
    return {
      objectType,
      count: new Set(records.map((record) => record.recordRef)).size,
      earliest: times[0] ?? null,
      latest: times.at(-1) ?? null,
      locationRefs: [...new Set(records.map((record) => record.locationRef))].sort(),
      attachmentCount: records.reduce((sum, record) => sum + record.attachmentRefs.length, 0),
      deletionCount: records.filter((record) => record.deleted).length,
      recordSetHash: recordSetHash(records.map((record) => record.recordRef)),
    };
  });
  const body = {
    tenantId: input.tenantId,
    exportRef: input.exportRef,
    source: input.source,
    objects,
    omissions: input.omissions,
    synthetic: true as const,
  };
  return { ...body, manifestHash: manifestBodyHash(body) };
}

export interface SampleTrace {
  readonly sampleRef: string;
  readonly objectType: PodiumObjectType;
  readonly fields: Readonly<
    Record<
      | 'message'
      | 'delivery-state'
      | 'ownership'
      | 'consent-evidence'
      | 'review-attribution'
      | 'call-artifact',
      'complete' | 'missing' | 'not-applicable'
    >
  >;
  readonly reasonCode: string | null;
}

export interface CompletenessAssessment {
  readonly readiness: 'ready-to-terminate' | 'blocked';
  readonly podiumMode: 'searchable-read-only' | 'terminable';
  readonly blockers: readonly string[];
  readonly blockingOwnerRef: string | null;
  readonly controlTotals: readonly ReconciledControlTotal[];
}

function controlTotal(
  tenantId: string,
  side: ControlTotal['side'],
  objectType: PodiumObjectType,
  refs: readonly string[],
): ControlTotal {
  const unique = [...new Set(refs)];
  return {
    totalRef: `podium-exit:${side}:${objectType}`,
    tenantId,
    side,
    name: `podium-${objectType}`,
    valueMinor: String(unique.length),
    unit: 'records',
    checksum: recordSetHash(unique),
    synthetic: true,
  };
}

export function assessExportCompleteness(input: {
  readonly manifest: PodiumExportManifest;
  readonly sourceRecords: readonly PodiumHistoryRecord[];
  readonly importedRecordRefs: Readonly<Partial<Record<PodiumObjectType, readonly string[]>>>;
  readonly samples: readonly SampleTrace[];
  readonly ownerRef: string | null;
}): CompletenessAssessment {
  const { manifest } = input;
  const blockers: string[] = [];
  const { manifestHash, ...body } = manifest;
  if (manifestBodyHash(body) !== manifestHash) blockers.push('manifest-hash-mismatch');
  if (manifest.source !== 'contracted-full-export') {
    blockers.push(`export-source-not-full-archive:${manifest.source}`);
  }
  const omitted = new Map<string, DocumentedOmission>();
  for (const omission of manifest.omissions) {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(omission.reasonCode)) {
      blockers.push(`omission-reason-invalid:${omission.recordRef}`);
    }
    omitted.set(`${omission.objectType}|${omission.recordRef}`, omission);
  }

  const source: ControlTotal[] = [];
  const target: ControlTotal[] = [];
  const explanations: Record<string, string> = {};
  for (const entry of manifest.objects) {
    const sourceRefs = input.sourceRecords
      .filter((record) => record.objectType === entry.objectType)
      .map((record) => record.recordRef);
    if (recordSetHash(sourceRefs) !== entry.recordSetHash) {
      blockers.push(`source-differs-from-manifest:${entry.objectType}`);
    }
    const imported = new Set(input.importedRecordRefs[entry.objectType] ?? []);
    const unexpected = [...imported].filter((ref) => !sourceRefs.includes(ref));
    if (unexpected.length > 0) blockers.push(`imported-record-not-in-source:${entry.objectType}`);
    const missing = sourceRefs.filter((ref) => !imported.has(ref));
    const unexplained = missing.filter((ref) => !omitted.has(`${entry.objectType}|${ref}`));
    source.push(controlTotal(manifest.tenantId, 'source', entry.objectType, sourceRefs));
    target.push(
      controlTotal(manifest.tenantId, 'candidate-target', entry.objectType, [...imported]),
    );
    if (missing.length > 0 && unexplained.length === 0 && unexpected.length === 0) {
      explanations[`podium-${entry.objectType}|records|`] =
        `podium-omission:${entry.objectType}:${missing.length}`;
    }
  }
  for (const objectType of podiumObjectTypes) {
    if (!manifest.objects.some((entry) => entry.objectType === objectType)) {
      blockers.push(`object-type-missing:${objectType}`);
    }
  }
  const controlTotals =
    source.length === 0
      ? []
      : reconcileControlTotals(manifest.tenantId, source, target, explanations);
  for (const total of controlTotals) {
    if (total.state === 'blocking') blockers.push(`count-unreconciled:${total.name}`);
  }
  if (input.samples.length === 0) blockers.push('no-sampled-ui-traces');
  for (const sample of input.samples) {
    const incomplete = Object.values(sample.fields).some((state) => state === 'missing');
    if (incomplete && sample.reasonCode === null) {
      blockers.push(`sample-trace-incomplete:${sample.sampleRef}`);
    }
  }
  const unique = [...new Set(blockers)];
  if (unique.length > 0 && input.ownerRef === null) unique.push('blocking-owner-missing');
  const ready = unique.length === 0;
  return {
    readiness: ready ? 'ready-to-terminate' : 'blocked',
    podiumMode: ready ? 'terminable' : 'searchable-read-only',
    blockers: unique,
    blockingOwnerRef: ready ? null : input.ownerRef,
    controlTotals,
  };
}

export interface HistoryImportPlan {
  /** One thread per business number and contact. */
  readonly threads: readonly {
    readonly numberRef: string;
    readonly contactRef: string;
    readonly recordRefs: readonly string[];
  }[];
  /** Records imported outside a thread (contacts, notes, reviews, audit). */
  readonly standaloneRecordRefs: readonly string[];
  /** Thread-bound records that cannot be attached, reason-coded for the manifest. */
  readonly omissions: readonly DocumentedOmission[];
}

const threadBound: ReadonlySet<PodiumObjectType> = new Set(['conversations', 'messages', 'calls']);

export function planHistoryImport(records: readonly PodiumHistoryRecord[]): HistoryImportPlan {
  const threads = new Map<
    string,
    { numberRef: string; contactRef: string; recordRefs: string[] }
  >();
  const standalone: string[] = [];
  const omissions: DocumentedOmission[] = [];
  const at = new Map(
    records.map((record) => [record, requireInstant(record.occurredAt, 'occurredAt')]),
  );
  const ordered = [...records].sort(
    (left, right) =>
      (at.get(left) ?? 0) - (at.get(right) ?? 0) || left.recordRef.localeCompare(right.recordRef),
  );
  for (const record of ordered) {
    if (record.deleted) {
      omissions.push({
        objectType: record.objectType,
        recordRef: record.recordRef,
        reasonCode: 'deleted-at-source',
      });
      continue;
    }
    if (!threadBound.has(record.objectType)) {
      standalone.push(record.recordRef);
      continue;
    }
    if (record.numberRef === undefined || record.contactRef === undefined) {
      omissions.push({
        objectType: record.objectType,
        recordRef: record.recordRef,
        reasonCode: 'unmatched-thread-party',
      });
      continue;
    }
    const key = JSON.stringify([record.numberRef, record.contactRef]);
    const thread = threads.get(key) ?? {
      numberRef: record.numberRef,
      contactRef: record.contactRef,
      recordRefs: [],
    };
    thread.recordRefs.push(record.recordRef);
    threads.set(key, thread);
  }
  return {
    threads: [...threads.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, thread]) => thread),
    standaloneRecordRefs: standalone,
    omissions,
  };
}
