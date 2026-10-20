import {
  mergeArtifactKindsV1,
  type EngineClosureReport,
  type EngineCorrectionDirective,
  type EngineDownstreamExposure,
  type EngineLineageRecord,
  type EngineMergeCase,
  type EngineMergeEvent,
  type EngineMergeExecution,
  type EngineMergeInput,
  type EngineOpenCaseInput,
  type EngineUnmergeInput,
  type EngineUnmergeOutcome,
  type EngineUnmergePropagation,
  type IdentityMergeEnginePort,
} from './engine-port.js';

export class MergeEngineDoubleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'MergeEngineDoubleError';
  }
}

/** Exactly identity's assertIdentityId pattern (modules/identity/src/identity.ts:30). */
export const identityIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const mergeSufficient = new Set(['given-name', 'family-name', 'birth-date']);
const ownerBySystem = {
  claims: 'rcm',
  messages: 'comms',
  'portal-results': 'clinical',
  referrals: 'clinical',
} as const;

function assertId(value: string, field: string): void {
  if (!identityIdPattern.test(value)) {
    throw new MergeEngineDoubleError(`${field} must be a constrained identifier`);
  }
}

/**
 * Synthetic placeholder for the frozen WP-016 engine (FWD-MIG-111-ENGINE-BIND).
 * It enforces the frozen contract's rules WP-111 relies on so the queue and
 * drills cannot pass against a permissive double: no auto-merge, authorization
 * floor, recognized-artifact fail-safe, lineage-or-block unmerge, rollback to
 * merged on midway failure, per-system correction directives.
 */
export class FrozenMergeEngineDouble implements IdentityMergeEnginePort {
  public readonly calls = { openMergeCase: 0, executeMerge: 0, executeUnmerge: 0 };

  public openMergeCase(input: EngineOpenCaseInput): EngineMergeCase {
    this.calls.openMergeCase += 1;
    assertId(input.caseId, 'caseId');
    assertId(input.tenantId, 'tenantId');
    if (input.personIds.length < 2 || new Set(input.personIds).size !== input.personIds.length) {
      throw new MergeEngineDoubleError(`merge case ${input.caseId} requires two distinct persons`);
    }
    if (!input.openedBy || !input.source) {
      throw new MergeEngineDoubleError(
        'merge case must record who opened it and from which source',
      );
    }
    return { ...input, status: 'open', synthetic: true };
  }

  public executeMerge(input: EngineMergeInput): EngineMergeExecution {
    this.calls.executeMerge += 1;
    assertId(input.eventId, 'eventId');
    const { basis, mergeCase } = input;
    if (!basis.decidedBy || basis.comparedAttributes.length < 2) {
      throw new MergeEngineDoubleError(
        'merge basis needs an attributed decider and two attributes',
      );
    }
    if (!basis.comparedAttributes.some((attribute) => mergeSufficient.has(attribute))) {
      throw new MergeEngineDoubleError('endpoint or household attributes cannot carry a merge');
    }
    if (mergeCase.status !== 'open') {
      throw new MergeEngineDoubleError(`merge case ${mergeCase.caseId} is ${mergeCase.status}`);
    }
    if (input.survivorPersonId === input.mergedPersonId) {
      throw new MergeEngineDoubleError('a person cannot merge with themselves');
    }
    if (
      !mergeCase.personIds.includes(input.survivorPersonId) ||
      !mergeCase.personIds.includes(input.mergedPersonId)
    ) {
      throw new MergeEngineDoubleError('merge case does not cover both persons');
    }
    if (!input.rationale) {
      throw new MergeEngineDoubleError('merge resolution requires a recorded reason');
    }
    if (!input.evidenceRef) {
      throw new MergeEngineDoubleError('merge requires approved evidence');
    }
    if (mergeCase.specializedPatterns.length > 0 && !input.specializedChecksRef) {
      throw new MergeEngineDoubleError(
        'specialized patterns require the specialized checks reference',
      );
    }
    const recognized: readonly string[] = mergeArtifactKindsV1;
    if (input.artifacts.some((artifact) => !recognized.includes(artifact.kind))) {
      throw new MergeEngineDoubleError('merge blocked: unrecognized artifact kind fails safe');
    }
    if (input.artifacts.some((artifact) => artifact.ownerPersonId !== input.mergedPersonId)) {
      throw new MergeEngineDoubleError('merge artifacts must belong to the merged-away person');
    }
    const event: EngineMergeEvent = {
      eventId: input.eventId,
      tenantId: mergeCase.tenantId,
      caseId: mergeCase.caseId,
      kind: 'merge',
      survivorPersonId: input.survivorPersonId,
      mergedPersonId: input.mergedPersonId,
      basisAttributes: basis.comparedAttributes,
      decidedBy: basis.decidedBy,
      rationale: input.rationale,
      evidenceRef: input.evidenceRef,
      synthetic: true,
    };
    const lineage: EngineLineageRecord[] = input.artifacts.map((artifact, index) => ({
      lineageId: `${input.eventId}-l${String(index + 1).padStart(3, '0')}`,
      tenantId: mergeCase.tenantId,
      eventId: input.eventId,
      artifactKind: artifact.kind,
      artifactRef: artifact.artifactRef,
      fromPersonId: input.mergedPersonId,
      toPersonId: input.survivorPersonId,
      disposition: 're-attributed',
      synthetic: true,
    }));
    return {
      event,
      lineage,
      resolvedCase: { ...mergeCase, status: 'resolved-merged' },
      preservedAliases: [...input.mergedPersonSourceIdRefs],
      aliasesPreserved: true,
    };
  }

  public resolveMergedPerson(events: readonly EngineMergeEvent[], personId: string) {
    const reversed = new Set(
      events.flatMap((event) =>
        event.kind === 'unmerge' && event.reversesEventId !== undefined
          ? [event.reversesEventId]
          : [],
      ),
    );
    let current = personId;
    let redirected = false;
    for (let hops = 0; hops <= events.length; hops += 1) {
      const merge = events.find(
        (event) =>
          event.kind === 'merge' &&
          !reversed.has(event.eventId) &&
          event.mergedPersonId === current,
      );
      if (merge === undefined) {
        break;
      }
      current = merge.survivorPersonId;
      redirected = true;
    }
    return { personId: current, redirected };
  }

  public executeUnmerge(input: EngineUnmergeInput): EngineUnmergeOutcome {
    this.calls.executeUnmerge += 1;
    assertId(input.eventId, 'eventId');
    if (input.mergeEvent.kind !== 'merge') {
      throw new MergeEngineDoubleError('only a merge event is reversible by unmerge');
    }
    if (!input.approvedBy || !input.rationale) {
      throw new MergeEngineDoubleError('unmerge requires an attributed approver and rationale');
    }
    const eventLineage = input.lineage.filter(
      (record) =>
        record.eventId === input.mergeEvent.eventId && record.disposition === 're-attributed',
    );
    if (eventLineage.length === 0) {
      return {
        outcome: 'blocked-no-lineage',
        manualChartReviewOpened: true,
        autoSplitRefused: true,
      };
    }
    const restoredLineage: EngineLineageRecord[] = [];
    for (const [index, record] of eventLineage.entries()) {
      const mirror: EngineLineageRecord = {
        ...record,
        lineageId: `${input.eventId}-r${String(index + 1).padStart(3, '0')}`,
        eventId: input.eventId,
        fromPersonId: record.toPersonId,
        toPersonId: record.fromPersonId,
      };
      try {
        input.applyRestore?.(mirror);
      } catch {
        return {
          outcome: 'rolled-back-to-merged',
          noHalfSplit: true,
          p0Alert: {
            severity: 'P0',
            kind: 'unmerge-partial-failure',
            failedArtifactRef: record.artifactRef,
          },
        };
      }
      restoredLineage.push(mirror);
    }
    const { survivorPersonId, mergedPersonId } = input.mergeEvent;
    const rows = restoredLineage.map((record) => ({
      artifactRef: record.artifactRef,
      artifactKind: record.artifactKind,
      preUnmergeOwner: record.fromPersonId,
      postUnmergeOwner: record.toPersonId,
    }));
    const quarantined: EngineLineageRecord[] = [];
    for (const [index, artifact] of input.postMergeArtifacts.entries()) {
      const references = [...new Set(artifact.referencesPersonIds)].filter(
        (id) => id === survivorPersonId || id === mergedPersonId,
      );
      const only = references.length === 1 ? references[0] : undefined;
      if (only !== undefined) {
        rows.push({
          artifactRef: artifact.artifactRef,
          artifactKind: artifact.kind,
          preUnmergeOwner: survivorPersonId,
          postUnmergeOwner: only,
        });
        continue;
      }
      quarantined.push({
        lineageId: `${input.eventId}-q${String(index + 1).padStart(3, '0')}`,
        tenantId: input.mergeEvent.tenantId,
        eventId: input.eventId,
        artifactKind: artifact.kind,
        artifactRef: artifact.artifactRef,
        fromPersonId: survivorPersonId,
        toPersonId: survivorPersonId,
        disposition: 'indeterminate-quarantined',
        synthetic: true,
      });
      rows.push({
        artifactRef: artifact.artifactRef,
        artifactKind: artifact.kind,
        preUnmergeOwner: survivorPersonId,
        postUnmergeOwner: 'indeterminate',
      });
    }
    return {
      outcome: 'unmerged',
      event: {
        eventId: input.eventId,
        tenantId: input.mergeEvent.tenantId,
        caseId: input.mergeEvent.caseId,
        kind: 'unmerge',
        survivorPersonId,
        mergedPersonId,
        basisAttributes: [],
        decidedBy: input.approvedBy,
        rationale: input.rationale,
        reversesEventId: input.mergeEvent.eventId,
        synthetic: true,
      },
      restoredLineage,
      quarantined,
      report: { rows, indeterminateCount: quarantined.length },
    };
  }

  public propagateUnmerge(
    exposures: readonly EngineDownstreamExposure[],
  ): EngineUnmergePropagation {
    const directives: EngineCorrectionDirective[] = exposures.map((exposure) => ({
      system: exposure.system,
      ownerRole: ownerBySystem[exposure.system],
      artifactRef: exposure.artifactRef,
      action:
        exposure.system === 'claims' && exposure.status === 'adjudicated-paid'
          ? 'rcm-void-rebill-refund'
          : exposure.electronicCorrectionSupported
            ? 'electronic-correction'
            : 'manual-correction-task',
      trackedConfirmationRequired: true,
    }));
    return {
      directives,
      wrongDisclosureIncidents: exposures
        .filter(
          (exposure) =>
            exposure.exposedPersonId !== exposure.correctPersonId &&
            (exposure.status === 'sent' || exposure.status === 'released'),
        )
        .map((exposure) => ({
          artifactRef: exposure.artifactRef,
          system: exposure.system,
          exposedPersonId: exposure.exposedPersonId,
          linkedWorkflow: 'phi-breach-evaluation' as const,
        })),
      harmReview: { taskOwner: 'clinician', findingRecorded: false },
      escalations: exposures
        .filter((exposure) => exposure.materializedClinicalDecision === true)
        .map((exposure) => ({
          artifactRef: exposure.artifactRef,
          escalateTo: 'treating-provider' as const,
          immediate: true as const,
        })),
    };
  }

  public unmergeClosureReport(
    directives: readonly EngineCorrectionDirective[],
    confirmations: ReadonlyMap<string, string>,
  ): EngineClosureReport {
    const outstanding = directives
      .filter((directive) => !confirmations.get(directive.artifactRef))
      .map((directive) => directive.artifactRef);
    return outstanding.length > 0
      ? { complete: false, outstanding }
      : { complete: true, confirmedCount: directives.length };
  }
}
