/**
 * WP-111 hardening H-10 (NR-147): the bulk-merge policy is validated before
 * the run, so a policy the run cannot honour never starts merging.
 */
import { describe, expect, it } from 'vitest';

import type { CapabilityGrantSnapshot, WorkbenchContext } from '../types.js';
import {
  BULK_MERGE_MAX_BATCH,
  FrozenMergeEngineDouble,
  ImportMergeQueue,
  MergeLedger,
  assertBulkMergePolicy,
  defaultBulkMergePolicy,
  executeBulkMerge,
  type ImportIdentityCandidate,
} from './index.js';

const tenant = 'northwind-synthetic';
const context: WorkbenchContext = {
  tenantId: tenant,
  legalEntityId: 'le:synthetic',
  waveRef: 'wave:acq-1',
};
const grants: readonly CapabilityGrantSnapshot[] = [
  { tenantId: tenant, capabilityId: 'identity.merge-governance', state: 'simulated' },
  { tenantId: tenant, capabilityId: 'migration.workbench', state: 'simulated' },
];

const candidate = (index: number): ImportIdentityCandidate => ({
  tenantId: tenant,
  waveRef: context.waveRef,
  candidateRef: `cand-${String(index)}`,
  importedPersonId: `imp-${String(index)}`,
  existingPersonId: `ph-${String(index)}`,
  matchedAttributes: ['given-name', 'family-name', 'birth-date'],
  conflictingAttributes: [],
  confidence: 'high',
  score: 950,
  specializedPatterns: [],
  contactRisk: false,
  sourceIdRefs: [`athena:${String(index)}`],
  synthetic: true,
});

describe('NR-147: bulk-merge policy validated before the run', () => {
  it('refuses a policy above the 9,999-case ordinal limit before merging anyone', () => {
    const engine = new FrozenMergeEngineDouble();
    const queue = new ImportMergeQueue(engine, context, 'staff:migration-bot');
    const ledger = new MergeLedger(tenant);
    queue.feed([candidate(1), candidate(2)]);
    const ids = queue.openCases().map((queued) => queued.caseId);
    expect(() =>
      executeBulkMerge({
        engine,
        queue,
        ledger,
        grants,
        policy: { ...defaultBulkMergePolicy, maxBatchSize: BULK_MERGE_MAX_BATCH + 1 },
        request: {
          runRef: 'bulk:acq-1:h10',
          caseIds: ids,
          approvedBy: 'staff:migration-lead',
          secondApprover: 'staff:privacy-officer',
          evidenceRef: 'evidence:h10',
          rationale: 'synthetic',
          artifactsOf: () => [],
          sourceIdRefsOf: () => [],
        },
      }),
    ).toThrow(/bulk merge policy invalid/);
    expect(engine.calls.executeMerge).toBe(0);
    expect(ledger.events()).toHaveLength(0);
    expect(ledger.run('bulk:acq-1:h10')).toBeUndefined();
  });

  it('refuses malformed policy values and accepts the default and the boundary', () => {
    for (const bad of [
      { maxBatchSize: 0 },
      { maxBatchSize: 1.5 },
      { dualControlMinSize: 0 },
      { minScore: Number.NaN },
      { eligibleLanes: [] },
    ]) {
      expect(() => assertBulkMergePolicy({ ...defaultBulkMergePolicy, ...bad })).toThrow(
        /policy invalid/,
      );
    }
    expect(() => assertBulkMergePolicy(defaultBulkMergePolicy)).not.toThrow();
    expect(() =>
      assertBulkMergePolicy({ ...defaultBulkMergePolicy, maxBatchSize: BULK_MERGE_MAX_BATCH }),
    ).not.toThrow();
  });
});
