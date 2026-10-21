import { describe, expect, it } from 'vitest';

import { MigrationMappingError } from '../mapping.js';
import type { MappingRule, MappingVersion, WorkbenchContext } from '../types.js';
import {
  AthenaSimBulk,
  EhiIngestError,
  EhiStagingStore,
  computeEhiDelta,
  createEhiDeltaDrain,
  ehiDeltaDrainVersion,
  ehiResourceKinds,
  ehiResourceShapes,
  ingestEhiBulk,
  purgeEhiStaging,
  rehearseDriftToZero,
  sha256,
  type EhiIngestMappingSet,
  type EhiResourceKind,
} from './index.js';

const tenant = 'northwind-synthetic';
const context: WorkbenchContext = {
  tenantId: tenant,
  legalEntityId: 'le:synthetic',
  waveRef: 'wave:ehi-1',
};

const excluded: Readonly<Record<string, string>> = {
  'legacy-chart-note': 'reason:free-text-not-migrated',
};
const unmapped = new Set(['sex', 'rendering-provider-ref']);

function mappingFor(
  kind: EhiResourceKind,
  version = 'v1',
  overrides: Partial<MappingVersion> = {},
): MappingVersion {
  const rules: MappingRule[] = ehiResourceShapes[kind].fields.map((field) => {
    const reason = excluded[field.name];
    if (reason !== undefined) {
      return {
        sourceField: field.name,
        disposition: 'excluded-with-reason',
        exclusionReasonRef: reason,
        dataClassification: 'phi',
      };
    }
    if (unmapped.has(field.name)) {
      return {
        sourceField: field.name,
        disposition: 'unmapped',
        dataClassification: 'demographic',
      };
    }
    return {
      sourceField: field.name,
      disposition: 'mapped',
      targetField: `${kind}.${field.name}`,
      dataClassification: 'phi',
    };
  });
  return {
    tenantId: tenant,
    sourceSystemRef: 'athena-sim-bulk',
    mappingVersionRef: `mapping:ehi-${kind}-${version}`,
    mappingVersionHash: sha256({ kind, version, rules }),
    status: 'approved',
    approvedBy: 'staff:migration-owner',
    approvalEvidenceRef: `evidence:ehi-${kind}-${version}`,
    rules,
    synthetic: true,
    ...overrides,
  };
}

function mappingSet(version = 'v1'): EhiIngestMappingSet {
  return {
    tenantId: tenant,
    sourceSystemRef: 'athena-sim-bulk',
    mappingSetRef: `mapping-set:ehi-${version}`,
    byKind: {
      patient: mappingFor('patient', version),
      encounter: mappingFor('encounter', version),
      problem: mappingFor('problem', version),
      medication: mappingFor('medication', version),
    },
    synthetic: true,
  };
}

function freshIngest(options: { patientCount?: number; driftSchedule?: number[] } = {}) {
  const sim = new AthenaSimBulk({
    tenantId: tenant,
    patientCount: options.patientCount ?? 60,
    driftSchedule: options.driftSchedule ?? [],
  });
  const staging = new EhiStagingStore();
  const report = ingestEhiBulk({
    context,
    bulk: sim.exportBulk('export:ehi-1'),
    mappings: mappingSet(),
    staging,
  });
  return { sim, staging, report };
}

describe('WP-068 synthetic bulk ingest (HAPPY)', () => {
  it('stages every record of every EHI kind across pages with zero target writes', () => {
    const { staging, report } = freshIngest();
    expect(report.sourceCountByKind).toEqual({
      patient: 60,
      encounter: 60,
      problem: 60,
      medication: 60,
    });
    expect(report.stagedCountByKind).toEqual(report.sourceCountByKind);
    expect(report.rejectedRecordRefs).toEqual([]);
    expect(report.findings).toEqual([]);
    expect(report.targetDataWrites).toBe(0);
    expect(staging.count(tenant, context.waveRef)).toBe(240);
  });

  it('stages only mapped fields; excluded and unmapped source fields never reach staging', () => {
    const { staging } = freshIngest({ patientCount: 3 });
    const row = staging.get(tenant, context.waveRef, 'patient', 'ath-pt-0001');
    expect(row).toBeDefined();
    expect(Object.keys(row?.targetValues ?? {}).sort()).toEqual([
      'patient.birth-date',
      'patient.family-name',
      'patient.given-name',
      'patient.patient-id',
    ]);
    expect(row?.mappingVersionRef).toBe('mapping:ehi-patient-v1');
  });

  it('the bulk export is deterministic and content-addressed', () => {
    const a = new AthenaSimBulk({ tenantId: tenant, patientCount: 5 }).exportBulk('export:x', 2);
    const b = new AthenaSimBulk({ tenantId: tenant, patientCount: 5 }).exportBulk('export:x', 2);
    expect(a.exportHash).toBe(b.exportHash);
    expect(a.pages.filter((page) => page.kind === 'patient')).toHaveLength(3);
    expect(a.pages.every((page) => page.records.every((record) => record.synthetic))).toBe(true);
  });
});

describe('WP-068 ingest refusals (FAILURE)', () => {
  it('halts on a structurally unreadable page with nothing staged', () => {
    const sim = new AthenaSimBulk({
      tenantId: tenant,
      patientCount: 4,
      corruptKinds: ['medication'],
    });
    const staging = new EhiStagingStore();
    expect(() =>
      ingestEhiBulk({
        context,
        bulk: sim.exportBulk('export:bad'),
        mappings: mappingSet(),
        staging,
      }),
    ).toThrow(/file-structural-error/);
    expect(staging.totalRowCount()).toBe(0);
  });

  it('rejects bad records with attribute-name findings and never stages them', () => {
    const sim = new AthenaSimBulk({ tenantId: tenant, patientCount: 4 });
    sim.setRecord('patient', 'ath-pt-0002', {
      'patient-id': 'ath-pt-0002',
      'given-name': 'Synth0002',
      'family-name': 'Testpatient',
      'birth-date': 'not-a-date',
    });
    sim.setRecord('problem', 'ath-prob-0003-1', {
      'problem-id': 'ath-prob-0003-1',
      'patient-id': 'ath-pt-0003',
      status: 'active',
    });
    const staging = new EhiStagingStore();
    const report = ingestEhiBulk({
      context,
      bulk: sim.exportBulk('export:mixed'),
      mappings: mappingSet(),
      staging,
    });
    expect(report.rejectedRecordRefs).toEqual(['patient|ath-pt-0002', 'problem|ath-prob-0003-1']);
    expect(report.findings.map((item) => [item.category, item.observedAttributeNames])).toEqual([
      ['type-mismatch', ['birth-date']],
      ['required-field', ['code']],
    ]);
    expect(JSON.stringify(report.findings)).not.toContain('not-a-date');
    expect(staging.get(tenant, context.waveRef, 'patient', 'ath-pt-0002')).toBeUndefined();
    expect(report.stagedCountByKind.patient).toBe(3);
  });

  it('refuses a mapping that leaves a shape field unclassified', () => {
    const set = mappingSet();
    const patient = set.byKind.patient;
    const broken: EhiIngestMappingSet = {
      ...set,
      byKind: {
        ...set.byKind,
        patient: { ...patient, rules: patient.rules.filter((rule) => rule.sourceField !== 'sex') },
      },
    };
    const sim = new AthenaSimBulk({ tenantId: tenant, patientCount: 2 });
    expect(() =>
      ingestEhiBulk({
        context,
        bulk: sim.exportBulk('export:y'),
        mappings: broken,
        staging: new EhiStagingStore(),
      }),
    ).toThrow(MigrationMappingError);
  });

  it('refuses an unapproved mapping version, another tenant and another source', () => {
    const sim = new AthenaSimBulk({ tenantId: tenant, patientCount: 2 });
    const bulk = sim.exportBulk('export:z');
    const set = mappingSet();
    const unapproved: EhiIngestMappingSet = {
      ...set,
      byKind: {
        ...set.byKind,
        encounter: mappingFor('encounter', 'v1', { status: 'review-required' }),
      },
    };
    expect(() =>
      ingestEhiBulk({ context, bulk, mappings: unapproved, staging: new EhiStagingStore() }),
    ).toThrow(/approval evidence/);
    expect(() =>
      ingestEhiBulk({
        context: { ...context, tenantId: 'other-synthetic' },
        bulk,
        mappings: set,
        staging: new EhiStagingStore(),
      }),
    ).toThrow(EhiIngestError);
    expect(() =>
      ingestEhiBulk({
        context,
        bulk,
        mappings: { ...set, sourceSystemRef: 'podium-sim' },
        staging: new EhiStagingStore(),
      }),
    ).toThrow(/another source/);
  });

  it('refuses a second bulk ingest into a wave that already has staging', () => {
    const { sim, staging } = freshIngest({ patientCount: 2 });
    expect(() =>
      ingestEhiBulk({
        context,
        bulk: sim.exportBulk('export:again'),
        mappings: mappingSet(),
        staging,
      }),
    ).toThrow(/not empty/);
  });
});

describe('WP-068 delta-to-zero harness', () => {
  it('drift-to-zero rehearsal reaches zero delta on a frozen source (HAPPY)', () => {
    const { sim, staging } = freshIngest({ driftSchedule: [5, 4, 3, 2] });
    const rehearsal = rehearseDriftToZero({
      context,
      source: sim,
      mappings: mappingSet(),
      staging,
      maxPasses: 10,
      freezeAfterPass: 3,
    });
    expect(rehearsal.outcome).toBe('reached-zero');
    expect(rehearsal.finalDelta).toBe(0);
    expect(rehearsal.sourceFrozen).toBe(true);
    expect(rehearsal.passes.map((pass) => pass.driftInjected)).toEqual([5, 4, 0]);
    expect(rehearsal.passes[0]?.deltaAfter).toBeGreaterThan(0);
    expect(rehearsal.passes.at(-1)?.deltaAfter).toBe(0);
    expect(computeEhiDelta({ context, source: sim, mappings: mappingSet(), staging })).toEqual([]);
    const live = sim.currentRecords().filter((record) => record.kind === 'encounter').length;
    expect(
      staging.rows(tenant, context.waveRef).filter((row) => row.kind === 'encounter'),
    ).toHaveLength(live);
  });

  it('classifies new, changed and removed source records and a mapping version change (BOUNDARY)', () => {
    const { sim, staging } = freshIngest({ patientCount: 3 });
    const patient = sim.currentRecords().find((record) => record.sourceRecordRef === 'ath-pt-0001');
    sim.setRecord('patient', 'ath-pt-0001', {
      ...(patient?.values ?? {}),
      'family-name': 'Changed',
    });
    sim.removeRecord('medication', 'ath-med-0002-1');
    sim.setRecord('encounter', 'ath-enc-new', {
      'encounter-id': 'ath-enc-new',
      'patient-id': 'ath-pt-0003',
      'start-date': '2026-02-02',
      'encounter-type': 'telehealth',
    });
    const delta = computeEhiDelta({ context, source: sim, mappings: mappingSet(), staging });
    expect(delta).toEqual([
      { op: 'upsert', kind: 'encounter', sourceRecordRef: 'ath-enc-new', reason: 'new' },
      { op: 'upsert', kind: 'patient', sourceRecordRef: 'ath-pt-0001', reason: 'changed' },
      {
        op: 'delete',
        kind: 'medication',
        sourceRecordRef: 'ath-med-0002-1',
        reason: 'source-removed',
      },
    ]);
    const remapped = computeEhiDelta({ context, source: sim, mappings: mappingSet('v2'), staging });
    expect(remapped.filter((operation) => operation.reason === 'remapped')).toHaveLength(10);
  });

  it('does not claim zero while the source is still live or rejected records remain (FAILURE)', () => {
    const live = freshIngest({ patientCount: 5, driftSchedule: [3, 3, 3, 3, 3, 3] });
    const unfrozen = rehearseDriftToZero({
      context,
      source: live.sim,
      mappings: mappingSet(),
      staging: live.staging,
      maxPasses: 3,
      freezeAfterPass: 99,
    });
    expect(unfrozen.outcome).toBe('not-converged');
    expect(unfrozen.sourceFrozen).toBe(false);

    const bad = freshIngest({ patientCount: 3 });
    bad.sim.setRecord('problem', 'ath-prob-bad', {
      'problem-id': 'ath-prob-bad',
      'patient-id': 'ath-pt-0001',
      status: 'active',
    });
    const stuck = rehearseDriftToZero({
      context,
      source: bad.sim,
      mappings: mappingSet(),
      staging: bad.staging,
      maxPasses: 4,
      freezeAfterPass: 1,
    });
    expect(stuck.outcome).toBe('not-converged');
    expect(stuck.finalDelta).toBe(1);
  });

  it('provides the wp068-ehi-delta-double/v1 drain WP-114 cutover consumes (RECOVERY)', () => {
    const { sim, staging } = freshIngest({ patientCount: 4, driftSchedule: [4] });
    sim.tick();
    sim.freeze();
    const drain = createEhiDeltaDrain({ context, source: sim, mappings: mappingSet(), staging });
    expect(drain.interfaceVersion).toBe(ehiDeltaDrainVersion);
    let remaining = drain.remaining(context.waveRef);
    expect(remaining).toBeGreaterThan(0);
    const seen: number[] = [remaining];
    while (remaining > 0) {
      remaining = drain.drainOne(context.waveRef);
      seen.push(remaining);
    }
    expect(seen.at(-1)).toBe(0);
    expect(seen.every((value, index) => index === 0 || value < (seen[index - 1] ?? Infinity))).toBe(
      true,
    );
    expect(() => drain.remaining('wave:other')).toThrow(/panel/);

    // A frozen source refuses mutation (NR-103), so the rejected record is injected before the freeze.
    const bad = freshIngest({ patientCount: 2 });
    bad.sim.setRecord('problem', 'ath-prob-bad', {
      'problem-id': 'ath-prob-bad',
      'patient-id': 'ath-pt-0001',
      status: 'active',
    });
    bad.sim.freeze();
    const stuck = createEhiDeltaDrain({
      context,
      source: bad.sim,
      mappings: mappingSet(),
      staging: bad.staging,
    });
    expect(() => stuck.drainOne(context.waveRef)).toThrow(/cannot drain/);
  });
});

describe('WP-068 staging purge', () => {
  it('purges one tenant wave completely and leaves other scopes intact (HAPPY/BOUNDARY)', () => {
    const { staging } = freshIngest({ patientCount: 5 });
    const otherWave: WorkbenchContext = { ...context, waveRef: 'wave:ehi-2' };
    ingestEhiBulk({
      context: otherWave,
      bulk: new AthenaSimBulk({ tenantId: tenant, patientCount: 2 }).exportBulk('export:w2'),
      mappings: mappingSet(),
      staging,
    });
    const receipt = purgeEhiStaging(staging, {
      tenantId: tenant,
      waveRef: context.waveRef,
      reasonRef: 'reason:rehearsal-reset',
    });
    expect(receipt.purgedByKind).toEqual({ patient: 5, encounter: 5, problem: 5, medication: 5 });
    expect(receipt.purgedRowCount).toBe(20);
    expect(receipt.remainingRowCount).toBe(0);
    expect(staging.count(tenant, context.waveRef)).toBe(0);
    expect(staging.count(tenant, otherWave.waveRef)).toBe(8);
  });

  it('is idempotent and allows a clean re-ingest after purge (RECOVERY)', () => {
    const { sim, staging } = freshIngest({ patientCount: 3 });
    purgeEhiStaging(staging, {
      tenantId: tenant,
      waveRef: context.waveRef,
      reasonRef: 'reason:reset',
    });
    const again = purgeEhiStaging(staging, {
      tenantId: tenant,
      waveRef: context.waveRef,
      reasonRef: 'reason:reset',
    });
    expect(again.purgedRowCount).toBe(0);
    const report = ingestEhiBulk({
      context,
      bulk: sim.exportBulk('export:re'),
      mappings: mappingSet(),
      staging,
    });
    expect(Object.values(report.stagedCountByKind).reduce((a, b) => a + b, 0)).toBe(12);
  });

  it('refuses an unconstrained purge scope (FAILURE)', () => {
    const { staging } = freshIngest({ patientCount: 1 });
    expect(() =>
      purgeEhiStaging(staging, { tenantId: tenant, waveRef: '*', reasonRef: 'reason:x' }),
    ).toThrow(EhiIngestError);
    expect(staging.count(tenant, context.waveRef)).toBe(4);
  });

  it('covers every declared resource kind', () => {
    expect([...ehiResourceKinds]).toEqual(Object.keys(ehiResourceShapes));
  });
});
