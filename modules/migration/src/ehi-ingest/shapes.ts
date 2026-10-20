import { createHash } from 'node:crypto';

import type { SourceManifest } from '../types.js';
import {
  ehiResourceKinds,
  type EhiBulkExport,
  type EhiFieldType,
  type EhiResourceKind,
  type EhiResourceShape,
} from './types.js';

export class EhiIngestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EhiIngestError';
  }
}

export const athenaSimBulkSourceRef = 'athena-sim-bulk';

/** The closed EHI shape set for the athena-sim-bulk export. */
export const ehiResourceShapes: Readonly<Record<EhiResourceKind, EhiResourceShape>> = {
  patient: {
    kind: 'patient',
    idField: 'patient-id',
    fields: [
      { name: 'patient-id', type: 'ref', required: true },
      { name: 'given-name', type: 'text', required: true },
      { name: 'family-name', type: 'text', required: true },
      { name: 'birth-date', type: 'date', required: true },
      { name: 'sex', type: 'code', required: false },
      { name: 'legacy-chart-note', type: 'text', required: false },
    ],
  },
  encounter: {
    kind: 'encounter',
    idField: 'encounter-id',
    fields: [
      { name: 'encounter-id', type: 'ref', required: true },
      { name: 'patient-id', type: 'ref', required: true },
      { name: 'start-date', type: 'date', required: true },
      { name: 'encounter-type', type: 'code', required: true },
      { name: 'rendering-provider-ref', type: 'ref', required: false },
    ],
  },
  problem: {
    kind: 'problem',
    idField: 'problem-id',
    fields: [
      { name: 'problem-id', type: 'ref', required: true },
      { name: 'patient-id', type: 'ref', required: true },
      { name: 'code', type: 'code', required: true },
      { name: 'onset-date', type: 'date', required: false },
      { name: 'status', type: 'code', required: true },
    ],
  },
  medication: {
    kind: 'medication',
    idField: 'medication-id',
    fields: [
      { name: 'medication-id', type: 'ref', required: true },
      { name: 'patient-id', type: 'ref', required: true },
      { name: 'rx-code', type: 'code', required: true },
      { name: 'start-date', type: 'date', required: false },
      { name: 'status', type: 'code', required: true },
    ],
  },
};

const typePatterns: Readonly<Record<EhiFieldType, RegExp>> = {
  ref: /^[a-z0-9][a-z0-9:._/-]{0,199}$/,
  text: /^[\p{L}\p{N} .,'-]{1,200}$/u,
  date: /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
  code: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
};

export function valueMatchesType(value: string, type: EhiFieldType): boolean {
  return typePatterns[type].test(value);
}

/** Stable JSON: object keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function emptyKindCounts(): Record<EhiResourceKind, number> {
  return { patient: 0, encounter: 0, problem: 0, medication: 0 };
}

/**
 * Derives the per-kind SourceManifest the WP-110 mapping validator consumes.
 * The field list is the closed shape, so a mapping must classify every field.
 */
export function manifestForKind(bulk: EhiBulkExport, kind: EhiResourceKind): SourceManifest {
  const pages = bulk.pages.filter((page) => page.kind === kind);
  return {
    tenantId: bulk.tenantId,
    sourceSystemRef: bulk.sourceSystemRef,
    sourceManifestRef: `${bulk.exportRef}:${kind}`,
    sourceManifestHash: sha256({ exportHash: bulk.exportHash, kind }),
    structurallyReadable: pages.every((page) => page.structurallyReadable),
    inScopeRecordRefs: pages.flatMap((page) =>
      page.records.map((record) => record.sourceRecordRef),
    ),
    sourceFields: ehiResourceShapes[kind].fields.map((field) => field.name),
    synthetic: true,
  };
}

export function assertKind(kind: string): asserts kind is EhiResourceKind {
  if (!(ehiResourceKinds as readonly string[]).includes(kind)) {
    throw new EhiIngestError(`unknown EHI resource kind ${kind}`);
  }
}
