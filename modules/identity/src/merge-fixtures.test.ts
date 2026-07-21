/**
 * Executable 4-class fixture packs for the WP-016 requirement slice
 * (REQ-ID-009/020/026/027/030). Every case runs against the real domain
 * functions — a fixture that merely "exists" without encoding its acceptance
 * criterion cannot pass here.
 *
 * Review-009 discipline: the accepted-op list is validated at LOAD (an
 * unknown op fails the pack's structural test, not silently), and the
 * dispatcher ends in a throwing default.
 */
import { fileURLToPath } from 'node:url';

import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import type { IdentityAttributeSet, IdentityMatchAttribute } from './matching.js';
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
  readThroughCache,
  resolveMergeCase,
  resolveMergedPerson,
  routePostHocDuplicate,
  shouldReflagPair,
  unmergeClosureReport,
  type CheckInConfirmation,
  type DownstreamExposure,
  type ForeignChartLink,
  type MergeCase,
  type MergeCaseResolution,
  type MergeExecution,
  type MergedChartFacts,
  type PostMergeArtifact,
  type SpecializedReviewPattern,
} from './merge.js';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));

const tenant = 'northwind-synthetic' as TenantId;
const personKeys = {
  survivor: 'np-fx-survivor' as PersonId,
  merged: 'np-fx-merged' as PersonId,
  third: 'np-fx-third' as PersonId,
} as const;
type PersonKey = keyof typeof personKeys;

const acceptedOps = [
  'open-case',
  'resolve-case',
  'reflag',
  'outreach-suppression',
  'checkin',
  'checkin-confirm',
  'posthoc-route',
  'banner',
  'flag-duplicate',
  'detect',
  'merge',
  'unmerge',
  'alias-resolution',
  'propagate',
  'closure',
  'cache',
] as const;
type FixtureOp = (typeof acceptedOps)[number];

interface CaseSetup {
  readonly specializedPatterns?: readonly SpecializedReviewPattern[];
  readonly contactRisk?: boolean;
  readonly conflictingAttributes?: readonly IdentityMatchAttribute[];
  readonly pendingOperations?: readonly string[];
  readonly sourceIdRefs?: readonly string[];
  readonly resolved?: boolean;
}

interface MergeSetup {
  readonly basisAttributes?: readonly IdentityMatchAttribute[];
  readonly decidedBy?: string;
  readonly artifactKinds?: readonly string[];
  readonly specializedPatterns?: readonly SpecializedReviewPattern[];
  readonly specializedChecksRef?: string;
}

interface ExposureSetup {
  readonly system: DownstreamExposure['system'];
  readonly ref: string;
  readonly exposedTo: PersonKey;
  readonly correct: PersonKey;
  readonly status: DownstreamExposure['status'];
  readonly electronic: boolean;
  readonly materialized?: boolean;
}

interface FixtureCase {
  readonly name: string;
  readonly op: FixtureOp;
  readonly expectError?: string;
  // open-case / resolve-case / outreach / reflag
  readonly caseSetup?: CaseSetup;
  readonly personCount?: number;
  readonly resolution?: Partial<MergeCaseResolution> & { readonly kind?: string };
  readonly expectStatus?: string;
  readonly priorResolution?: Partial<MergeCaseResolution>;
  readonly newEvidenceRef?: string;
  readonly expectReflag?: boolean;
  readonly cases?: readonly CaseSetup[];
  readonly expectSuppressedKeys?: readonly PersonKey[];
  // checkin
  readonly entered?: IdentityAttributeSet;
  readonly existingAttributes?: IdentityAttributeSet;
  readonly expectOutcome?: string;
  readonly expectBlocks?: boolean;
  readonly confirmation?: CheckInConfirmation;
  readonly expectRoutedTo?: string;
  readonly bothActive?: boolean;
  // banner / flag / detect
  readonly links?: readonly ForeignChartLink[];
  readonly expectReconciled?: boolean;
  readonly expectSourceSystems?: readonly string[];
  readonly expectMigrationStatus?: string;
  readonly expectProvenanceSystems?: readonly string[];
  readonly facts?: MergedChartFacts;
  readonly expectFlagged?: boolean;
  readonly expectSignals?: readonly string[];
  readonly expectDisposition?: string;
  // merge / unmerge / alias-resolution
  readonly mergeSetup?: MergeSetup;
  readonly expectLineageCount?: number;
  readonly expectResolvedStatus?: string;
  readonly expectAliases?: readonly string[];
  readonly withLineage?: boolean;
  readonly postMergeArtifacts?: readonly {
    readonly ref: string;
    readonly references: readonly PersonKey[];
  }[];
  readonly failAtRestoreIndex?: number;
  readonly approvedBy?: string;
  readonly rationale?: string;
  readonly expectIndeterminateRefs?: readonly string[];
  readonly expectRestoredCount?: number;
  readonly afterUnmerge?: boolean;
  readonly expectResolvedTo?: PersonKey;
  readonly expectRedirected?: boolean;
  // propagate / closure
  readonly exposures?: readonly ExposureSetup[];
  readonly expectActions?: Readonly<Record<string, string>>;
  readonly expectOwners?: Readonly<Record<string, string>>;
  readonly expectIncidentRefs?: readonly string[];
  readonly expectEscalationRefs?: readonly string[];
  readonly confirmations?: Readonly<Record<string, string>>;
  readonly expectComplete?: boolean;
  readonly expectOutstanding?: readonly string[];
  // cache
  readonly sequence?: readonly ('merge' | 'unmerge')[];
  readonly cachePersonKey?: PersonKey;
  readonly cacheAtStep?: number;
  readonly readAtStep?: number;
  readonly expectServed?: boolean;
}

interface MergeFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly cases: readonly FixtureCase[];
}

let caseCounter = 0;
function buildCase(setup: CaseSetup = {}, personCount = 2): MergeCase {
  caseCounter += 1;
  const personIds = [personKeys.survivor, personKeys.merged, personKeys.third].slice(
    0,
    Math.max(2, personCount),
  );
  const opened = openMergeCase({
    caseId: `nmc-fx-${String(caseCounter).padStart(4, '0')}`,
    tenantId: tenant,
    kind: 'possible-match',
    personIds,
    matchedAttributes: ['given-name', 'family-name', 'birth-date'],
    conflictingAttributes: setup.conflictingAttributes ?? [],
    confidence: 'high',
    contactRisk: setup.contactRisk ?? false,
    pendingOperations: setup.pendingOperations ?? [],
    sourceIdRefs: setup.sourceIdRefs ?? [],
    specializedPatterns: setup.specializedPatterns ?? [],
    openedBy: 'synthetic-reviewer-001',
    source: 'synthetic-fixture',
  });
  if (setup.resolved) {
    return resolveMergeCase(opened, {
      kind: 'confirmed-distinct',
      decidedBy: 'synthetic-reviewer-001',
      reason: 'synthetic distinct confirmation',
      doNotReflag: true,
    });
  }
  return opened;
}

function buildMerge(setup: MergeSetup = {}): MergeExecution {
  caseCounter += 1;
  const artifactKinds = setup.artifactKinds ?? [
    'source-identifier',
    'endpoint-association',
    'timeline-entry',
  ];
  const mergeCase = buildCase({
    specializedPatterns: setup.specializedPatterns ?? [],
  });
  return executeMerge({
    mergeCase,
    basis: {
      comparedAttributes: setup.basisAttributes ?? ['given-name', 'family-name', 'birth-date'],
      decidedBy: setup.decidedBy ?? 'synthetic-reviewer-001',
    },
    eventId: `nme-fx-${String(caseCounter).padStart(4, '0')}`,
    survivorPersonId: personKeys.survivor,
    mergedPersonId: personKeys.merged,
    artifacts: artifactKinds.map((kind, index) => ({
      kind,
      artifactRef: `fx-art-${index + 1}`,
      ownerPersonId: personKeys.merged,
    })),
    mergedPersonSourceIdRefs: ['legacy-lakeside:fx-0001'],
    rationale: 'synthetic fixture merge',
    evidenceRef: 'synthetic-fixture-evidence',
    ...(setup.specializedChecksRef !== undefined
      ? { specializedChecksRef: setup.specializedChecksRef }
      : {}),
  });
}

function buildExposure(setup: ExposureSetup): DownstreamExposure {
  return {
    system: setup.system,
    artifactRef: setup.ref,
    exposedPersonId: personKeys[setup.exposedTo],
    correctPersonId: personKeys[setup.correct],
    status: setup.status,
    electronicCorrectionSupported: setup.electronic,
    ...(setup.materialized !== undefined
      ? { materializedClinicalDecision: setup.materialized }
      : {}),
  };
}

function runCase(fixtureCase: FixtureCase): void {
  const wrapped = (invoke: () => unknown): unknown => {
    if (fixtureCase.expectError !== undefined) {
      expect(invoke).toThrow(fixtureCase.expectError);
      return undefined;
    }
    return invoke();
  };
  switch (fixtureCase.op) {
    case 'open-case': {
      const result = wrapped(() =>
        buildCase(fixtureCase.caseSetup ?? {}, fixtureCase.personCount ?? 2),
      ) as MergeCase | undefined;
      if (result) {
        expect(result.status).toBe(fixtureCase.expectStatus ?? 'open');
        expect(result.resolution).toBeUndefined();
      }
      break;
    }
    case 'resolve-case': {
      const mergeCase = buildCase(fixtureCase.caseSetup ?? {});
      const result = wrapped(() =>
        resolveMergeCase(mergeCase, fixtureCase.resolution as MergeCaseResolution),
      ) as MergeCase | undefined;
      if (result && fixtureCase.expectStatus !== undefined) {
        expect(result.status).toBe(fixtureCase.expectStatus);
      }
      break;
    }
    case 'reflag': {
      const prior = buildCase({ resolved: true });
      const adjusted: MergeCase = fixtureCase.priorResolution
        ? {
            ...prior,
            resolution: {
              ...(prior.resolution as MergeCaseResolution),
              ...fixtureCase.priorResolution,
            },
          }
        : prior;
      expect(
        shouldReflagPair(
          [adjusted],
          personKeys.survivor,
          personKeys.merged,
          fixtureCase.newEvidenceRef,
        ),
      ).toBe(fixtureCase.expectReflag);
      break;
    }
    case 'outreach-suppression': {
      const cases = (fixtureCase.cases ?? []).map((setup) => buildCase(setup));
      expect(outreachSuppressedPersonIds(cases)).toEqual(
        [...(fixtureCase.expectSuppressedKeys ?? [])].map((key) => personKeys[key]).sort(),
      );
      break;
    }
    case 'checkin': {
      const evaluation = evaluateCheckInIdentity(fixtureCase.entered ?? {}, [
        {
          person: {
            personId: personKeys.survivor,
            tenantId: tenant,
            status: 'provisional',
            provenance: { source: 'synthetic-fixture', capturedBy: 'synthetic-fixture' },
            synthetic: true,
          },
          names: [],
          attributes: fixtureCase.existingAttributes ?? {},
        },
      ]);
      expect(evaluation.outcome).toBe(fixtureCase.expectOutcome);
      if (fixtureCase.expectBlocks !== undefined) {
        expect(evaluation.outcome === 'duplicate-warning' && evaluation.blocksCompletion).toBe(
          fixtureCase.expectBlocks,
        );
      }
      if (evaluation.outcome === 'duplicate-warning') {
        expect(evaluation.comparison).toBe('side-by-side');
      }
      break;
    }
    case 'checkin-confirm': {
      const result = wrapped(() =>
        confirmCheckInResolution(fixtureCase.confirmation as CheckInConfirmation),
      ) as ReturnType<typeof confirmCheckInResolution> | undefined;
      if (result) {
        expect(result.outcome).toBe(fixtureCase.expectOutcome);
        if (result.outcome === 'check-in-paused') {
          expect(result.billingBlocked).toBe(true);
          expect(result.clinicalDocumentationBlocked).toBe(true);
          if (fixtureCase.expectRoutedTo !== undefined) {
            expect(result.routedTo).toBe(fixtureCase.expectRoutedTo);
          }
        }
        if (result.outcome === 'proceed-new-record') {
          expect(result.nearMatchLogged).toBe('reviewed-and-dismissed');
        }
        if (result.outcome === 'proceed-existing-record') {
          expect(result.newRecordCreated).toBe(false);
          expect(result.resolutionLogged).toBe(true);
        }
      }
      break;
    }
    case 'posthoc-route': {
      const route = routePostHocDuplicate(fixtureCase.bothActive ?? false);
      expect(route.routedTo).toBe(fixtureCase.expectRoutedTo);
      if (route.routedTo === 'merge-review-queue') {
        expect(route.frontDeskMayResolve).toBe(false);
      }
      break;
    }
    case 'banner': {
      const view = foreignChartBanner(fixtureCase.links ?? []);
      expect(view.reconciled).toBe(fixtureCase.expectReconciled);
      if (!view.reconciled) {
        if (fixtureCase.expectSourceSystems !== undefined) {
          expect(view.banner.sourceSystems).toEqual(fixtureCase.expectSourceSystems);
        }
        if (fixtureCase.expectMigrationStatus !== undefined) {
          expect(view.banner.migrationStatus).toBe(fixtureCase.expectMigrationStatus);
        }
      } else if (fixtureCase.expectProvenanceSystems !== undefined) {
        expect(view.provenance.map((entry) => entry.sourceSystem)).toEqual(
          fixtureCase.expectProvenanceSystems,
        );
      }
      break;
    }
    case 'flag-duplicate': {
      caseCounter += 1;
      const flagged = flagSuspectedDuplicate({
        caseId: `nmc-fxf-${String(caseCounter).padStart(4, '0')}`,
        tenantId: tenant,
        personIds: [personKeys.survivor, personKeys.merged],
        matchedAttributes: ['given-name', 'family-name'],
        confidence: 'medium',
        openedBy: 'synthetic-acquired-clinic-staff-001',
        source: 'synthetic-record-view',
      });
      expect(flagged.routedTo).toBe(fixtureCase.expectRoutedTo);
      expect(flagged.kind).toBe('staff-flagged-duplicate');
      expect(flagged.status).toBe('open');
      break;
    }
    case 'detect': {
      const detection = detectWrongMergeSuspects(fixtureCase.facts as MergedChartFacts);
      expect(detection.flagged).toBe(fixtureCase.expectFlagged);
      if (fixtureCase.expectSignals !== undefined) {
        expect(detection.signals).toEqual(fixtureCase.expectSignals);
      }
      if (fixtureCase.expectDisposition !== undefined) {
        expect(detection.disposition).toBe(fixtureCase.expectDisposition);
      }
      expect(detection.autoUnmerge).toBe(false);
      break;
    }
    case 'merge': {
      const result = wrapped(() => buildMerge(fixtureCase.mergeSetup ?? {})) as
        MergeExecution | undefined;
      if (result) {
        if (fixtureCase.expectLineageCount !== undefined) {
          expect(result.lineage).toHaveLength(fixtureCase.expectLineageCount);
        }
        if (fixtureCase.expectResolvedStatus !== undefined) {
          expect(result.resolvedCase.status).toBe(fixtureCase.expectResolvedStatus);
        }
        if (fixtureCase.expectAliases !== undefined) {
          expect(result.preservedAliases).toEqual(fixtureCase.expectAliases);
          expect(result.aliasesPreserved).toBe(true);
        }
      }
      break;
    }
    case 'unmerge': {
      const execution = buildMerge(fixtureCase.mergeSetup ?? {});
      let applied = 0;
      const outcome = wrapped(() =>
        executeUnmerge({
          mergeEvent: execution.event,
          lineage: fixtureCase.withLineage === false ? [] : execution.lineage,
          postMergeArtifacts: (fixtureCase.postMergeArtifacts ?? []).map(
            (artifact): PostMergeArtifact => ({
              kind: 'timeline-entry',
              artifactRef: artifact.ref,
              referencesPersonIds: artifact.references.map((key) => personKeys[key]),
            }),
          ),
          eventId: `${execution.event.eventId}-r`,
          approvedBy: fixtureCase.approvedBy ?? 'synthetic-compliance-001',
          rationale: fixtureCase.rationale ?? 'synthetic fixture reversal',
          ...(fixtureCase.failAtRestoreIndex !== undefined
            ? {
                applyRestore: () => {
                  applied += 1;
                  if (applied === fixtureCase.failAtRestoreIndex) {
                    throw new Error('synthetic restore failure');
                  }
                },
              }
            : {}),
        }),
      ) as ReturnType<typeof executeUnmerge> | undefined;
      if (!outcome) {
        break;
      }
      expect(outcome.outcome).toBe(fixtureCase.expectOutcome);
      if (outcome.outcome === 'unmerged') {
        if (fixtureCase.expectRestoredCount !== undefined) {
          expect(outcome.restoredLineage).toHaveLength(fixtureCase.expectRestoredCount);
          for (const record of outcome.restoredLineage) {
            expect(record.toPersonId).toBe(personKeys.merged);
          }
        }
        if (fixtureCase.expectIndeterminateRefs !== undefined) {
          expect(outcome.quarantined.map((record) => record.artifactRef).sort()).toEqual(
            [...fixtureCase.expectIndeterminateRefs].sort(),
          );
          expect(outcome.report.indeterminateCount).toBe(
            fixtureCase.expectIndeterminateRefs.length,
          );
          for (const ref of fixtureCase.expectIndeterminateRefs) {
            expect(
              outcome.report.rows.find((row) => row.artifactRef === ref)?.postUnmergeOwner,
            ).toBe('indeterminate');
          }
        }
        // The report always shows every artifact's pre/post owner.
        expect(outcome.report.rows.length).toBeGreaterThanOrEqual(outcome.restoredLineage.length);
      }
      if (outcome.outcome === 'blocked-no-lineage') {
        expect(outcome.manualChartReviewOpened).toBe(true);
        expect(outcome.autoSplitRefused).toBe(true);
      }
      if (outcome.outcome === 'rolled-back-to-merged') {
        expect(outcome.noHalfSplit).toBe(true);
        expect(outcome.p0Alert.severity).toBe('P0');
      }
      break;
    }
    case 'alias-resolution': {
      const execution = buildMerge(fixtureCase.mergeSetup ?? {});
      const events = [execution.event];
      if (fixtureCase.afterUnmerge) {
        const outcome = executeUnmerge({
          mergeEvent: execution.event,
          lineage: execution.lineage,
          postMergeArtifacts: [],
          eventId: `${execution.event.eventId}-r`,
          approvedBy: 'synthetic-compliance-001',
          rationale: 'synthetic fixture reversal',
        });
        if (outcome.outcome !== 'unmerged') {
          throw new Error(`alias-resolution setup failed: ${outcome.outcome}`);
        }
        events.push(outcome.event);
      }
      const resolved = resolveMergedPerson(events, personKeys.merged);
      expect(resolved.personId).toBe(personKeys[fixtureCase.expectResolvedTo ?? 'survivor']);
      expect(resolved.redirected).toBe(fixtureCase.expectRedirected ?? true);
      break;
    }
    case 'propagate': {
      const propagation = propagateUnmerge((fixtureCase.exposures ?? []).map(buildExposure));
      for (const [ref, action] of Object.entries(fixtureCase.expectActions ?? {})) {
        expect(
          propagation.directives.find((directive) => directive.artifactRef === ref)?.action,
          `directive action for ${ref}`,
        ).toBe(action);
      }
      for (const [ref, ownerRole] of Object.entries(fixtureCase.expectOwners ?? {})) {
        expect(
          propagation.directives.find((directive) => directive.artifactRef === ref)?.ownerRole,
          `directive owner for ${ref}`,
        ).toBe(ownerRole);
      }
      if (fixtureCase.expectIncidentRefs !== undefined) {
        expect(
          propagation.wrongDisclosureIncidents.map((incident) => incident.artifactRef).sort(),
        ).toEqual([...fixtureCase.expectIncidentRefs].sort());
        for (const incident of propagation.wrongDisclosureIncidents) {
          expect(incident.linkedWorkflow).toBe('phi-breach-evaluation');
        }
      }
      if (fixtureCase.expectEscalationRefs !== undefined) {
        expect(propagation.escalations.map((escalation) => escalation.artifactRef).sort()).toEqual(
          [...fixtureCase.expectEscalationRefs].sort(),
        );
        for (const escalation of propagation.escalations) {
          expect(escalation.immediate).toBe(true);
          expect(escalation.escalateTo).toBe('treating-provider');
        }
      }
      expect(propagation.harmReview.taskOwner).toBe('clinician');
      expect(
        propagation.directives.every((directive) => directive.trackedConfirmationRequired),
      ).toBe(true);
      break;
    }
    case 'closure': {
      const propagation = propagateUnmerge((fixtureCase.exposures ?? []).map(buildExposure));
      const report = unmergeClosureReport(
        propagation.directives,
        new Map(Object.entries(fixtureCase.confirmations ?? {})),
      );
      expect(report.complete).toBe(fixtureCase.expectComplete);
      if (!report.complete && fixtureCase.expectOutstanding !== undefined) {
        expect(report.outstanding).toEqual(fixtureCase.expectOutstanding);
      }
      break;
    }
    case 'cache': {
      const events = [];
      let openMerge;
      for (const [index, step] of (fixtureCase.sequence ?? []).entries()) {
        if (step === 'merge') {
          const execution = buildMerge({});
          const event = { ...execution.event, eventId: `fx-cache-${index}` };
          openMerge = event;
          events.push(event);
        } else {
          if (!openMerge) {
            throw new Error('cache sequence unmerges before any merge');
          }
          events.push({
            ...openMerge,
            eventId: `fx-cache-${index}`,
            kind: 'unmerge' as const,
            basisAttributes: [],
            reversesEventId: openMerge.eventId,
          });
          openMerge = undefined;
        }
      }
      const personId = personKeys[fixtureCase.cachePersonKey ?? 'survivor'];
      const entry = {
        personId,
        epochAtWrite:
          invalidationEpochs(events.slice(0, fixtureCase.cacheAtStep ?? 0)).get(personId) ?? 0,
        payloadRef: 'fx-cached-permission',
      };
      const result = readThroughCache(
        invalidationEpochs(events.slice(0, fixtureCase.readAtStep ?? events.length)),
        entry,
      );
      expect(result.served).toBe(fixtureCase.expectServed);
      if (!result.served) {
        expect(result.refused).toBe('stale-identity-cache');
      }
      break;
    }
    default: {
      throw new Error(
        `unrecognized fixture op ${JSON.stringify((fixtureCase as { op: string }).op)} — ` +
          'the dispatcher refuses unknown cases (review-009)',
      );
    }
  }
}

for (const requirementId of [
  'REQ-ID-009',
  'REQ-ID-020',
  'REQ-ID-026',
  'REQ-ID-027',
  'REQ-ID-030',
]) {
  describe(`${requirementId} fixture pack (4-class floor)`, () => {
    const pack = loadRequirementFixturePack(fixturesDirectory, requirementId);

    it('carries all four fixture classes with the synthetic watermark', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
    });

    it('every case declares a recognized op (load-time validation, review-009)', () => {
      for (const fixtureClass of requiredFixtureClasses) {
        const fixture = pack.fixtures[fixtureClass] as unknown as MergeFixture;
        expect(fixture.cases.length).toBeGreaterThan(0);
        for (const fixtureCase of fixture.cases) {
          expect(
            (acceptedOps as readonly string[]).includes(fixtureCase.op),
            `${fixtureClass}: unknown op ${JSON.stringify(fixtureCase.op)}`,
          ).toBe(true);
        }
      }
    });

    for (const fixtureClass of requiredFixtureClasses) {
      describe(fixtureClass, () => {
        const fixture = pack.fixtures[fixtureClass] as unknown as MergeFixture;
        for (const fixtureCase of fixture.cases) {
          it(fixtureCase.name, () => {
            runCase(fixtureCase);
          });
        }
      });
    }
  });
}
