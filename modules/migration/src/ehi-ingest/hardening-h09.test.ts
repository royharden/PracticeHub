/**
 * WP-068 hardening H-09 (notes register NR-103..NR-106). Synthetic data only.
 */
import { describe, expect, it } from 'vitest';

import type { MappingRule, MappingVersion, WorkbenchContext } from '../types.js';
import {
  AthenaSimBulk,
  EhiIngestError,
  EhiStagingStore,
  applyEhiDeltaOperation,
  computeEhiDelta,
  ehiResourceShapes,
  ingestEhiBulk,
  purgeEhiStaging,
  sha256,
  type EhiBulkExport,
  type EhiDeltaSource,
  type EhiIngestMappingSet,
  type EhiResourceKind,
  type EhiSourceRecord,
} from './index.js';

const TENANT = 'northwind-synthetic';
const OTHER = 'riverbend-synthetic';
const WAVE = 'wave:ehi-h09';
const ctx = (tenantId: string): WorkbenchContext => ({
  tenantId,
  legalEntityId: 'le:synthetic',
  waveRef: WAVE,
});

function mappingFor(tenantId: string, kind: EhiResourceKind): MappingVersion {
  const rules: MappingRule[] = ehiResourceShapes[kind].fields.map((field) =>
    field.name === 'legacy-chart-note'
      ? {
          sourceField: field.name,
          disposition: 'excluded-with-reason',
          exclusionReasonRef: 'reason:free-text',
          dataClassification: 'phi',
        }
      : {
          sourceField: field.name,
          disposition: 'mapped',
          targetField: `${kind}.${field.name}`,
          dataClassification: 'phi',
        },
  );
  return {
    tenantId,
    sourceSystemRef: 'athena-sim-bulk',
    mappingVersionRef: `mapping:h09-${kind}`,
    mappingVersionHash: sha256({ kind, rules }),
    status: 'approved',
    approvedBy: 'staff:migration-owner',
    approvalEvidenceRef: `evidence:h09-${kind}`,
    rules,
    synthetic: true,
  };
}

function mappings(tenantId: string): EhiIngestMappingSet {
  return {
    tenantId,
    sourceSystemRef: 'athena-sim-bulk',
    mappingSetRef: 'mapping-set:h09',
    byKind: {
      patient: mappingFor(tenantId, 'patient'),
      encounter: mappingFor(tenantId, 'encounter'),
      problem: mappingFor(tenantId, 'problem'),
      medication: mappingFor(tenantId, 'medication'),
    },
    synthetic: true,
  };
}

function withLastPage(bulk: EhiBulkExport, extra: EhiSourceRecord): EhiBulkExport {
  const pages = [...bulk.pages];
  const last = pages.length - 1;
  const page = pages[last];
  if (page === undefined) throw new Error('fixture has no pages');
  pages[last] = { ...page, records: [...page.records, extra] };
  return { ...bulk, pages };
}

describe('NR-103: a frozen source refuses mutation', () => {
  it('setRecord and removeRecord throw after freeze and leave the records unchanged', () => {
    const sim = new AthenaSimBulk({ tenantId: TENANT, patientCount: 2 });
    sim.freeze();
    const before = sha256(sim.currentRecords());
    expect(() => sim.setRecord('patient', 'ath-pt-0001', { 'patient-id': 'ath-pt-0001' })).toThrow(
      /frozen/,
    );
    expect(() => sim.removeRecord('medication', 'ath-med-0001-1')).toThrow(/frozen/);
    expect(sha256(sim.currentRecords())).toBe(before);
    expect(sim.tick()).toBe(0);
  });

  it('control: mutation before the freeze still works', () => {
    const sim = new AthenaSimBulk({ tenantId: TENANT, patientCount: 1 });
    sim.removeRecord('medication', 'ath-med-0001-1');
    expect(sim.currentRecords().some((record) => record.kind === 'medication')).toBe(false);
  });
});

describe('NR-104: halt-before-write and purge isolation are pinned by tests', () => {
  it('a repeated record in the last page halts the ingest with nothing staged', () => {
    const bulk = new AthenaSimBulk({ tenantId: TENANT, patientCount: 3 }).exportBulk('export:dup');
    const lastPage = bulk.pages.at(-1);
    const repeated = lastPage?.records[0];
    if (repeated === undefined) throw new Error('fixture has no records');
    const staging = new EhiStagingStore();
    expect(() =>
      ingestEhiBulk({
        context: ctx(TENANT),
        bulk: withLastPage(bulk, repeated),
        mappings: mappings(TENANT),
        staging,
      }),
    ).toThrow(/repeats/);
    expect(staging.totalRowCount()).toBe(0);
  });

  it('a record from another tenant in the last page halts the ingest with nothing staged', () => {
    const bulk = new AthenaSimBulk({ tenantId: TENANT, patientCount: 3 }).exportBulk('export:xt');
    const lastPage = bulk.pages.at(-1);
    const template = lastPage?.records[0];
    if (template === undefined || lastPage === undefined) throw new Error('fixture has no records');
    const foreign: EhiSourceRecord = {
      ...template,
      tenantId: OTHER,
      sourceRecordRef: `${template.sourceRecordRef}-x`,
    };
    const staging = new EhiStagingStore();
    expect(() =>
      ingestEhiBulk({
        context: ctx(TENANT),
        bulk: withLastPage(bulk, foreign),
        mappings: mappings(TENANT),
        staging,
      }),
    ).toThrow(/outside its tenant/);
    expect(staging.totalRowCount()).toBe(0);
  });

  it("purging one tenant's wave leaves another tenant's same wave untouched", () => {
    const staging = new EhiStagingStore();
    for (const tenantId of [TENANT, OTHER]) {
      ingestEhiBulk({
        context: ctx(tenantId),
        bulk: new AthenaSimBulk({ tenantId, patientCount: 2 }).exportBulk(`export:${tenantId}`),
        mappings: mappings(tenantId),
        staging,
      });
    }
    expect(staging.count(OTHER, WAVE)).toBe(8);
    const receipt = purgeEhiStaging(staging, {
      tenantId: TENANT,
      waveRef: WAVE,
      reasonRef: 'reason:h09',
    });
    expect(receipt.purgedRowCount).toBe(8);
    expect(staging.count(TENANT, WAVE)).toBe(0);
    expect(staging.count(OTHER, WAVE)).toBe(8);
    expect(staging.totalRowCount()).toBe(8);
  });
});

describe('NR-105: unknown attributes are named by a stable hash, never by source key text', () => {
  const sensitiveKey = 'ssn 123-45-6789';

  function rejectWithKey(key: string) {
    const sim = new AthenaSimBulk({ tenantId: TENANT, patientCount: 2 });
    const patient = sim.currentRecords().find((record) => record.sourceRecordRef === 'ath-pt-0001');
    sim.setRecord('patient', 'ath-pt-0001', { ...(patient?.values ?? {}), [key]: 'x' });
    return ingestEhiBulk({
      context: ctx(TENANT),
      bulk: sim.exportBulk('export:unknown'),
      mappings: mappings(TENANT),
      staging: new EhiStagingStore(),
    });
  }

  it('does not echo the unknown key text anywhere in the findings', () => {
    const report = rejectWithKey(sensitiveKey);
    expect(report.rejectedRecordRefs).toEqual(['patient|ath-pt-0001']);
    const text = JSON.stringify(report.findings);
    expect(text).not.toContain('ssn');
    expect(text).not.toContain('123-45-6789');
    const names = report.findings[0]?.observedAttributeNames ?? [];
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^unknown-attribute-[0-9a-f]{16}$/);
  });

  it('the label is stable for the same key and distinct for different keys', () => {
    const first = rejectWithKey(sensitiveKey).findings[0];
    const again = rejectWithKey(sensitiveKey).findings[0];
    const other = rejectWithKey('another-key').findings[0];
    expect(again?.observedAttributeNames).toEqual(first?.observedAttributeNames);
    expect(again?.findingRef).toBe(first?.findingRef);
    expect(other?.observedAttributeNames).not.toEqual(first?.observedAttributeNames);
  });

  it('control: shape fields are still named plainly', () => {
    const sim = new AthenaSimBulk({ tenantId: TENANT, patientCount: 1 });
    const patient = sim.currentRecords().find((record) => record.kind === 'patient');
    sim.setRecord('patient', 'ath-pt-0001', {
      ...(patient?.values ?? {}),
      'birth-date': 'not-a-date',
    });
    const report = ingestEhiBulk({
      context: ctx(TENANT),
      bulk: sim.exportBulk('export:plain'),
      mappings: mappings(TENANT),
      staging: new EhiStagingStore(),
    });
    expect(report.findings.map((item) => item.observedAttributeNames)).toEqual([['birth-date']]);
  });
});

describe('NR-106: the delta apply re-checks the tenant of the record it re-reads', () => {
  it('refuses a re-read record from another tenant and stages nothing for it', () => {
    const sim = new AthenaSimBulk({ tenantId: TENANT, patientCount: 2 });
    const staging = new EhiStagingStore();
    ingestEhiBulk({
      context: ctx(TENANT),
      bulk: sim.exportBulk('export:base'),
      mappings: mappings(TENANT),
      staging,
    });
    sim.setRecord('encounter', 'ath-enc-new', {
      'encounter-id': 'ath-enc-new',
      'patient-id': 'ath-pt-0001',
      'start-date': '2026-02-02',
      'encounter-type': 'telehealth',
    });
    // A source that, after the delta was computed, returns the same records under another tenant.
    const flip = { foreign: false };
    const source: EhiDeltaSource = {
      tenantId: TENANT,
      sourceSystemRef: sim.sourceSystemRef,
      get frozen() {
        return sim.frozen;
      },
      currentRecords() {
        const records = sim.currentRecords();
        return flip.foreign ? records.map((record) => ({ ...record, tenantId: OTHER })) : records;
      },
      tick: () => sim.tick(),
      freeze: () => {
        sim.freeze();
      },
    };
    const scope = { context: ctx(TENANT), source, mappings: mappings(TENANT), staging };
    const [operation] = computeEhiDelta(scope);
    expect(operation).toEqual({
      op: 'upsert',
      kind: 'encounter',
      sourceRecordRef: 'ath-enc-new',
      reason: 'new',
    });
    if (operation === undefined) throw new Error('no delta');
    flip.foreign = true;
    const before = staging.totalRowCount();
    expect(() => applyEhiDeltaOperation(scope, operation)).toThrow(EhiIngestError);
    expect(staging.totalRowCount()).toBe(before);
    expect(staging.count(OTHER, WAVE)).toBe(0);
  });
});
