/**
 * Merge governance unit suite (WP-016). Covers the case lifecycle
 * (REQ-ID-009), check-in duplicate flag (REQ-ID-030), foreign-chart flag
 * (REQ-ID-020), wrong-merge detection + unmerge (REQ-ID-026), and downstream
 * propagation (REQ-ID-027). The gate properties — no stale permission
 * survives, lineage restores — live in merge-invalidation.test.ts.
 */
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import type { MatchablePerson } from './matching.js';
import {
  confirmCheckInResolution,
  detectWrongMergeSuspects,
  evaluateCheckInIdentity,
  executeMerge,
  executeUnmerge,
  flagSuspectedDuplicate,
  foreignChartBanner,
  invalidationEpochs,
  openMergeCase,
  outreachSuppressedPersonIds,
  propagateUnmerge,
  resolveMergeCase,
  resolveMergedPerson,
  routePostHocDuplicate,
  shouldReflagPair,
  unmergeClosureReport,
  type MergeArtifact,
  type MergeCase,
  type MergeExecution,
  type MergeExecutionInput,
  type UnmergeExecutionInput,
} from './merge.js';

const tenant = 'northwind-synthetic' as TenantId;
const sam = 'np-sam-porter' as PersonId;
const samLegacy = 'np-sam-porter-legacy' as PersonId;
const jordan = 'np-jordan-kim' as PersonId;

function makeCase(overrides: Partial<Parameters<typeof openMergeCase>[0]> = {}): MergeCase {
  return openMergeCase({
    caseId: 'nmc-t-0001',
    tenantId: tenant,
    kind: 'possible-match',
    personIds: [sam, samLegacy],
    matchedAttributes: ['given-name', 'family-name', 'birth-date'],
    confidence: 'high',
    openedBy: 'synthetic-migration-workbench',
    source: 'synthetic-acquisition-import',
    ...overrides,
  });
}

const artifacts: readonly MergeArtifact[] = [
  { kind: 'source-identifier', artifactRef: 'legacy-lakeside:lg-000778', ownerPersonId: samLegacy },
  { kind: 'person-name', artifactRef: 'legacy-name-sam-porter', ownerPersonId: samLegacy },
  { kind: 'timeline-entry', artifactRef: 'nti-sam-legacy-registered', ownerPersonId: samLegacy },
];

function makeMergeInput(overrides: Partial<MergeExecutionInput> = {}): MergeExecutionInput {
  return {
    mergeCase: makeCase(),
    basis: {
      comparedAttributes: ['given-name', 'family-name', 'birth-date'],
      decidedBy: 'synthetic-data-migration-001',
    },
    eventId: 'nme-t-0001',
    survivorPersonId: sam,
    mergedPersonId: samLegacy,
    artifacts,
    mergedPersonSourceIdRefs: ['legacy-lakeside:lg-000778'],
    rationale: 'synthetic acquisition duplicate confirmed',
    evidenceRef: 'synthetic-merge-evidence-t-0001',
    ...overrides,
  };
}

function performMerge(overrides: Partial<MergeExecutionInput> = {}): MergeExecution {
  return executeMerge(makeMergeInput(overrides));
}

describe('merge cases (REQ-ID-009)', () => {
  it('opening a case quarantines without merging — status open, nothing else happens', () => {
    const mergeCase = makeCase();
    expect(mergeCase.status).toBe('open');
    expect(mergeCase.resolution).toBeUndefined();
  });

  it('a case requires at least two distinct persons', () => {
    expect(() => makeCase({ personIds: [sam] })).toThrow('at least two distinct persons');
    expect(() => makeCase({ personIds: [sam, sam] })).toThrow('at least two distinct persons');
  });

  it('AC-1: the workspace shape carries source ids, matching/conflicting fields, confidence, contact risk, and pending operations', () => {
    const mergeCase = makeCase({
      conflictingAttributes: ['birth-date'],
      contactRisk: true,
      pendingOperations: ['synthetic-crm-campaign-0001'],
      sourceIdRefs: ['hubspot:hs-88121'],
    });
    expect(mergeCase.sourceIdRefs).toEqual(['hubspot:hs-88121']);
    expect(mergeCase.conflictingAttributes).toEqual(['birth-date']);
    expect(mergeCase.confidence).toBe('high');
    expect(mergeCase.contactRisk).toBe(true);
    expect(mergeCase.pendingOperations).toEqual(['synthetic-crm-campaign-0001']);
  });

  it('AC-2: resolution requires attribution, a reason, and approved evidence for link/merge', () => {
    const mergeCase = makeCase();
    expect(() =>
      resolveMergeCase(mergeCase, { kind: 'linked', decidedBy: '', reason: 'x' }),
    ).toThrow('attributed');
    expect(() =>
      resolveMergeCase(mergeCase, { kind: 'linked', decidedBy: 'staff-1', reason: '' }),
    ).toThrow('attributed');
    expect(() =>
      resolveMergeCase(mergeCase, { kind: 'linked', decidedBy: 'staff-1', reason: 'verified' }),
    ).toThrow('approved');
    const linked = resolveMergeCase(mergeCase, {
      kind: 'linked',
      decidedBy: 'staff-1',
      reason: 'verified against license',
      evidenceRef: 'synthetic-evidence-1',
    });
    expect(linked.status).toBe('resolved-linked');
  });

  it('a merged resolution must come from executeMerge — a bare case edit cannot merge', () => {
    expect(() =>
      resolveMergeCase(makeCase(), {
        kind: 'merged',
        decidedBy: 'staff-1',
        reason: 'same person',
        evidenceRef: 'synthetic-evidence-1',
      }),
    ).toThrow('executeMerge');
  });

  it('only an open case resolves — resolutions are single-shot', () => {
    const resolved = resolveMergeCase(makeCase(), {
      kind: 'dismissed',
      decidedBy: 'staff-1',
      reason: 'no collision after review',
    });
    expect(() =>
      resolveMergeCase(resolved, { kind: 'dismissed', decidedBy: 'staff-1', reason: 'again' }),
    ).toThrow('only an open case resolves');
  });

  it('exception: specialized patterns require their checks before link/merge', () => {
    const specialized = makeCase({ specializedPatterns: ['minor-or-proxy'] });
    expect(() =>
      resolveMergeCase(specialized, {
        kind: 'linked',
        decidedBy: 'staff-1',
        reason: 'verified',
        evidenceRef: 'synthetic-evidence-1',
      }),
    ).toThrow('specialized');
    const withChecks = resolveMergeCase(specialized, {
      kind: 'linked',
      decidedBy: 'staff-1',
      reason: 'verified with guardian evidence',
      evidenceRef: 'synthetic-evidence-1',
      specializedChecksRef: 'synthetic-specialized-check-1',
    });
    expect(withChecks.status).toBe('resolved-linked');
  });

  it('exception: unresolved specialized-pattern and contact-risk cases suppress automated outreach', () => {
    const cases = [
      makeCase({ caseId: 'nmc-t-0002', specializedPatterns: ['shared-household-contact'] }),
      makeCase({ caseId: 'nmc-t-0003', personIds: [jordan, sam], contactRisk: true }),
    ];
    expect(outreachSuppressedPersonIds(cases)).toEqual([jordan, sam, samLegacy].sort());
    const resolved = cases.map((mergeCase) =>
      resolveMergeCase(mergeCase, {
        kind: 'confirmed-distinct',
        decidedBy: 'staff-1',
        reason: 'different people confirmed',
        doNotReflag: true,
      }),
    );
    expect(outreachSuppressedPersonIds(resolved)).toEqual([]);
  });

  it('a confirmed-distinct pair is not re-flagged without new evidence; new evidence re-flags', () => {
    const resolved = resolveMergeCase(makeCase(), {
      kind: 'confirmed-distinct',
      decidedBy: 'staff-1',
      reason: 'twins with identical names',
      doNotReflag: true,
    });
    expect(shouldReflagPair([resolved], sam, samLegacy)).toBe(false);
    expect(shouldReflagPair([resolved], samLegacy, sam)).toBe(false);
    expect(shouldReflagPair([resolved], sam, jordan)).toBe(true);
    expect(shouldReflagPair([resolved], sam, samLegacy, 'synthetic-new-evidence-1')).toBe(true);
  });
});

describe('check-in duplicate flag (REQ-ID-030)', () => {
  const existing: readonly MatchablePerson[] = [
    {
      person: {
        personId: sam,
        tenantId: tenant,
        status: 'verified',
        verificationEvidenceRef: 'synthetic-idproof-0003',
        provenance: { source: 'synthetic-intake', capturedBy: 'synthetic-front-desk-001' },
        synthetic: true,
      },
      names: [],
      attributes: {
        givenName: 'Sam',
        familyName: 'Porter',
        birthDate: '1975-09-21',
        phone: '+15550100003',
        postalAddress: '12 synthetic way',
      },
    },
  ];

  it('AC-1: a strong near-match raises the blocking side-by-side warning before completion', () => {
    const evaluation = evaluateCheckInIdentity(
      { givenName: 'Sam', familyName: 'Porter', birthDate: '1975-09-21' },
      existing,
    );
    expect(evaluation.outcome).toBe('duplicate-warning');
    if (evaluation.outcome === 'duplicate-warning') {
      expect(evaluation.blocksCompletion).toBe(true);
      expect(evaluation.comparison).toBe('side-by-side');
      expect(evaluation.candidates[0]?.personId).toBe(sam);
    }
  });

  it('exception 2: a minor sharing only the guardian phone/address never triggers the blocking warning', () => {
    const evaluation = evaluateCheckInIdentity(
      {
        givenName: 'Riley',
        familyName: 'Chen',
        birthDate: '2014-02-11',
        phone: '+15550100003',
        postalAddress: '12 synthetic way',
      },
      existing,
    );
    expect(evaluation.outcome).toBe('advisory-only');
    if (evaluation.outcome === 'advisory-only') {
      expect(evaluation.proceed).toBe(true);
      expect(evaluation.advisoryHouseholdMatches[0]?.strong).toBe(false);
    }
  });

  it('AC-2: confirming the same person proceeds on the EXISTING record, logged', () => {
    const resolution = confirmCheckInResolution({
      decision: 'same-person',
      decidedBy: 'synthetic-front-desk-001',
    });
    expect(resolution).toEqual({
      outcome: 'proceed-existing-record',
      newRecordCreated: false,
      resolutionLogged: true,
      decidedBy: 'synthetic-front-desk-001',
    });
  });

  it('AC-3: confirming a different person requires a reason and logs reviewed-and-dismissed', () => {
    expect(() =>
      confirmCheckInResolution({ decision: 'different-person', decidedBy: 'fd-1' }),
    ).toThrow('reason');
    const resolution = confirmCheckInResolution({
      decision: 'different-person',
      decidedBy: 'fd-1',
      reason: 'parent and child share the household phone; legal name change noted',
    });
    expect(resolution.outcome).toBe('proceed-new-record');
    if (resolution.outcome === 'proceed-new-record') {
      expect(resolution.nearMatchLogged).toBe('reviewed-and-dismissed');
    }
  });

  it('AC-5: an unresolved check-in pauses with billing and clinical documentation blocked', () => {
    const resolution = confirmCheckInResolution({ decision: 'unresolved', decidedBy: '' });
    expect(resolution).toEqual({
      outcome: 'check-in-paused',
      billingBlocked: true,
      clinicalDocumentationBlocked: true,
      routedTo: 'merge-review-queue',
    });
  });

  it('AC-5: an acquired-clinic duplicate routes to the data-migration merge queue', () => {
    const resolution = confirmCheckInResolution({
      decision: 'unresolved',
      decidedBy: '',
      acquiredClinicDuplicate: true,
    });
    expect(resolution.outcome).toBe('check-in-paused');
    if (resolution.outcome === 'check-in-paused') {
      expect(resolution.routedTo).toBe('data-migration-merge-queue');
    }
  });

  it('AC-4: a post-hoc duplicate with activity on both records routes to the merge-review queue', () => {
    expect(routePostHocDuplicate(true)).toEqual({
      routedTo: 'merge-review-queue',
      frontDeskMayResolve: false,
    });
    expect(routePostHocDuplicate(false).frontDeskMayResolve).toBe(true);
  });
});

describe('foreign-chart flag (REQ-ID-020)', () => {
  it('AC-1: an unreconciled foreign chart renders the banner naming source and status', () => {
    const view = foreignChartBanner([
      {
        sourceSystem: 'legacy-lakeside',
        sourceValue: 'lg-000441',
        migrationStatus: 'unreconciled',
        contributedFields: ['demographics'],
      },
    ]);
    expect(view.reconciled).toBe(false);
    if (!view.reconciled) {
      expect(view.banner.sourceSystems).toEqual(['legacy-lakeside']);
      expect(view.banner.migrationStatus).toBe('unreconciled');
    }
  });

  it('AC-4: once every link reconciles, the banner clears and per-source provenance renders', () => {
    const view = foreignChartBanner([
      {
        sourceSystem: 'legacy-lakeside',
        sourceValue: 'lg-000441',
        migrationStatus: 'reconciled',
        contributedFields: ['demographics', 'allergies'],
      },
      {
        sourceSystem: 'athena',
        sourceValue: 'ath-100234',
        migrationStatus: 'reconciled',
        contributedFields: ['problem-list'],
      },
    ]);
    expect(view.reconciled).toBe(true);
    if (view.reconciled) {
      expect(view.banner).toBeNull();
      expect(view.provenance).toEqual([
        { sourceSystem: 'legacy-lakeside', contributedFields: ['demographics', 'allergies'] },
        { sourceSystem: 'athena', contributedFields: ['problem-list'] },
      ]);
    }
  });

  it('AC-3: staff flag a suspected duplicate straight into the reconciliation queue', () => {
    const flagged = flagSuspectedDuplicate({
      caseId: 'nmc-t-0010',
      tenantId: tenant,
      personIds: [sam, samLegacy],
      matchedAttributes: ['given-name', 'family-name'],
      confidence: 'medium',
      openedBy: 'synthetic-acquired-clinic-staff-001',
      source: 'synthetic-record-view',
    });
    expect(flagged.kind).toBe('staff-flagged-duplicate');
    expect(flagged.routedTo).toBe('data-migration-reconciliation-queue');
    expect(flagged.status).toBe('open');
  });
});

describe('wrong-merge detection (REQ-ID-026 AC-1)', () => {
  it('conflicting facts flag for human review and never auto-unmerge', () => {
    const detection = detectWrongMergeSuspects({
      birthDates: ['1975-09-21', '1976-01-02'],
      sexes: ['female', 'male'],
      divergentContactHistory: true,
      activeInsuranceCount: 2,
    });
    expect(detection.flagged).toBe(true);
    expect(detection.signals).toEqual([
      'conflicting-birth-date',
      'conflicting-sex',
      'divergent-contact-history',
      'multiple-active-insurances',
    ]);
    expect(detection.disposition).toBe('human-review-required');
    expect(detection.autoUnmerge).toBe(false);
  });

  it('a clean merged chart does not flag', () => {
    const detection = detectWrongMergeSuspects({
      birthDates: ['1975-09-21', '1975-09-21'],
      sexes: ['female'],
      divergentContactHistory: false,
      activeInsuranceCount: 1,
    });
    expect(detection.flagged).toBe(false);
    expect(detection.disposition).toBe('none');
  });
});

describe('merge execution (REQ-ID-009 AC-2, REQ-ID-026 substrate)', () => {
  it('a governed merge emits the event, per-artifact lineage, the resolved case, and preserved aliases', () => {
    const execution = performMerge();
    expect(execution.event.kind).toBe('merge');
    expect(execution.lineage).toHaveLength(artifacts.length);
    expect(execution.lineage.every((record) => record.fromPersonId === samLegacy)).toBe(true);
    expect(execution.lineage.every((record) => record.toPersonId === sam)).toBe(true);
    expect(execution.resolvedCase.status).toBe('resolved-merged');
    expect(execution.resolvedCase.resolution?.mergeEventId).toBe('nme-t-0001');
    expect(execution.aliasesPreserved).toBe(true);
    expect(execution.preservedAliases).toEqual(['legacy-lakeside:lg-000778']);
  });

  it('an endpoint-only basis can never authorize a merge (REQ-ID-017 exception)', () => {
    expect(() =>
      performMerge({
        basis: {
          comparedAttributes: ['phone', 'email', 'postal-address'],
          decidedBy: 'synthetic-data-migration-001',
        },
      }),
    ).toThrow('can never authorize');
  });

  it('an unattributed or single-attribute basis is refused', () => {
    expect(() =>
      performMerge({
        basis: { comparedAttributes: ['given-name', 'birth-date'], decidedBy: '' },
      }),
    ).toThrow('attributed');
    expect(() =>
      performMerge({
        basis: { comparedAttributes: ['given-name'], decidedBy: 'staff-1' },
      }),
    ).toThrow('at least two');
  });

  it('an unrecognized artifact kind fails the WHOLE merge — nothing silently skips', () => {
    expect(() =>
      performMerge({
        artifacts: [
          ...artifacts,
          { kind: 'implant-registry', artifactRef: 'ir-1', ownerPersonId: samLegacy },
        ],
      }),
    ).toThrow('unrecognized artifact kind');
  });

  it('artifacts must belong to the merged-away person', () => {
    expect(() =>
      performMerge({
        artifacts: [{ kind: 'person-name', artifactRef: 'x', ownerPersonId: jordan }],
      }),
    ).toThrow('must belong to the merged-away person');
  });

  it('a merge outside its case or with itself is refused', () => {
    expect(() => performMerge({ survivorPersonId: samLegacy, mergedPersonId: samLegacy })).toThrow(
      'themselves',
    );
    expect(() => performMerge({ mergedPersonId: jordan })).toThrow('does not cover both persons');
  });

  it('a specialized-pattern case merges only with its checks recorded', () => {
    const specialized = makeCase({ specializedPatterns: ['name-change'] });
    expect(() => performMerge({ mergeCase: specialized })).toThrow('specialized');
    const execution = performMerge({
      mergeCase: specialized,
      specializedChecksRef: 'synthetic-specialized-check-2',
    });
    expect(execution.resolvedCase.status).toBe('resolved-merged');
  });

  it('the merged-away id stays resolvable to the survivor, and unmerge cancels the redirect', () => {
    const execution = performMerge();
    expect(resolveMergedPerson([execution.event], samLegacy)).toEqual({
      personId: sam,
      redirected: true,
    });
    expect(resolveMergedPerson([execution.event], sam)).toEqual({
      personId: sam,
      redirected: false,
    });
    const unmerge = executeUnmerge({
      mergeEvent: execution.event,
      lineage: execution.lineage,
      postMergeArtifacts: [],
      eventId: 'nme-t-0002',
      approvedBy: 'synthetic-compliance-001',
      rationale: 'distinct patients confirmed',
    });
    if (unmerge.outcome !== 'unmerged') {
      throw new Error(`expected unmerged, received ${unmerge.outcome}`);
    }
    expect(resolveMergedPerson([execution.event, unmerge.event], samLegacy)).toEqual({
      personId: samLegacy,
      redirected: false,
    });
  });
});

describe('unmerge (REQ-ID-026)', () => {
  function makeUnmergeInput(
    execution: MergeExecution,
    overrides: Partial<UnmergeExecutionInput> = {},
  ): UnmergeExecutionInput {
    return {
      mergeEvent: execution.event,
      lineage: execution.lineage,
      postMergeArtifacts: [],
      eventId: 'nme-t-0002',
      approvedBy: 'synthetic-compliance-001',
      rationale: 'wrong merge confirmed by review',
      ...overrides,
    };
  }

  it('AC-2: every lineage artifact re-attributes back to its originating person', () => {
    const execution = performMerge();
    const outcome = executeUnmerge(makeUnmergeInput(execution));
    if (outcome.outcome !== 'unmerged') {
      throw new Error(`expected unmerged, received ${outcome.outcome}`);
    }
    expect(outcome.restoredLineage).toHaveLength(execution.lineage.length);
    for (const record of outcome.restoredLineage) {
      expect(record.fromPersonId).toBe(sam);
      expect(record.toPersonId).toBe(samLegacy);
      expect(record.disposition).toBe('re-attributed');
    }
    expect(outcome.event.kind).toBe('unmerge');
    expect(outcome.event.reversesEventId).toBe(execution.event.eventId);
  });

  it('AC-3: the reconciliation report shows every artifact pre/post owner and quarantines indeterminates', () => {
    const execution = performMerge();
    const outcome = executeUnmerge(
      makeUnmergeInput(execution, {
        postMergeArtifacts: [
          { kind: 'timeline-entry', artifactRef: 'nti-post-1', referencesPersonIds: [sam] },
          {
            kind: 'timeline-entry',
            artifactRef: 'nti-post-both',
            referencesPersonIds: [sam, samLegacy],
          },
        ],
      }),
    );
    if (outcome.outcome !== 'unmerged') {
      throw new Error(`expected unmerged, received ${outcome.outcome}`);
    }
    expect(outcome.report.rows).toHaveLength(execution.lineage.length + 2);
    const attributable = outcome.report.rows.find((row) => row.artifactRef === 'nti-post-1');
    expect(attributable?.postUnmergeOwner).toBe(sam);
    const indeterminate = outcome.report.rows.find((row) => row.artifactRef === 'nti-post-both');
    expect(indeterminate?.postUnmergeOwner).toBe('indeterminate');
    expect(outcome.quarantined).toHaveLength(1);
    expect(outcome.quarantined[0]?.disposition).toBe('indeterminate-quarantined');
    expect(outcome.report.indeterminateCount).toBe(1);
  });

  it('AC-4: an unapproved or rationale-free unmerge is refused', () => {
    const execution = performMerge();
    expect(() => executeUnmerge(makeUnmergeInput(execution, { approvedBy: '' }))).toThrow(
      'attributed operator',
    );
    expect(() => executeUnmerge(makeUnmergeInput(execution, { rationale: '' }))).toThrow(
      'documented rationale',
    );
  });

  it('exception 1: missing lineage blocks the unmerge and opens manual chart review', () => {
    const execution = performMerge();
    const outcome = executeUnmerge(makeUnmergeInput(execution, { lineage: [] }));
    expect(outcome).toEqual({
      outcome: 'blocked-no-lineage',
      manualChartReviewOpened: true,
      autoSplitRefused: true,
    });
  });

  it('exception 3: a midway failure rolls back to the merged state with a P0 alert — no half-split', () => {
    const execution = performMerge();
    let applied = 0;
    const outcome = executeUnmerge(
      makeUnmergeInput(execution, {
        applyRestore: () => {
          applied += 1;
          if (applied === 2) {
            throw new Error('synthetic mid-restore failure');
          }
        },
      }),
    );
    expect(outcome.outcome).toBe('rolled-back-to-merged');
    if (outcome.outcome === 'rolled-back-to-merged') {
      expect(outcome.noHalfSplit).toBe(true);
      expect(outcome.p0Alert.severity).toBe('P0');
      expect(outcome.p0Alert.kind).toBe('unmerge-partial-failure');
    }
  });

  it('only a merge event is reversible', () => {
    const execution = performMerge();
    const unmerged = executeUnmerge(makeUnmergeInput(execution));
    if (unmerged.outcome !== 'unmerged') {
      throw new Error('setup failed');
    }
    expect(() =>
      executeUnmerge(makeUnmergeInput(execution, { mergeEvent: unmerged.event })),
    ).toThrow('only a merge event');
  });
});

describe('downstream propagation (REQ-ID-027)', () => {
  const execution = performMerge();
  const unmerge = executeUnmerge({
    mergeEvent: execution.event,
    lineage: execution.lineage,
    postMergeArtifacts: [],
    eventId: 'nme-t-0002',
    approvedBy: 'synthetic-compliance-001',
    rationale: 'wrong merge confirmed',
  });
  if (unmerge.outcome !== 'unmerged') {
    throw new Error('setup failed');
  }

  it('AC-1: every exposure yields a correction directive with a named owner per system', () => {
    const propagation = propagateUnmerge([
      {
        system: 'claims',
        artifactRef: 'clm-1',
        exposedPersonId: sam,
        correctPersonId: samLegacy,
        status: 'submitted',
        electronicCorrectionSupported: true,
      },
      {
        system: 'messages',
        artifactRef: 'msg-1',
        exposedPersonId: sam,
        correctPersonId: samLegacy,
        status: 'sent',
        electronicCorrectionSupported: true,
      },
    ]);
    expect(propagation.directives).toHaveLength(2);
    expect(propagation.directives.map((directive) => directive.ownerRole)).toEqual([
      'rcm',
      'comms',
    ]);
    expect(propagation.directives.every((directive) => directive.trackedConfirmationRequired)).toBe(
      true,
    );
  });

  it('AC-2: a wrong-recipient release opens a wrong-disclosure incident on the PHI-breach workflow', () => {
    const propagation = propagateUnmerge([
      {
        system: 'portal-results',
        artifactRef: 'res-1',
        exposedPersonId: sam,
        correctPersonId: samLegacy,
        status: 'released',
        electronicCorrectionSupported: true,
      },
    ]);
    expect(propagation.wrongDisclosureIncidents).toEqual([
      {
        artifactRef: 'res-1',
        system: 'portal-results',
        exposedPersonId: sam,
        linkedWorkflow: 'phi-breach-evaluation',
      },
    ]);
  });

  it('AC-3: a clinician harm review is tasked; exception 2: a materialized decision escalates immediately', () => {
    const propagation = propagateUnmerge([
      {
        system: 'referrals',
        artifactRef: 'ref-1',
        exposedPersonId: sam,
        correctPersonId: sam,
        status: 'active',
        electronicCorrectionSupported: true,
        materializedClinicalDecision: true,
      },
    ]);
    expect(propagation.harmReview.taskOwner).toBe('clinician');
    expect(propagation.escalations).toEqual([
      { artifactRef: 'ref-1', escalateTo: 'treating-provider', immediate: true },
    ]);
  });

  it('exception 1: an adjudicated/paid claim routes to RCM void/rebill, never a silent edit', () => {
    const propagation = propagateUnmerge([
      {
        system: 'claims',
        artifactRef: 'clm-paid',
        exposedPersonId: sam,
        correctPersonId: samLegacy,
        status: 'adjudicated-paid',
        electronicCorrectionSupported: true,
      },
    ]);
    expect(propagation.directives[0]?.action).toBe('rcm-void-rebill-refund');
  });

  it('exception 3: a non-electronic system gets a manual correction task with tracked confirmation', () => {
    const propagation = propagateUnmerge([
      {
        system: 'referrals',
        artifactRef: 'ref-fax',
        exposedPersonId: sam,
        correctPersonId: samLegacy,
        status: 'active',
        electronicCorrectionSupported: false,
      },
    ]);
    expect(propagation.directives[0]?.action).toBe('manual-correction-task');
    expect(propagation.directives[0]?.trackedConfirmationRequired).toBe(true);
  });

  it('AC-4: the closure report completes only when every directive is confirmed', () => {
    const propagation = propagateUnmerge([
      {
        system: 'claims',
        artifactRef: 'clm-1',
        exposedPersonId: sam,
        correctPersonId: samLegacy,
        status: 'submitted',
        electronicCorrectionSupported: true,
      },
      {
        system: 'messages',
        artifactRef: 'msg-1',
        exposedPersonId: sam,
        correctPersonId: samLegacy,
        status: 'sent',
        electronicCorrectionSupported: true,
      },
    ]);
    const partial = unmergeClosureReport(
      propagation.directives,
      new Map([['clm-1', 'synthetic-confirmation-1']]),
    );
    expect(partial).toEqual({ complete: false, outstanding: ['msg-1'] });
    const complete = unmergeClosureReport(
      propagation.directives,
      new Map([
        ['clm-1', 'synthetic-confirmation-1'],
        ['msg-1', 'synthetic-confirmation-2'],
      ]),
    );
    expect(complete).toEqual({ complete: true, confirmedCount: 2 });
  });

  it('merge and unmerge both bump both persons’ invalidation epochs', () => {
    const epochs = invalidationEpochs([execution.event, unmerge.event]);
    expect(epochs.get(sam)).toBe(2);
    expect(epochs.get(samLegacy)).toBe(2);
  });
});
