import { describe, expect, it } from 'vitest';

import type { CapabilityGrantSnapshot, WorkbenchContext } from '../types.js';
import {
  FrozenMergeEngineDouble,
  ImportMergeQueue,
  MergeLedger,
  MergeQueueError,
  defaultBulkMergePolicy,
  executeBulkMerge,
  runUnmergeDrill,
  type BulkMergeRequest,
  type EngineDownstreamExposure,
  type EngineMergeArtifact,
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

function pad(value: number): string {
  return String(value).padStart(5, '0');
}

function candidate(
  index: number,
  overrides: Partial<ImportIdentityCandidate> = {},
): ImportIdentityCandidate {
  return {
    tenantId: tenant,
    waveRef: context.waveRef,
    candidateRef: `cand-${pad(index)}`,
    importedPersonId: `imp-${pad(index)}`,
    existingPersonId: `ph-${pad(index)}`,
    matchedAttributes: ['given-name', 'family-name', 'birth-date'],
    conflictingAttributes: [],
    confidence: 'high',
    score: 950,
    specializedPatterns: [],
    contactRisk: false,
    sourceIdRefs: [`athena:${pad(index)}`],
    synthetic: true,
    ...overrides,
  };
}

/** A mixed synthetic import: high-confidence, low, conflicting, specialized, ambiguous. */
function importScaleCandidates(count: number): ImportIdentityCandidate[] {
  const list: ImportIdentityCandidate[] = [];
  for (let index = 1; index <= count; index += 1) {
    if (index % 10 === 0) {
      list.push(candidate(index, { confidence: 'medium', score: 700 }));
    } else if (index % 10 === 1) {
      list.push(
        candidate(index, {
          conflictingAttributes: ['birth-date'],
          matchedAttributes: ['given-name', 'family-name'],
        }),
      );
    } else if (index % 25 === 2) {
      list.push(candidate(index, { specializedPatterns: ['minor-or-proxy'] }));
    } else {
      list.push(candidate(index));
    }
  }
  // Two imported persons that both match one existing chart: ambiguous.
  list.push(candidate(count + 1, { existingPersonId: `ph-${pad(3)}` }));
  return list;
}

function artifactsOf(personId: string): readonly EngineMergeArtifact[] {
  return [
    { kind: 'patient-record', artifactRef: `chart:${personId}`, ownerPersonId: personId },
    { kind: 'source-identifier', artifactRef: `srcid:${personId}`, ownerPersonId: personId },
    { kind: 'timeline-entry', artifactRef: `tl:${personId}`, ownerPersonId: personId },
  ];
}

function bulkRequest(
  caseIds: readonly string[],
  overrides: Partial<BulkMergeRequest> = {},
): BulkMergeRequest {
  return {
    runRef: 'bulk:acq-1:001',
    caseIds,
    approvedBy: 'staff:migration-lead',
    secondApprover: 'staff:privacy-officer',
    evidenceRef: 'evidence:bulk-001',
    rationale: 'synthetic import high-confidence duplicates',
    artifactsOf,
    sourceIdRefsOf: (personId) => [`athena:${personId}`],
    ...overrides,
  };
}

function setup(count = 2000) {
  const engine = new FrozenMergeEngineDouble();
  const queue = new ImportMergeQueue(engine, context, 'staff:migration-bot');
  const ledger = new MergeLedger(tenant);
  const receipt = queue.feed(importScaleCandidates(count));
  return { engine, queue, ledger, receipt };
}

describe('WP-111 import-scale merge queue', () => {
  it('feeds 2000 synthetic candidates into governed cases without merging anyone (HAPPY)', () => {
    const { engine, queue, receipt } = setup();
    expect(receipt.opened).toBe(2001);
    expect(receipt.alreadyQueued).toBe(0);
    expect(receipt.laneCounts).toEqual({
      'specialized-review': 80,
      ambiguous: 2,
      'high-confidence': 1519,
      'standard-review': 400,
    });
    expect(engine.calls.executeMerge).toBe(0);
    expect(queue.openCases().every((queued) => queued.engineCase.status === 'open')).toBe(true);
  });

  it('re-feeding the same import is idempotent by unordered person pair (RECOVERY)', () => {
    const { engine, queue } = setup(200);
    const opened = engine.calls.openMergeCase;
    const swapped = importScaleCandidates(200).map((item) => ({
      ...item,
      importedPersonId: item.existingPersonId,
      existingPersonId: item.importedPersonId,
    }));
    const again = queue.feed(swapped);
    expect(again.opened).toBe(0);
    expect(again.alreadyQueued).toBe(201);
    expect(engine.calls.openMergeCase).toBe(opened);
  });

  it('pages every open case exactly once in lane-priority order (BOUNDARY)', () => {
    const { queue } = setup();
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = queue.page({
        limit: 137,
        ...(after === undefined ? {} : { afterCaseId: after }),
      });
      seen.push(...page.items.map((item) => item.caseId));
      if (page.nextAfter === undefined) {
        break;
      }
      after = page.nextAfter;
    }
    expect(seen).toHaveLength(2001);
    expect(new Set(seen).size).toBe(2001);
    expect(queue.get(seen[0] ?? '')?.lane).toBe('specialized-review');
    expect(queue.get(seen.at(-1) ?? '')?.lane).toBe('standard-review');
    expect(() => queue.page({ limit: 0 })).toThrow(MergeQueueError);
    expect(() => queue.page({ limit: 10, afterCaseId: 'mq-missing' })).toThrow(/cursor/);
  });

  it('refuses cross-tenant, cross-wave, self-pair and unknown-attribute candidates before opening any case (FAILURE)', () => {
    const engine = new FrozenMergeEngineDouble();
    const queue = new ImportMergeQueue(engine, context, 'staff:migration-bot');
    expect(() => queue.feed([candidate(1), candidate(2, { tenantId: 'other-synthetic' })])).toThrow(
      /tenant or wave/,
    );
    expect(() => queue.feed([candidate(3, { waveRef: 'wave:acq-2' })])).toThrow(/tenant or wave/);
    expect(() => queue.feed([candidate(4, { existingPersonId: 'imp-00004' })])).toThrow(
      /themselves/,
    );
    expect(() =>
      queue.feed([candidate(5, { matchedAttributes: ['ssn' as never, 'birth-date'] })]),
    ).toThrow(/unknown identity attribute/);
    expect(() => queue.feed([candidate(6, { score: 1001 })])).toThrow(/score/);
    expect(engine.calls.openMergeCase).toBe(0);
  });
});

describe('WP-111 bulk-merge governance end to end', () => {
  it('bulk-merges eligible cases with lineage, preserves aliases and resolves them in the queue (HAPPY)', () => {
    const { engine, queue, ledger } = setup();
    const eligible = queue
      .page({ lane: 'high-confidence', limit: 100 })
      .items.map((item) => item.caseId);
    const run = executeBulkMerge({ engine, queue, ledger, grants, request: bulkRequest(eligible) });
    expect(run.mergedCount).toBe(100);
    expect(run.refusedCount).toBe(0);
    expect(ledger.events().filter((event) => event.kind === 'merge')).toHaveLength(100);
    expect(ledger.lineage()).toHaveLength(300);
    expect(ledger.lineage().every((record) => record.toPersonId.startsWith('ph-'))).toBe(true);
    expect(queue.openCases()).toHaveLength(1901);
    const first = ledger.events()[0];
    expect(first).toBeDefined();
    expect(engine.resolveMergedPerson(ledger.events(), first?.mergedPersonId ?? '').personId).toBe(
      first?.survivorPersonId,
    );
    expect(run.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses ineligible cases per item and merges the rest (BOUNDARY)', () => {
    const { engine, queue, ledger } = setup(60);
    const lane = (name: string) =>
      queue
        .openCases()
        .filter((item) => item.lane === name)
        .map((item) => item.caseId);
    const good = lane('high-confidence').slice(0, 3);
    const lowScore = queue.page({ lane: 'high-confidence', limit: 500 }).items.at(-1)?.caseId ?? '';
    const request = bulkRequest([
      ...good,
      lane('specialized-review')[0] ?? '',
      lane('ambiguous')[0] ?? '',
      lane('standard-review')[0] ?? '',
      'mq-not-a-case',
    ]);
    const run = executeBulkMerge({
      engine,
      queue,
      ledger,
      grants,
      request,
      policy: { ...defaultBulkMergePolicy },
    });
    expect(run.items.map((item) => item.reason ?? item.outcome)).toEqual([
      'merged',
      'merged',
      'merged',
      'lane-not-eligible:specialized-review',
      'lane-not-eligible:ambiguous',
      'lane-not-eligible:standard-review',
      'not-queued',
    ]);
    const strict = executeBulkMerge({
      engine,
      queue,
      ledger,
      grants,
      request: bulkRequest([lowScore], {
        runRef: 'bulk:acq-1:002',
        secondApprover: undefined as never,
      }),
      policy: { ...defaultBulkMergePolicy, minScore: 999, dualControlMinSize: 5 },
    });
    expect(strict.items[0]?.reason).toBe('below-min-score');
  });

  it('refuses the whole run before any merge on capability, dual control, size or attribution (FAILURE)', () => {
    const { engine, queue, ledger } = setup(40);
    const ids = queue.page({ lane: 'high-confidence', limit: 5 }).items.map((item) => item.caseId);
    const run = (request: BulkMergeRequest, runGrants = grants) =>
      executeBulkMerge({ engine, queue, ledger, grants: runGrants, request });
    expect(() => run(bulkRequest(ids), [grants[0] as CapabilityGrantSnapshot])).toThrow(
      /migration.workbench-below-simulated/,
    );
    expect(() =>
      run(bulkRequest(ids), [
        { tenantId: tenant, capabilityId: 'identity.merge-governance', state: 'scaffolded' },
        grants[1] as CapabilityGrantSnapshot,
      ]),
    ).toThrow(/identity.merge-governance-below-simulated/);
    expect(() => run(bulkRequest(ids, { secondApprover: 'staff:migration-lead' }))).toThrow(
      /distinct approvers/,
    );
    expect(() => run(bulkRequest(ids, { secondApprover: undefined as never }))).toThrow(
      /second approver/,
    );
    expect(() => run(bulkRequest([]))).toThrow(/size/);
    expect(() => run(bulkRequest([ids[0] ?? '', ids[0] ?? '']))).toThrow(/more than once/);
    expect(() => run(bulkRequest(ids, { rationale: ' ' }))).toThrow(/rationale/);
    expect(engine.calls.executeMerge).toBe(0);
    expect(ledger.events()).toHaveLength(0);
  });

  it('an unrecognized artifact kind fails that merge safe and it is reported, not skipped (FAILURE)', () => {
    const { engine, queue, ledger } = setup(20);
    const ids = queue.page({ lane: 'high-confidence', limit: 2 }).items.map((item) => item.caseId);
    const target = queue.get(ids[1] ?? '')?.importedPersonId;
    const run = executeBulkMerge({
      engine,
      queue,
      ledger,
      grants,
      request: bulkRequest(ids, {
        artifactsOf: (personId) =>
          personId === target
            ? [
                ...artifactsOf(personId),
                { kind: 'lab-order', artifactRef: `lab:${personId}`, ownerPersonId: personId },
              ]
            : artifactsOf(personId),
      }),
    });
    expect(run.items[0]?.outcome).toBe('merged');
    expect(run.items[1]?.outcome).toBe('refused');
    expect(run.items[1]?.reason).toMatch(/engine-refused:.*unrecognized artifact/);
    expect(queue.get(ids[1] ?? '')?.engineCase.status).toBe('open');
    expect(ledger.lineage().some((record) => record.artifactRef === `chart:${target}`)).toBe(false);
  });

  it('re-submitting a run ref returns the recorded run without merging again (RECOVERY)', () => {
    const { engine, queue, ledger } = setup(30);
    const ids = queue.page({ lane: 'high-confidence', limit: 4 }).items.map((item) => item.caseId);
    const first = executeBulkMerge({ engine, queue, ledger, grants, request: bulkRequest(ids) });
    const calls = engine.calls.executeMerge;
    const second = executeBulkMerge({ engine, queue, ledger, grants, request: bulkRequest(ids) });
    expect(second).toBe(first);
    expect(engine.calls.executeMerge).toBe(calls);
    const fresh = executeBulkMerge({
      engine,
      queue,
      ledger,
      grants,
      request: bulkRequest(ids, { runRef: 'bulk:acq-1:009' }),
    });
    expect(fresh.items.every((item) => item.reason === 'not-open')).toBe(true);
  });
});

describe('WP-111 lineage and unmerge propagation drill', () => {
  function mergedOne() {
    const { engine, queue, ledger } = setup(20);
    const id = queue.page({ lane: 'high-confidence', limit: 1 }).items[0]?.caseId ?? '';
    const run = executeBulkMerge({
      engine,
      queue,
      ledger,
      grants,
      request: bulkRequest([id], { secondApprover: undefined as never }),
      policy: { ...defaultBulkMergePolicy, dualControlMinSize: 2 },
    });
    const eventId = run.items[0]?.eventId ?? '';
    const event = ledger.event(eventId);
    if (event === undefined) {
      throw new Error('drill setup failed');
    }
    return { engine, ledger, event };
  }

  function exposures(survivor: string, merged: string): EngineDownstreamExposure[] {
    return [
      {
        system: 'claims',
        artifactRef: 'claim:paid-1',
        exposedPersonId: survivor,
        correctPersonId: merged,
        status: 'adjudicated-paid',
        electronicCorrectionSupported: true,
      },
      {
        system: 'claims',
        artifactRef: 'claim:submitted-1',
        exposedPersonId: survivor,
        correctPersonId: merged,
        status: 'submitted',
        electronicCorrectionSupported: true,
      },
      {
        system: 'portal-results',
        artifactRef: 'result:released-1',
        exposedPersonId: survivor,
        correctPersonId: merged,
        status: 'released',
        electronicCorrectionSupported: true,
        materializedClinicalDecision: true,
      },
      {
        system: 'messages',
        artifactRef: 'msg:sent-1',
        exposedPersonId: survivor,
        correctPersonId: merged,
        status: 'sent',
        electronicCorrectionSupported: false,
      },
      {
        system: 'referrals',
        artifactRef: 'ref:active-1',
        exposedPersonId: merged,
        correctPersonId: merged,
        status: 'active',
        electronicCorrectionSupported: true,
      },
    ];
  }

  it('unmerge restores lineage and propagates to claims and disclosures (HAPPY)', () => {
    const { engine, ledger, event } = mergedOne();
    const report = runUnmergeDrill({
      engine,
      ledger,
      mergeEventId: event.eventId,
      unmergeEventId: `${event.eventId}-u1`,
      approvedBy: 'staff:privacy-officer',
      rationale: 'drill: wrong merge detected',
      postMergeArtifacts: [
        {
          kind: 'timeline-entry',
          artifactRef: 'tl:post-1',
          referencesPersonIds: [event.mergedPersonId],
        },
        {
          kind: 'timeline-entry',
          artifactRef: 'tl:post-both',
          referencesPersonIds: [event.survivorPersonId, event.mergedPersonId],
        },
      ],
      exposures: exposures(event.survivorPersonId, event.mergedPersonId),
      confirmations: new Map(),
    });
    expect(report.outcome).toBe('unmerged');
    expect(report.restoredCount).toBe(3);
    expect(report.quarantinedCount).toBe(1);
    expect(report.claimActions).toEqual([
      { artifactRef: 'claim:paid-1', action: 'rcm-void-rebill-refund' },
      { artifactRef: 'claim:submitted-1', action: 'electronic-correction' },
    ]);
    expect(report.wrongDisclosureIncidents).toEqual(['result:released-1', 'msg:sent-1']);
    expect(report.providerEscalations).toEqual(['result:released-1']);
    expect(report.directivesBySystem).toEqual({
      claims: 2,
      messages: 1,
      'portal-results': 1,
      referrals: 1,
    });
    expect(report.aliasRedirectCleared).toBe(true);
    expect(report.closure).toEqual({
      complete: false,
      outstanding: [
        'claim:paid-1',
        'claim:submitted-1',
        'result:released-1',
        'msg:sent-1',
        'ref:active-1',
      ],
    });
    expect(ledger.isReversed(event.eventId)).toBe(true);
    const restored = ledger.lineage().filter((record) => record.eventId === `${event.eventId}-u1`);
    expect(
      restored
        .filter((record) => record.disposition === 're-attributed')
        .every((record) => record.toPersonId === event.mergedPersonId),
    ).toBe(true);
  });

  it('closes only when every downstream owner confirms (BOUNDARY)', () => {
    const { engine, ledger, event } = mergedOne();
    const list = exposures(event.survivorPersonId, event.mergedPersonId);
    const report = runUnmergeDrill({
      engine,
      ledger,
      mergeEventId: event.eventId,
      unmergeEventId: `${event.eventId}-u1`,
      approvedBy: 'staff:privacy-officer',
      rationale: 'drill',
      postMergeArtifacts: [],
      exposures: list,
      confirmations: new Map(list.map((item) => [item.artifactRef, `confirm:${item.artifactRef}`])),
    });
    expect(report.closure).toEqual({ complete: true, confirmedCount: 5 });
    expect(() =>
      runUnmergeDrill({
        engine,
        ledger,
        mergeEventId: event.eventId,
        unmergeEventId: `${event.eventId}-u2`,
        approvedBy: 'staff:privacy-officer',
        rationale: 'again',
        postMergeArtifacts: [],
        exposures: [],
        confirmations: new Map(),
      }),
    ).toThrow(/already unmerged/);
  });

  it('a midway restore failure rolls back to merged, records nothing and propagates nothing (RECOVERY)', () => {
    const { engine, ledger, event } = mergedOne();
    const before = ledger.events().length;
    let applied = 0;
    const report = runUnmergeDrill({
      engine,
      ledger,
      mergeEventId: event.eventId,
      unmergeEventId: `${event.eventId}-u1`,
      approvedBy: 'staff:privacy-officer',
      rationale: 'drill',
      postMergeArtifacts: [],
      exposures: exposures(event.survivorPersonId, event.mergedPersonId),
      confirmations: new Map(),
      applyRestore: () => {
        applied += 1;
        if (applied === 2) {
          throw new Error('synthetic storage fault');
        }
      },
    });
    expect(report.outcome).toBe('rolled-back-to-merged');
    expect(report.p0AlertArtifactRef).toBe(`srcid:${event.mergedPersonId}`);
    expect(report.directivesBySystem).toEqual({
      claims: 0,
      messages: 0,
      'portal-results': 0,
      referrals: 0,
    });
    expect(ledger.events()).toHaveLength(before);
    expect(ledger.isReversed(event.eventId)).toBe(false);
    expect(engine.resolveMergedPerson(ledger.events(), event.mergedPersonId).personId).toBe(
      event.survivorPersonId,
    );
  });

  it('blocks unmerge without lineage and refuses exposures outside the merged pair (FAILURE)', () => {
    const { engine, ledger, event } = mergedOne();
    const bare = new MergeLedger(tenant);
    bare.append([event], []);
    const blocked = runUnmergeDrill({
      engine,
      ledger: bare,
      mergeEventId: event.eventId,
      unmergeEventId: `${event.eventId}-u1`,
      approvedBy: 'staff:privacy-officer',
      rationale: 'drill',
      postMergeArtifacts: [],
      exposures: [],
      confirmations: new Map(),
    });
    expect(blocked.outcome).toBe('blocked-no-lineage');
    expect(bare.isReversed(event.eventId)).toBe(false);
    expect(() =>
      runUnmergeDrill({
        engine,
        ledger,
        mergeEventId: event.eventId,
        unmergeEventId: `${event.eventId}-u1`,
        approvedBy: 'staff:privacy-officer',
        rationale: 'drill',
        postMergeArtifacts: [],
        exposures: [
          {
            system: 'claims',
            artifactRef: 'claim:x',
            exposedPersonId: 'ph-99999',
            correctPersonId: event.mergedPersonId,
            status: 'submitted',
            electronicCorrectionSupported: true,
          },
        ],
        confirmations: new Map(),
      }),
    ).toThrow(/merged pair/);
    expect(() =>
      bare.append([{ ...event, eventId: 'evt-x', tenantId: 'other-synthetic' }], []),
    ).toThrow(/cross-tenant/);
  });
});
