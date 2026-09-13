import { describe, expect, it } from 'vitest';

import { foldMigrationBatch } from './batch.js';
import { evaluateWaveImportPreflight } from './capability-preflight.js';
import { cloneTemplateForSource, validateMappingForManifest } from './mapping.js';
import { reconcileControlTotals } from './reconciliation.js';
import { planBatchRollback } from './rollback.js';
import type { MappingVersion, SourceManifest } from './types.js';

const tenant = 'northwind-synthetic';
const hash = 'a'.repeat(64);

describe('source-specific mapping', () => {
  const template: MappingVersion = {
    tenantId: tenant,
    sourceSystemRef: 'legacy-a',
    mappingVersionRef: 'mapping:a',
    mappingVersionHash: hash,
    status: 'approved',
    approvedBy: 'staff:owner',
    approvalEvidenceRef: 'evidence:a',
    rules: [
      {
        sourceField: 'patient-id',
        disposition: 'mapped',
        targetField: 'person.source-id',
        dataClassification: 'demographic',
      },
    ],
    synthetic: true,
  };

  it('copies a prior template only as review-required', () => {
    const clone = cloneTemplateForSource(template, tenant, 'legacy-b', 'mapping:b', 'b'.repeat(64));
    expect(clone.status).toBe('review-required');
    const manifest: SourceManifest = {
      tenantId: tenant,
      sourceSystemRef: 'legacy-b',
      sourceManifestRef: 'manifest:b',
      sourceManifestHash: hash,
      structurallyReadable: true,
      inScopeRecordRefs: ['record-1'],
      sourceFields: ['patient-id'],
      synthetic: true,
    };
    expect(() => validateMappingForManifest(clone, manifest)).toThrow('source-specific approval');
  });

  it('rejects duplicate source fields and unknown runtime mapping discriminators', () => {
    const manifest: SourceManifest = {
      tenantId: tenant,
      sourceSystemRef: 'legacy-a',
      sourceManifestRef: 'manifest:a',
      sourceManifestHash: hash,
      structurallyReadable: true,
      inScopeRecordRefs: ['record-1'],
      sourceFields: ['patient-id', 'patient-id'],
      synthetic: true,
    };
    expect(() => validateMappingForManifest(template, manifest)).toThrow('duplicate field');
    const malformed = {
      ...template,
      rules: [{ ...template.rules[0], disposition: 'guessed' }],
    } as unknown as MappingVersion;
    expect(() =>
      validateMappingForManifest(malformed, { ...manifest, sourceFields: ['patient-id'] }),
    ).toThrow('unknown disposition');
  });
});

describe('tenant-scoped controls and capability preflight', () => {
  it('refuses a cross-tenant control total', () => {
    const base = {
      totalRef: 'total:records',
      name: 'records',
      valueMinor: '1',
      unit: 'records',
      checksum: hash,
      synthetic: true as const,
    };
    expect(() =>
      reconcileControlTotals(
        tenant,
        [{ ...base, tenantId: tenant, side: 'source' }],
        [{ ...base, tenantId: 'riverbend-synthetic', side: 'candidate-target' }],
      ),
    ).toThrow('tenant differs');
  });

  it('rejects duplicate semantic keys and totals placed on the wrong side', () => {
    const base = {
      totalRef: 'total:records',
      tenantId: tenant,
      name: 'records',
      valueMinor: '1',
      unit: 'records',
      checksum: hash,
      synthetic: true as const,
    };
    expect(() =>
      reconcileControlTotals(
        tenant,
        [
          { ...base, side: 'source' },
          { ...base, totalRef: 'total:records-duplicate', valueMinor: '999', side: 'source' },
        ],
        [{ ...base, side: 'candidate-target' }],
      ),
    ).toThrow('duplicate source control total');
    expect(() =>
      reconcileControlTotals(
        tenant,
        [{ ...base, side: 'candidate-target' }],
        [{ ...base, side: 'candidate-target' }],
      ),
    ).toThrow('wrong side');
  });

  it('requires canonical integers, supported units and constrained approved explanations', () => {
    const base = {
      totalRef: 'total:records',
      tenantId: tenant,
      name: 'records',
      valueMinor: '1',
      unit: 'records',
      checksum: hash,
      synthetic: true as const,
    };
    expect(() =>
      reconcileControlTotals(
        tenant,
        [{ ...base, valueMinor: '01', side: 'source' }],
        [{ ...base, side: 'candidate-target' }],
      ),
    ).toThrow('exact integer');
    expect(() =>
      reconcileControlTotals(
        tenant,
        [{ ...base, unit: 'invented-unit', side: 'source' }],
        [{ ...base, unit: 'invented-unit', side: 'candidate-target' }],
      ),
    ).toThrow('unknown unit');
    expect(() =>
      reconcileControlTotals(
        tenant,
        [{ ...base, side: 'source' }],
        [{ ...base, valueMinor: '2', side: 'candidate-target' }],
        { 'records|records|': '' },
      ),
    ).toThrow('approved constrained evidence');
  });

  it('requires workbench, wave and the same-tenant target capability', () => {
    const context = { tenantId: tenant, legalEntityId: 'le-1', waveRef: 'wave-1' };
    const completed = {
      tenantId: tenant,
      waveRef: 'wave-1',
      readiness: 'ready-for-review' as const,
      targetDataWrites: 0 as const,
      controlTotals: [
        {
          name: 'records',
          state: 'reconciled' as const,
          source: {
            totalRef: 'total:source',
            tenantId: tenant,
            side: 'source' as const,
            name: 'records',
            valueMinor: '1',
            unit: 'records',
            checksum: hash,
            synthetic: true as const,
          },
          target: {
            totalRef: 'total:target',
            tenantId: tenant,
            side: 'candidate-target' as const,
            name: 'records',
            valueMinor: '1',
            unit: 'records',
            checksum: hash,
            synthetic: true as const,
          },
        },
      ],
    };
    const allowed = evaluateWaveImportPreflight(
      context,
      completed,
      ['identity.person-model'],
      [
        { tenantId: tenant, capabilityId: 'migration.workbench', state: 'simulated' },
        {
          tenantId: tenant,
          capabilityId: 'migration.wave-import',
          state: 'simulated',
          waveRef: 'wave-1',
        },
        { tenantId: tenant, capabilityId: 'identity.person-model', state: 'scaffolded' },
      ],
    );
    expect(allowed.allowed).toBe(true);
    const denied = evaluateWaveImportPreflight(
      context,
      completed,
      ['identity.person-model'],
      [
        { tenantId: tenant, capabilityId: 'migration.workbench', state: 'simulated' },
        {
          tenantId: tenant,
          capabilityId: 'migration.wave-import',
          state: 'simulated',
          waveRef: 'wave-1',
        },
        { tenantId: 'riverbend-synthetic', capabilityId: 'identity.person-model', state: 'active' },
      ],
    );
    expect(denied).toEqual({
      allowed: false,
      reasons: ['target-below-scaffolded:identity.person-model'],
    });
    expect(
      evaluateWaveImportPreflight(
        context,
        null,
        ['identity.person-model'],
        [
          { tenantId: tenant, capabilityId: 'migration.workbench', state: 'simulated' },
          {
            tenantId: tenant,
            capabilityId: 'migration.wave-import',
            state: 'simulated',
            waveRef: 'wave-1',
          },
          { tenantId: tenant, capabilityId: 'identity.person-model', state: 'scaffolded' },
        ],
      ).reasons,
    ).toContain('completed-reconciliation-required');
    const duplicate = evaluateWaveImportPreflight(
      context,
      completed,
      ['identity.person-model'],
      [
        { tenantId: tenant, capabilityId: 'migration.workbench', state: 'simulated' },
        { tenantId: tenant, capabilityId: 'migration.workbench', state: 'active' },
        {
          tenantId: tenant,
          capabilityId: 'migration.wave-import',
          state: 'simulated',
          waveRef: 'wave-1',
        },
        { tenantId: tenant, capabilityId: 'identity.person-model', state: 'scaffolded' },
      ],
    );
    expect(duplicate.reasons).toContain('duplicate-capability-grant');
    const malformedCompleted = {
      ...completed,
      controlTotals: completed.controlTotals.map((item) => ({
        ...item,
        state: 'invented',
      })),
    } as unknown as typeof completed;
    expect(
      evaluateWaveImportPreflight(
        context,
        malformedCompleted,
        ['identity.person-model'],
        [
          { tenantId: tenant, capabilityId: 'migration.workbench', state: 'simulated' },
          {
            tenantId: tenant,
            capabilityId: 'migration.wave-import',
            state: 'simulated',
            waveRef: 'wave-1',
          },
          { tenantId: tenant, capabilityId: 'identity.person-model', state: 'scaffolded' },
        ],
      ).reasons,
    ).toContain('invalid-reconciliation-state');
    const existingTotal = completed.controlTotals[0];
    if (existingTotal === undefined) throw new Error('test setup requires a control total');
    const duplicateTotals = {
      ...completed,
      controlTotals: [
        ...completed.controlTotals,
        {
          ...existingTotal,
          source: { ...existingTotal.source, totalRef: 'total:source-duplicate' },
          target: { ...existingTotal.target, totalRef: 'total:target-duplicate' },
        },
      ],
    };
    expect(
      evaluateWaveImportPreflight(
        context,
        duplicateTotals,
        ['identity.person-model'],
        [
          { tenantId: tenant, capabilityId: 'migration.workbench', state: 'simulated' },
          {
            tenantId: tenant,
            capabilityId: 'migration.wave-import',
            state: 'simulated',
            waveRef: 'wave-1',
          },
          { tenantId: tenant, capabilityId: 'identity.person-model', state: 'scaffolded' },
        ],
      ).reasons,
    ).toContain('invalid-reconciliation-state');
  });
});

describe('event replay and rollback', () => {
  it('rejects an event gap and a review link on a blocked batch', () => {
    const initialized = {
      eventType: 'initialized' as const,
      tenantId: tenant,
      batchRef: 'batch-1',
      version: 1 as const,
      sourceSystemRef: 'legacy-a',
      synthetic: true as const,
    };
    expect(() =>
      foldMigrationBatch([
        initialized,
        {
          eventType: 'dry-run-recorded',
          tenantId: tenant,
          batchRef: 'batch-1',
          version: 3,
          runRef: 'run-1',
          readiness: 'blocked',
          synthetic: true,
        },
      ]),
    ).toThrow('version gap');
    expect(() =>
      foldMigrationBatch([
        initialized,
        {
          eventType: 'dry-run-recorded',
          tenantId: tenant,
          batchRef: 'batch-1',
          version: 2,
          runRef: 'run-1',
          readiness: 'blocked',
          synthetic: true,
        },
        {
          eventType: 'review-workitem-linked',
          tenantId: tenant,
          batchRef: 'batch-1',
          version: 3,
          runRef: 'run-1',
          workItemRef: 'workitem-1',
          workItemTenantId: tenant,
          evidenceHash: hash,
          synthetic: true,
        },
      ]),
    ).toThrow('blocked batch');
  });

  it('rejects a malformed initial version and clears an obsolete review link on a successor run', () => {
    const malformed = {
      eventType: 'initialized',
      tenantId: tenant,
      batchRef: 'batch-1',
      version: 99,
      sourceSystemRef: 'legacy-a',
      synthetic: true,
    } as unknown as Parameters<typeof foldMigrationBatch>[0][number];
    expect(() => foldMigrationBatch([malformed])).toThrow('version 1');
    expect(() =>
      foldMigrationBatch([
        {
          eventType: 'initialized',
          tenantId: tenant,
          batchRef: 'batch-unknown-readiness',
          version: 1,
          sourceSystemRef: 'legacy-a',
          synthetic: true,
        },
        {
          eventType: 'dry-run-recorded',
          tenantId: tenant,
          batchRef: 'batch-unknown-readiness',
          version: 2,
          runRef: 'run-1',
          readiness: 'invented',
          synthetic: true,
        } as unknown as Parameters<typeof foldMigrationBatch>[0][number],
      ]),
    ).toThrow('unknown readiness');
    const state = foldMigrationBatch([
      {
        eventType: 'initialized',
        tenantId: tenant,
        batchRef: 'batch-1',
        version: 1,
        sourceSystemRef: 'legacy-a',
        synthetic: true,
      },
      {
        eventType: 'dry-run-recorded',
        tenantId: tenant,
        batchRef: 'batch-1',
        version: 2,
        runRef: 'run-1',
        readiness: 'ready-for-review',
        synthetic: true,
      },
      {
        eventType: 'review-workitem-linked',
        tenantId: tenant,
        batchRef: 'batch-1',
        version: 3,
        runRef: 'run-1',
        workItemRef: 'workitem-1',
        workItemTenantId: tenant,
        evidenceHash: hash,
        synthetic: true,
      },
      {
        eventType: 'dry-run-recorded',
        tenantId: tenant,
        batchRef: 'batch-1',
        version: 4,
        runRef: 'run-2',
        readiness: 'blocked',
        synthetic: true,
      },
    ]);
    expect(state.latestReadiness).toBe('blocked');
    expect(state.reviewWorkItemRef).toBeUndefined();
  });

  it('holds post-batch user activity instead of blindly overwriting it', () => {
    const decisions = planBatchRollback(tenant, 'batch-1', [
      {
        tenantId: tenant,
        batchRef: 'batch-1',
        recordRef: 'target-1',
        sourceRecordRef: 'source-1',
        batchChanged: true,
        userTouchedAfterBatch: false,
        lastAuthoritativeEventRef: 'event-1',
      },
      {
        tenantId: tenant,
        batchRef: 'batch-1',
        recordRef: 'target-2',
        sourceRecordRef: 'source-2',
        batchChanged: true,
        userTouchedAfterBatch: true,
        lastAuthoritativeEventRef: 'event-2',
      },
    ]);
    expect(decisions.map((decision) => decision.action)).toEqual([
      'compensate',
      'manual-reconciliation-hold',
    ]);
  });
});
