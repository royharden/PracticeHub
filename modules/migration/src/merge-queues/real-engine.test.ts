import { describe, expect, it } from 'vitest';

import type { CapabilityGrantSnapshot, WorkbenchContext } from '../types.js';
import {
  FrozenMergeEngineDouble,
  ImportMergeQueue,
  MergeLedger,
  bulkMergeEventId,
  executeBulkMerge,
  identityIdPattern,
  runUnmergeDrill,
  type EngineMergeArtifact,
  type IdentityMergeEnginePort,
  type ImportIdentityCandidate,
} from './index.js';

/**
 * Binds the REAL frozen WP-016 engine (modules/identity/src/merge.ts) read-only,
 * test-only. `@practicehub/migration` does not depend on `@practicehub/identity`,
 * so the module is loaded by a computed path the compiler does not follow; the
 * functions are used unchanged through the migration port (FWD-MIG-111-ENGINE-BIND
 * replaces this with a real workspace dependency and adapter).
 */
async function realEngine(): Promise<IdentityMergeEnginePort> {
  const path = new URL('../../../identity/src/merge.ts', import.meta.url).href;
  const real = (await import(/* @vite-ignore */ path)) as Record<string, unknown>;
  const names = [
    'openMergeCase',
    'executeMerge',
    'resolveMergedPerson',
    'executeUnmerge',
    'propagateUnmerge',
    'unmergeClosureReport',
  ] as const;
  for (const name of names) {
    if (typeof real[name] !== 'function') {
      throw new Error(`real merge engine lacks ${name}`);
    }
  }
  return real as unknown as IdentityMergeEnginePort;
}

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

function candidate(index: number): ImportIdentityCandidate {
  const n = String(index).padStart(5, '0');
  return {
    tenantId: tenant,
    waveRef: context.waveRef,
    candidateRef: `cand-${n}`,
    importedPersonId: `imp-${n}`,
    existingPersonId: `ph-${n}`,
    matchedAttributes: ['given-name', 'family-name', 'birth-date'],
    conflictingAttributes: [],
    confidence: 'high',
    score: 950,
    specializedPatterns: [],
    contactRisk: false,
    sourceIdRefs: [`athena:${n}`],
    synthetic: true,
  };
}

const artifactsOf = (personId: string): readonly EngineMergeArtifact[] => [
  { kind: 'patient-record', artifactRef: `chart-${personId}`, ownerPersonId: personId },
  { kind: 'source-identifier', artifactRef: `srcid-${personId}`, ownerPersonId: personId },
];

async function bulkRun(engine: IdentityMergeEnginePort, runRef: string) {
  const queue = new ImportMergeQueue(engine, context, 'staff:migration-bot');
  const ledger = new MergeLedger(tenant);
  queue.feed([1, 2, 3].map(candidate));
  const ids = queue.openCases().map((item) => item.caseId);
  const run = executeBulkMerge({
    engine,
    queue,
    ledger,
    grants,
    request: {
      runRef,
      caseIds: ids,
      approvedBy: 'staff-migration-lead',
      secondApprover: 'staff-privacy-officer',
      evidenceRef: 'evidence:bulk-001',
      rationale: 'synthetic import high-confidence duplicates',
      artifactsOf,
      sourceIdRefsOf: (personId) => [`athena:${personId}`],
    },
  });
  return { queue, ledger, run };
}

describe('WP-111 rework F1: engine ids match the frozen identity engine', () => {
  it('bulk merge and the unmerge drill run end to end against the REAL WP-016 engine', async () => {
    const engine = await realEngine();
    for (const runRef of ['bulk:acq-1:001', 'bulk-acq-1-001', `run.acq_1.${'x'.repeat(110)}`]) {
      const { ledger, run } = await bulkRun(engine, runRef);
      expect(run.items.map((item) => item.reason ?? item.outcome)).toEqual([
        'merged',
        'merged',
        'merged',
      ]);
      expect(ledger.lineage()).toHaveLength(6);
      const event = ledger.events()[0];
      if (event === undefined) {
        throw new Error('no merge recorded');
      }
      const drill = runUnmergeDrill({
        engine,
        ledger,
        mergeEventId: event.eventId,
        unmergeEventId: `${event.eventId}-u1`,
        approvedBy: 'staff-privacy-officer',
        rationale: 'drill: wrong merge detected',
        postMergeArtifacts: [],
        exposures: [
          {
            system: 'claims',
            artifactRef: 'claim-paid-1',
            exposedPersonId: event.survivorPersonId,
            correctPersonId: event.mergedPersonId,
            status: 'adjudicated-paid',
            electronicCorrectionSupported: true,
          },
          {
            system: 'portal-results',
            artifactRef: 'result-released-1',
            exposedPersonId: event.survivorPersonId,
            correctPersonId: event.mergedPersonId,
            status: 'released',
            electronicCorrectionSupported: true,
          },
        ],
        confirmations: new Map(),
      });
      expect(drill.outcome).toBe('unmerged');
      expect(drill.restoredCount).toBe(2);
      expect(drill.claimActions).toEqual([
        { artifactRef: 'claim-paid-1', action: 'rcm-void-rebill-refund' },
      ]);
      expect(drill.wrongDisclosureIncidents).toEqual(['result-released-1']);
      expect(drill.aliasRedirectCleared).toBe(true);
    }
  });

  it('bulk event ids are in the identity alphabet whatever the run ref', () => {
    for (const runRef of ['bulk:acq-1:001', 'A_B.C', 'r'.repeat(128)]) {
      const id = bulkMergeEventId(runRef, 9999);
      expect(id).toMatch(identityIdPattern);
      expect(`${id}-u1`).toMatch(identityIdPattern);
    }
    expect(bulkMergeEventId('same', 1)).toBe(bulkMergeEventId('same', 1));
    expect(bulkMergeEventId('a', 1)).not.toBe(bulkMergeEventId('b', 1));
    expect(() => bulkMergeEventId('a', 0)).toThrow();
  });

  it('the double enforces the real id pattern and the rationale requirement (F2)', () => {
    const double = new FrozenMergeEngineDouble();
    expect(identityIdPattern.source).toBe('^[a-z0-9][a-z0-9-]{0,63}$');
    const base = {
      caseId: 'case-1',
      tenantId: tenant,
      kind: 'possible-match' as const,
      personIds: ['p-1', 'p-2'],
      matchedAttributes: ['given-name', 'birth-date'] as const,
      conflictingAttributes: [],
      confidence: 'high' as const,
      contactRisk: false,
      sourceIdRefs: [],
      specializedPatterns: [],
      openedBy: 'staff',
      source: 'test',
    };
    expect(() => double.openMergeCase({ ...base, caseId: 'case:1' })).toThrow(/constrained/);
    const mergeCase = double.openMergeCase(base);
    const merge = {
      mergeCase,
      basis: { comparedAttributes: ['given-name', 'birth-date'] as const, decidedBy: 'staff' },
      survivorPersonId: 'p-1',
      mergedPersonId: 'p-2',
      artifacts: [],
      mergedPersonSourceIdRefs: [],
      rationale: 'dup',
      evidenceRef: 'evidence-1',
    };
    expect(() => double.executeMerge({ ...merge, eventId: 'bulk:acq-1:001.m0001' })).toThrow(
      /constrained/,
    );
    expect(() => double.executeMerge({ ...merge, eventId: `e${'1'.repeat(64)}` })).toThrow(
      /constrained/,
    );
    expect(() => double.executeMerge({ ...merge, eventId: 'evt-1', rationale: '' })).toThrow(
      /reason/,
    );
    expect(double.executeMerge({ ...merge, eventId: 'evt-1' }).event.eventId).toBe('evt-1');
  });
});
