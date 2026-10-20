import { validateMappingForManifest } from '../mapping.js';
import type { MappingVersion, ValidationFinding, WorkbenchContext } from '../types.js';
import {
  EhiIngestError,
  ehiResourceShapes,
  emptyKindCounts,
  manifestForKind,
  sha256,
  valueMatchesType,
} from './shapes.js';
import type { EhiStagingStore } from './staging.js';
import {
  ehiResourceKinds,
  type EhiBulkExport,
  type EhiIngestMappingSet,
  type EhiIngestReport,
  type EhiSourceRecord,
  type EhiStagingRow,
} from './types.js';

function finding(
  record: EhiSourceRecord,
  category: ValidationFinding['category'],
  triage: ValidationFinding['triage'],
  attributeNames: readonly string[],
  mappingRuleRef?: string,
): ValidationFinding {
  return {
    findingRef: `ehi:${record.kind}:${record.sourceRecordRef}:${category}:${attributeNames.join('+')}`,
    tenantId: record.tenantId,
    recordRef: record.sourceRecordRef,
    category,
    triage,
    ...(mappingRuleRef === undefined ? {} : { mappingRuleRef }),
    observedAttributeNames: [...attributeNames],
    synthetic: true,
  };
}

/**
 * A stable label for an attribute that is not in the closed shape. The source's
 * key text is never echoed (it can itself carry data): the label is derived from
 * a hash of the key, so the same unknown key always gets the same label.
 */
export function unknownAttributeLabel(sourceKey: string): string {
  return `unknown-attribute-${sha256(sourceKey).slice(0, 16)}`;
}

/**
 * Checks one record against its closed shape and maps it through the approved
 * mapping version. Findings carry attribute names only, never source values;
 * attributes outside the closed shape are named by `unknownAttributeLabel`.
 */
export function mapEhiRecord(
  record: EhiSourceRecord,
  mapping: MappingVersion,
  waveRef: string,
):
  | { readonly ok: true; readonly row: EhiStagingRow }
  | { readonly ok: false; readonly findings: readonly ValidationFinding[] } {
  if (record.synthetic !== true) {
    throw new EhiIngestError('source record lacks the synthetic watermark');
  }
  const shape = ehiResourceShapes[record.kind];
  const findings: ValidationFinding[] = [];
  const known = new Set(shape.fields.map((field) => field.name));
  const unknown = Object.keys(record.values)
    .filter((name) => !known.has(name))
    .map(unknownAttributeLabel)
    .sort();
  if (unknown.length > 0) {
    findings.push(finding(record, 'schema', 'needs-source-correction', unknown));
  }
  if (record.values[shape.idField] !== record.sourceRecordRef) {
    findings.push(finding(record, 'schema', 'needs-source-correction', [shape.idField]));
  }
  for (const field of shape.fields) {
    const value = record.values[field.name];
    if (value === undefined || value === '') {
      if (field.required) {
        findings.push(
          finding(
            record,
            'required-field',
            'needs-source-correction',
            [field.name],
            `${mapping.mappingVersionRef}#${field.name}`,
          ),
        );
      }
    } else if (!valueMatchesType(value, field.type)) {
      findings.push(
        finding(
          record,
          'type-mismatch',
          'needs-source-correction',
          [field.name],
          `${mapping.mappingVersionRef}#${field.name}`,
        ),
      );
    }
  }
  if (findings.length > 0) {
    return { ok: false, findings };
  }
  const targetValues: Record<string, string> = {};
  for (const rule of mapping.rules) {
    const value = record.values[rule.sourceField];
    if (rule.disposition === 'mapped' && rule.targetField !== undefined && value !== undefined) {
      targetValues[rule.targetField] = value;
    }
  }
  return {
    ok: true,
    row: {
      tenantId: record.tenantId,
      waveRef,
      kind: record.kind,
      sourceRecordRef: record.sourceRecordRef,
      sourceContentHash: sha256(record.values),
      mappingVersionRef: mapping.mappingVersionRef,
      mappingVersionHash: mapping.mappingVersionHash,
      targetValues,
      synthetic: true,
    },
  };
}

/** Validates that a mapping set belongs to this tenant and source before any use. */
export function assertMappingSetScope(
  context: WorkbenchContext,
  sourceSystemRef: string,
  mappings: EhiIngestMappingSet,
): void {
  if (mappings.synthetic !== true) {
    throw new EhiIngestError('mapping set lacks the synthetic watermark');
  }
  if (mappings.tenantId !== context.tenantId) {
    throw new EhiIngestError('mapping set tenant differs from the workbench tenant');
  }
  if (mappings.sourceSystemRef !== sourceSystemRef) {
    throw new EhiIngestError('mapping set was approved for another source');
  }
  for (const kind of ehiResourceKinds) {
    const mapping = mappings.byKind[kind];
    if (mapping.tenantId !== context.tenantId || mapping.sourceSystemRef !== sourceSystemRef) {
      throw new EhiIngestError(`${kind} mapping is scoped to another tenant or source`);
    }
  }
}

/**
 * Synthetic bulk ingest into staging. Halts before any staging write when a page
 * is structurally unreadable, a record crosses tenant/kind scope, or a mapping
 * does not classify the closed shape exactly. Valid records stage atomically;
 * rejected records are listed with findings and never staged.
 */
export function ingestEhiBulk(input: {
  readonly context: WorkbenchContext;
  readonly bulk: EhiBulkExport;
  readonly mappings: EhiIngestMappingSet;
  readonly staging: EhiStagingStore;
}): EhiIngestReport {
  const { context, bulk, mappings, staging } = input;
  if (bulk.synthetic !== true) {
    throw new EhiIngestError('bulk export lacks the synthetic watermark');
  }
  if (bulk.tenantId !== context.tenantId) {
    throw new EhiIngestError('bulk export tenant differs from the workbench tenant');
  }
  assertMappingSetScope(context, bulk.sourceSystemRef, mappings);
  const unreadable = bulk.pages.filter((page) => !page.structurallyReadable);
  if (unreadable.length > 0) {
    throw new EhiIngestError(
      `file-structural-error: ${unreadable.map((page) => page.pageRef).join(', ')} unreadable; nothing staged`,
    );
  }
  if (staging.count(context.tenantId, context.waveRef) !== 0) {
    throw new EhiIngestError('wave staging is not empty; use the delta harness or purge first');
  }
  for (const kind of ehiResourceKinds) {
    validateMappingForManifest(mappings.byKind[kind], manifestForKind(bulk, kind));
  }

  const seen = new Set<string>();
  const sourceCountByKind = emptyKindCounts();
  const stagedCountByKind = emptyKindCounts();
  const rows: EhiStagingRow[] = [];
  const findings: ValidationFinding[] = [];
  const rejected: string[] = [];
  for (const page of bulk.pages) {
    for (const record of page.records) {
      if (record.tenantId !== context.tenantId || record.kind !== page.kind) {
        throw new EhiIngestError(`${page.pageRef} carries a record outside its tenant or kind`);
      }
      const key = `${record.kind}|${record.sourceRecordRef}`;
      if (seen.has(key)) {
        throw new EhiIngestError(`${page.pageRef} repeats ${key}`);
      }
      seen.add(key);
      sourceCountByKind[record.kind] += 1;
      const mapped = mapEhiRecord(record, mappings.byKind[record.kind], context.waveRef);
      if (mapped.ok) {
        rows.push(mapped.row);
        stagedCountByKind[record.kind] += 1;
      } else {
        findings.push(...mapped.findings);
        rejected.push(key);
      }
    }
  }
  for (const row of rows) {
    staging.put(row);
  }
  return {
    tenantId: context.tenantId,
    waveRef: context.waveRef,
    exportRef: bulk.exportRef,
    exportHash: bulk.exportHash,
    mappingSetRef: mappings.mappingSetRef,
    stagedCountByKind,
    sourceCountByKind,
    rejectedRecordRefs: rejected,
    findings,
    targetDataWrites: 0,
    synthetic: true,
  };
}
