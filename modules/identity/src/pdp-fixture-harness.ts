/**
 * Shared executable harness for the WP-015 fixture packs. Every case runs
 * against the REAL domain functions — a fixture that merely "exists" without
 * encoding its acceptance criterion cannot pass. Review-009 discipline: the
 * accepted-op list is validated at LOAD, and the dispatcher ends in a
 * throwing default. Test-only module (imported by the two fixture suites).
 */
import { emitAuditEvent, emptyChainState } from '@practicehub/audit-evidence';
import { jurisdictionPacksV1 } from '@practicehub/platform-core';
import { expect } from 'vitest';

import type { AuditEmitInput } from '@practicehub/audit-evidence';
import type { PersonId, TenantId } from '@practicehub/contracts';

import type { GuarantorRole } from './identity.js';
import {
  correctDeceasedFlag,
  deceasedFlagState,
  setDeceasedFlag,
  unlockChartForEstate,
  type PersonFlagEvent,
} from './chart-lock.js';
import {
  assembleRecordsExport,
  auditGeneticCoverage,
  breakGlassSeverityFor,
  classifyDataElement,
  renderEmployerSurface,
  type GeneticIngestionPath,
  type GipaAuthorization,
} from './gipa.js';
import {
  assignRole,
  attestGrant,
  canonicalRoleTemplateSeedsV1,
  evaluateAccess,
  evaluateSeparationOfDuties,
  grantAccessOverride,
  pdpInvalidationEpochs,
  pdpPolicyV1,
  readPdpCache,
  runAccessReview,
  sodPairsV1,
  type AccessOverride,
  type ActualGrant,
  type PdpActor,
  type PdpDecision,
  type PdpRequest,
  type RoleAssignment,
  type RoleTemplate,
} from './pdp.js';
import {
  activateIncapacityAuthority,
  attemptAuthorityExtension,
  changeGuarantorAuthority,
  deactivateOnCapacityReturn,
  deliverEmancipatedArtifact,
  disputeGuarantorDesignation,
  establishEmancipation,
  establishProxyAuthority,
  evaluateMajorityTransition,
  expireTemporaryAuthority,
  openCustodyConflict,
  openRenewalWindow,
  reassignHistoricalBalances,
  releaseGuarantor,
  replaceGuardianAuthority,
  resolveCustodyConflict,
  rollbackGuardianReplacement,
  versionLegalStatusChange,
  type AuthorityRecord,
  type CourtOrderValidation,
  type OpenCareItem,
} from './proxy-authority.js';

export const tenant = 'northwind-synthetic' as TenantId;
export const adult = 'np-alex-rivera' as PersonId;
export const minor = 'np-casey-rivera' as PersonId;
export const staffPerson = 'np-morgan-lee' as PersonId;
export const deceasedPerson = 'np-riley-fox' as PersonId;
export const otherAdult = 'np-jordan-kim' as PersonId;

export const acceptedOps = [
  'evaluate',
  'assign-role',
  'grant-override',
  'run-review',
  'attest',
  'sod-evaluate',
  'cache-read',
  'classify',
  'coverage-audit',
  'assemble-export',
  'employer-render',
  'break-glass-severity',
  'set-deceased',
  'correct-deceased',
  'unlock-estate',
  'establish-authority',
  'replace-guardian',
  'rollback-replacement',
  'custody-resolve',
  'renewal-window',
  'expire-authority',
  'attempt-extension',
  'emancipation-establish',
  'emancipation-deliver',
  'emancipation-version',
  'incapacity-activate',
  'incapacity-deactivate',
  'majority-evaluate',
  'guarantor-change',
  'guarantor-release',
  'guarantor-dispute',
  'reassign-balances',
] as const;
export type FixtureOp = (typeof acceptedOps)[number];

const templates: readonly RoleTemplate[] = canonicalRoleTemplateSeedsV1.map((seed) => ({
  ...seed,
  tenantId: tenant,
}));

export const guardianAuthorityBase: AuthorityRecord = {
  tenantId: tenant,
  authorityId: 'nar-alex-casey',
  version: 1,
  kind: 'guardian-minor',
  granteePersonId: adult,
  subjectPersonId: minor,
  scope: [
    { segment: 'scheduling', actions: ['view', 'edit'] },
    { segment: 'messaging', actions: ['view', 'edit'] },
    { segment: 'results', actions: ['view'] },
  ],
  jurisdiction: 'NV',
  evidenceRef: 'synthetic-guardian-evidence-0001',
  consentCapturedOn: '2026-01-10',
  effectiveDate: '2026-01-10',
  verifiedBy: 'synthetic-front-desk-001',
  status: 'active',
  decidedBy: 'synthetic-front-desk-001',
  synthetic: true,
};

export const guarantorRoleBase: GuarantorRole = {
  guarantorRoleId: 'ngr-alex-for-casey',
  tenantId: tenant,
  guarantorPersonId: adult,
  patientRecordId: 'npr-casey-rivera' as never,
  scope: ['statements', 'payment-methods'],
  evidenceRef: 'synthetic-guarantor-evidence-0001',
  status: 'active',
  synthetic: true,
};

const activeGipaAuthorization: GipaAuthorization = {
  authorizationId: 'nga-0001',
  tenantId: tenant,
  subjectPersonId: adult,
  scopeRef: 'synthetic-gipa-scope-life-insurer',
  grantedOn: '2026-02-01',
  expiresOn: '2027-02-01',
  writtenEvidenceRef: 'synthetic-gipa-written-0001',
  status: 'active',
  synthetic: true,
};

const expiredGipaAuthorization: GipaAuthorization = {
  ...activeGipaAuthorization,
  authorizationId: 'nga-0002',
  grantedOn: '2025-01-15',
  expiresOn: '2026-01-15',
};

export interface ActorSpec {
  readonly kind: 'staff' | 'patient' | 'proxy' | 'guarantor' | 'employer';
  readonly roleKey?: RoleTemplate['roleKey'];
  readonly overrides?: readonly {
    readonly segment: AccessOverride['segment'];
    readonly actions: readonly AccessOverride['actions'][number][];
    readonly expiresOn: string;
  }[];
  readonly authority?: Partial<AuthorityRecord>;
  readonly guarantorScope?: readonly string[];
}

export interface EvaluateSpec {
  readonly actor: ActorSpec;
  readonly segment: PdpRequest['segment'];
  readonly action: PdpRequest['action'];
  readonly purpose?: PdpRequest['purpose'];
  readonly subject?: 'adult' | 'minor' | 'self' | 'deceased';
  readonly consent?: PdpRequest['consent'];
  readonly stepUp?: boolean;
  readonly deceased?: boolean;
  readonly estateUnlock?: boolean;
  readonly patientState?: string | null;
  readonly gipaAuth?: 'active' | 'expired' | 'none';
  readonly partitionTags?: readonly ('gipa-genetic' | 'chd' | 'part2' | 'biometric')[];
}

export interface FixtureCase {
  readonly name: string;
  readonly op: FixtureOp;
  readonly expectError?: string;
  readonly evaluate?: EvaluateSpec;
  readonly expectAllowed?: boolean;
  readonly expectDenials?: readonly string[];
  readonly expectObligations?: readonly string[];
  readonly expectBasisContains?: string;
  readonly expectPartitionTags?: readonly string[];
  readonly expectActorRef?: string;
  // role admin
  readonly priorAssignments?: readonly { readonly roleKey: RoleTemplate['roleKey'] }[];
  readonly newRoleKey?: RoleTemplate['roleKey'];
  readonly expectEndedCount?: number;
  readonly overrideSegment?: AccessOverride['segment'];
  readonly omitJustification?: boolean;
  readonly omitExpiry?: boolean;
  readonly actualGrants?: readonly {
    readonly system: string;
    readonly segment: string;
    readonly action: string;
  }[];
  readonly externalPermits?: readonly { readonly segment: string; readonly action: string }[];
  readonly reviewRoleKey?: RoleTemplate['roleKey'];
  readonly pinTemplateVersion?: number;
  readonly bumpTemplate?: boolean;
  readonly expectFindingKinds?: readonly string[];
  readonly attestDecision?: 'confirm' | 'revoke';
  readonly expectAccessChange?: boolean;
  // sod / cache
  readonly sodId?: string;
  readonly firstActor?: string;
  readonly secondActor?: string;
  readonly expectCompliant?: boolean;
  readonly cacheWriteBeforeChange?: boolean;
  readonly changeKind?: 'merge' | 'role-change' | 'none';
  readonly expectServed?: boolean;
  // gipa
  readonly elementKind?: string;
  readonly ingestPath?: GeneticIngestionPath;
  readonly reliable?: boolean;
  readonly expectTagged?: boolean;
  readonly expectReviewStatus?: string;
  readonly expectBlocked?: boolean;
  readonly coveredPaths?: readonly GeneticIngestionPath[];
  readonly expectComplete?: boolean;
  readonly expectMissing?: readonly string[];
  readonly exportAuth?: 'active' | 'expired' | 'none';
  readonly sendDate?: string;
  readonly expectIncludedCount?: number;
  readonly expectExcludedGeneticCount?: number;
  readonly expectAuthorizationRef?: string;
  readonly employerMetric?: string;
  readonly expectValue?: number;
  readonly severityTags?: readonly ('gipa-genetic' | 'chd' | 'part2' | 'biometric')[];
  readonly expectSeverity?: string;
  // chart lock
  readonly withPriorSet?: boolean;
  readonly omitSource?: boolean;
  readonly omitCorrectionEvidence?: boolean;
  readonly expectDeceasedState?: boolean;
  readonly expectSuppressionChannels?: number;
  readonly expectVendorPropagation?: boolean;
  readonly unlockRoles?: readonly RoleTemplate['roleKey'][];
  readonly omitPurposeRef?: boolean;
  // authority lifecycle
  readonly authority?: Partial<AuthorityRecord>;
  readonly relationshipVerified?: boolean;
  readonly omitVerifier?: boolean;
  readonly providerState?: string | null;
  readonly expectOutcome?: string;
  readonly orderFlags?: Partial<CourtOrderValidation>;
  readonly openItems?: readonly {
    readonly itemRef: string;
    readonly kind: OpenCareItem['kind'];
    readonly disposition?: OpenCareItem['disposition'];
  }[];
  readonly expectUndispositioned?: readonly string[];
  readonly expectNextVersion?: number;
  readonly expectPriorStatus?: string;
  readonly custodyBasis?: string;
  readonly expectResolvedVersion?: number;
  readonly asOfDate?: string;
  readonly patientState?: string | null;
  readonly expectQueueCount?: number;
  readonly extensionBasis?: string;
  readonly statusResolved?: boolean;
  readonly artifactKind?: 'clinical' | 'financial';
  readonly recipient?: 'guardian' | 'self';
  readonly expectAuthorized?: boolean;
  readonly ended?: boolean;
  readonly withTrigger?: boolean;
  readonly conflictingEvidence?: boolean;
  readonly birthDate?: string | null;
  readonly records?: readonly Partial<AuthorityRecord>[];
  readonly adultConsentCompleted?: boolean;
  readonly expectPhase?: string;
  readonly expectSuspendedIds?: readonly string[];
  readonly expectPreservedIds?: readonly string[];
  readonly expectReConsent?: readonly string[];
  readonly expectCarveoutContains?: string;
  readonly expectConfidentialDefault?: string;
  readonly expectContactDirective?: boolean;
  // guarantor change
  readonly blockers?: readonly string[];
  readonly reviewedMissing?: string;
  readonly omitBillingConsent?: boolean;
  readonly unpaidBalance?: boolean;
  readonly withPaymentMethod?: boolean;
  readonly expectTransfersTo?: string;
  readonly omitApprover?: boolean;
  readonly expectRewrites?: boolean;
}

export interface PdpFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly cases: readonly FixtureCase[];
}

function buildActor(spec: ActorSpec, fixtureCase: FixtureCase): PdpActor {
  switch (spec.kind) {
    case 'staff': {
      const roleKey = spec.roleKey ?? 'front-desk';
      return {
        kind: 'staff',
        actorRef: `synthetic-staff:nsa-${roleKey}`,
        staffAccountId: `nsa-${roleKey}`,
        personId: staffPerson,
        assignments: [
          {
            tenantId: tenant,
            assignmentId: `nra-${roleKey}`,
            staffAccountId: `nsa-${roleKey}`,
            staffPersonId: staffPerson,
            roleKey,
            templateVersion: 1,
            locationScope: [],
            effectiveDate: '2026-01-01',
            status: 'active',
            assignedBy: 'synthetic-it-admin-001',
            synthetic: true,
          },
        ],
        templates,
        overrides: (spec.overrides ?? []).map((override, index) => ({
          tenantId: tenant,
          overrideId: `nov-fx-${index}`,
          staffAccountId: `nsa-${roleKey}`,
          segment: override.segment,
          actions: override.actions,
          justification: 'synthetic fixture override',
          approvedBy: 'synthetic-compliance-officer-001',
          expiresOn: override.expiresOn,
          flaggedForReview: true,
          status: 'active',
          synthetic: true,
        })),
      };
    }
    case 'patient':
      return { kind: 'patient', actorRef: 'synthetic-portal:np-alex-rivera', personId: adult };
    case 'proxy':
      return {
        kind: 'proxy',
        actorRef: 'synthetic-portal:np-alex-rivera',
        personId: adult,
        authorityRecords: [authorityFrom(spec.authority)],
      };
    case 'guarantor':
      return {
        kind: 'guarantor',
        actorRef: 'synthetic-portal:np-alex-rivera',
        personId: adult,
        guarantorRoles: [
          {
            ...guarantorRoleBase,
            ...(spec.guarantorScope !== undefined ? { scope: spec.guarantorScope } : {}),
          },
        ],
      };
    case 'employer':
      return {
        kind: 'employer-sponsor-admin',
        actorRef: 'synthetic-employer:acme-sponsor',
        legalEntityId: 'northwind-health-nv' as never,
      };
    default: {
      const exhaustive: never = spec.kind;
      throw new Error(`unknown actor kind ${JSON.stringify(exhaustive)} in ${fixtureCase.name}`);
    }
  }
}

function runEvaluate(fixtureCase: FixtureCase): PdpDecision {
  const spec = fixtureCase.evaluate;
  if (spec === undefined) {
    throw new Error(`${fixtureCase.name}: evaluate cases carry an evaluate spec`);
  }
  const actor = buildActor(spec.actor, fixtureCase);
  const subjectPersonId =
    spec.subject === 'minor'
      ? minor
      : spec.subject === 'self'
        ? adult
        : spec.subject === 'deceased'
          ? deceasedPerson
          : adult;
  const gipaAuthorizations =
    spec.gipaAuth === 'active'
      ? [{ ...activeGipaAuthorization, subjectPersonId }]
      : spec.gipaAuth === 'expired'
        ? [{ ...expiredGipaAuthorization, subjectPersonId }]
        : [];
  const decision = evaluateAccess(pdpPolicyV1, {
    tenantId: tenant,
    actor,
    segment: spec.segment,
    action: spec.action,
    purpose: spec.purpose ?? 'treatment',
    subjectPersonId,
    subjectPatientRecordId: 'npr-casey-rivera' as never,
    ...(spec.partitionTags !== undefined ? { partitionTags: spec.partitionTags } : {}),
    ...(spec.consent !== undefined ? { consent: spec.consent } : {}),
    ...(spec.stepUp !== undefined ? { stepUpSatisfied: spec.stepUp } : {}),
    ...(spec.deceased !== undefined ? { subjectDeceased: spec.deceased } : {}),
    ...(spec.estateUnlock === true
      ? {
          estateUnlock: {
            unlockRef: 'neu-fx-0001',
            personId: subjectPersonId,
            unlockedByRole: 'practice-manager' as const,
            documentedPurposeRef: 'synthetic-estate-purpose-0001',
          },
        }
      : {}),
    gipaAuthorizations,
    providerState: null,
    patientState: spec.patientState ?? null,
    occurredAt: '2026-03-25T10:00:00Z',
    auditId: 'fx-eval-0001',
  });
  // EVERY decision — allow and deny — must emit through the real store.
  const emitted = emitAuditEvent(emptyChainState, decision.auditInput as AuditEmitInput);
  expect(emitted.record.decision).toBe(decision.allowed ? 'allow' : 'deny');
  return decision;
}

function toOpenCareItems(items: FixtureCase['openItems']): readonly OpenCareItem[] {
  return (items ?? []).map((item) => ({
    itemRef: item.itemRef,
    kind: item.kind,
    ...(item.disposition !== undefined ? { disposition: item.disposition } : {}),
  }));
}

/** JSON `null` in an authority override means "remove the base field". */
function authorityFrom(partial: Partial<AuthorityRecord> | undefined): AuthorityRecord {
  const merged: Record<string, unknown> = { ...guardianAuthorityBase, ...(partial ?? {}) };
  return Object.fromEntries(
    Object.entries(merged).filter(([key, value]) => value !== null || key === 'jurisdiction'),
  ) as unknown as AuthorityRecord;
}

const defaultOrder: CourtOrderValidation = {
  jurisdictionValidated: true,
  partiesValidated: true,
  scopeApproved: true,
  authenticityValidated: true,
  effectiveDate: '2026-04-01',
  ambiguous: false,
  conflicting: false,
  appealed: false,
  orderEvidenceRef: 'synthetic-court-order-0001',
};

export function runFixtureCase(fixtureCase: FixtureCase): void {
  const wrapped = (invoke: () => unknown): unknown => {
    if (fixtureCase.expectError !== undefined) {
      expect(invoke).toThrow(fixtureCase.expectError);
      return undefined;
    }
    return invoke();
  };
  switch (fixtureCase.op) {
    case 'evaluate': {
      const decision = wrapped(() => runEvaluate(fixtureCase)) as PdpDecision | undefined;
      if (decision === undefined) {
        break;
      }
      if (fixtureCase.expectAllowed !== undefined) {
        expect(decision.allowed, fixtureCase.name).toBe(fixtureCase.expectAllowed);
      }
      for (const code of fixtureCase.expectDenials ?? []) {
        expect(decision.denialCodes, fixtureCase.name).toContain(code);
      }
      for (const obligation of fixtureCase.expectObligations ?? []) {
        expect(decision.obligations, fixtureCase.name).toContain(obligation);
      }
      if (fixtureCase.expectBasisContains !== undefined) {
        expect(decision.basisRefs.join('|')).toContain(fixtureCase.expectBasisContains);
      }
      if (fixtureCase.expectPartitionTags !== undefined) {
        expect(decision.auditInput.partitionTags ?? []).toEqual(fixtureCase.expectPartitionTags);
      }
      if (fixtureCase.expectActorRef !== undefined) {
        expect(decision.auditInput.actorRef).toBe(fixtureCase.expectActorRef);
      }
      break;
    }
    case 'assign-role': {
      const prior: RoleAssignment[] = (fixtureCase.priorAssignments ?? []).map((entry, index) => ({
        tenantId: tenant,
        assignmentId: `nra-prior-${index}`,
        staffAccountId: 'nsa-morgan-lee',
        staffPersonId: staffPerson,
        roleKey: entry.roleKey,
        templateVersion: 1,
        locationScope: [],
        effectiveDate: '2026-01-01',
        status: 'active',
        assignedBy: 'synthetic-it-admin-001',
        synthetic: true,
      }));
      const outcome = assignRole(prior, {
        tenantId: tenant,
        assignmentId: 'nra-next',
        staffAccountId: 'nsa-morgan-lee',
        staffPersonId: staffPerson,
        roleKey: fixtureCase.newRoleKey ?? 'front-desk',
        templateVersion: 1,
        locationScope: [],
        effectiveDate: '2026-03-01',
        status: 'active',
        assignedBy: 'synthetic-it-admin-001',
        synthetic: true,
      });
      expect(outcome.ended).toHaveLength(fixtureCase.expectEndedCount ?? 0);
      for (const endedAssignment of outcome.ended) {
        expect(endedAssignment.status).toBe('ended');
        expect(endedAssignment.endedReason).toBe('superseded-by-new-assignment');
      }
      break;
    }
    case 'grant-override': {
      const outcome = wrapped(() =>
        grantAccessOverride({
          tenantId: tenant,
          overrideId: 'nov-fx-case',
          staffAccountId: 'nsa-morgan-lee',
          segment: fixtureCase.overrideSegment ?? 'documents',
          actions: ['view'],
          justification: fixtureCase.omitJustification === true ? '' : 'synthetic fixture reason',
          approvedBy: 'synthetic-compliance-officer-001',
          expiresOn: fixtureCase.omitExpiry === true ? '' : '2026-09-30',
        }),
      ) as AccessOverride | undefined;
      if (outcome !== undefined) {
        expect(outcome.flaggedForReview).toBe(true);
      }
      break;
    }
    case 'run-review': {
      const roleKey = fixtureCase.reviewRoleKey ?? 'front-desk';
      const baseTemplates = fixtureCase.bumpTemplate
        ? [
            ...templates.map((template) =>
              template.roleKey === roleKey
                ? { ...template, status: 'superseded' as const }
                : template,
            ),
            ...templates
              .filter((template) => template.roleKey === roleKey)
              .map((template) => ({
                ...template,
                version: 2,
                status: 'active' as const,
                changeReason: 'synthetic-tightening',
              })),
          ]
        : templates;
      const review = runAccessReview({
        tenantId: tenant,
        assignments: [
          {
            tenantId: tenant,
            assignmentId: 'nra-review',
            staffAccountId: 'nsa-morgan-lee',
            staffPersonId: staffPerson,
            roleKey,
            templateVersion: fixtureCase.pinTemplateVersion ?? 1,
            locationScope: [],
            effectiveDate: '2026-01-01',
            status: 'active',
            assignedBy: 'synthetic-it-admin-001',
            synthetic: true,
          },
        ],
        templates: baseTemplates,
        overrides: [],
        actualGrants: (fixtureCase.actualGrants ?? []).map((grant) => ({
          staffAccountId: 'nsa-morgan-lee',
          ...grant,
        })),
        ...(fixtureCase.externalPermits !== undefined
          ? {
              externalRoleDefinitions: [
                {
                  system: 'athena-one',
                  roleKey,
                  permits: fixtureCase.externalPermits.map((permit) => ({
                    segment: permit.segment as RoleTemplate['permits'][number]['segment'],
                    actions: [permit.action as 'view'],
                  })),
                },
              ],
            }
          : {}),
        asOfDate: fixtureCase.asOfDate ?? '2026-03-25',
      });
      const kinds = review.findings.map((finding) => finding.kind);
      for (const kind of fixtureCase.expectFindingKinds ?? []) {
        expect(kinds, fixtureCase.name).toContain(kind);
      }
      break;
    }
    case 'attest': {
      const grant: ActualGrant = {
        staffAccountId: 'nsa-morgan-lee',
        system: 'practicehub',
        segment: 'medications',
        action: 'view',
      };
      const outcome = wrapped(() =>
        attestGrant(
          grant,
          fixtureCase.attestDecision ?? 'confirm',
          fixtureCase.omitApprover === true ? '' : 'synthetic-practice-manager-001',
          'synthetic review cycle',
        ),
      );
      if (outcome !== undefined && fixtureCase.expectAccessChange !== undefined) {
        expect('accessChangeDirective' in (outcome as object)).toBe(fixtureCase.expectAccessChange);
      }
      break;
    }
    case 'sod-evaluate': {
      const outcome = wrapped(() =>
        evaluateSeparationOfDuties(
          sodPairsV1,
          fixtureCase.sodId ?? 'sod-gate-1',
          fixtureCase.firstActor ?? 'synthetic-a',
          fixtureCase.secondActor ?? 'synthetic-b',
        ),
      ) as { compliant: boolean } | undefined;
      if (outcome !== undefined && fixtureCase.expectCompliant !== undefined) {
        expect(outcome.compliant).toBe(fixtureCase.expectCompliant);
      }
      break;
    }
    case 'cache-read': {
      const epochsBefore = pdpInvalidationEpochs([], []);
      const entry = {
        personId: staffPerson,
        epochAtWrite: epochsBefore.get(staffPerson) ?? 0,
        payloadRef: 'synthetic-permit-cache-fx',
      };
      const change = fixtureCase.changeKind ?? 'none';
      const epochsAfter =
        change === 'role-change'
          ? pdpInvalidationEpochs([], [{ eventRef: 'fx-role-change', personIds: [staffPerson] }])
          : change === 'merge'
            ? pdpInvalidationEpochs(
                [
                  {
                    tenantId: tenant,
                    eventId: 'nme-fx-0001',
                    caseId: 'nmc-fx-0001',
                    kind: 'merge',
                    survivorPersonId: staffPerson,
                    mergedPersonId: otherAdult,
                    basisAttributes: ['given-name', 'family-name', 'birth-date'],
                    decidedBy: 'synthetic-data-migration-001',
                    rationale: 'synthetic fixture merge',
                    evidenceRef: 'synthetic-merge-evidence-fx',
                    synthetic: true,
                  },
                ],
                [],
              )
            : epochsBefore;
      const read = readPdpCache(epochsAfter, entry);
      expect(read.served).toBe(fixtureCase.expectServed ?? true);
      break;
    }
    case 'classify': {
      const outcome = classifyDataElement({
        kind: fixtureCase.elementKind ?? 'family-history',
        path: fixtureCase.ingestPath ?? 'lab-interface',
        reliablyClassifiable: fixtureCase.reliable ?? true,
      });
      expect(outcome.tagged).toBe(fixtureCase.expectTagged ?? true);
      if (outcome.tagged) {
        if (fixtureCase.expectReviewStatus !== undefined) {
          expect(outcome.reviewStatus).toBe(fixtureCase.expectReviewStatus);
        }
        if (fixtureCase.expectBlocked !== undefined) {
          expect(outcome.blockedFromRelease).toBe(fixtureCase.expectBlocked);
        }
      }
      break;
    }
    case 'coverage-audit': {
      const outcome = auditGeneticCoverage(fixtureCase.coveredPaths ?? []);
      expect(outcome.complete).toBe(fixtureCase.expectComplete ?? false);
      if (fixtureCase.expectMissing !== undefined) {
        expect(outcome.missingPaths).toEqual(fixtureCase.expectMissing);
      }
      break;
    }
    case 'assemble-export': {
      const authorizations =
        fixtureCase.exportAuth === 'active'
          ? [activeGipaAuthorization]
          : fixtureCase.exportAuth === 'expired'
            ? [expiredGipaAuthorization]
            : [];
      const assembly = assembleRecordsExport({
        items: [
          { artifactRef: 'synthetic-doc:visit-note-1', partitionTags: [] },
          { artifactRef: 'synthetic-lab-result:lr-9001', partitionTags: ['gipa-genetic'] },
        ],
        subjectPersonId: adult,
        authorizations,
        sendDate: fixtureCase.sendDate ?? '2026-03-25',
      });
      if (fixtureCase.expectIncludedCount !== undefined) {
        expect(assembly.included).toHaveLength(fixtureCase.expectIncludedCount);
      }
      if (fixtureCase.expectExcludedGeneticCount !== undefined) {
        expect(assembly.excludedGenetic).toHaveLength(fixtureCase.expectExcludedGeneticCount);
      }
      if (fixtureCase.expectAuthorizationRef !== undefined) {
        expect(assembly.geneticIncludedUnder?.authorizationRef).toBe(
          fixtureCase.expectAuthorizationRef,
        );
      }
      expect(assembly.authorizationCheckedAt).toBe('send-time');
      expect(assembly.priorDisclosuresUnwound).toBe(false);
      break;
    }
    case 'employer-render': {
      const outcome = wrapped(() =>
        renderEmployerSurface(
          {
            tenantId: tenant,
            legalEntityId: 'northwind-health-nv' as never,
            metric: (fixtureCase.employerMetric ?? 'roster-headcount') as never,
          },
          {
            rosterHeadcount: 120,
            activeMembershipCount: 96,
            invoiceTotalCents: 4_800_000,
            tierBreakdown: { core: 60, plus: 36 },
          },
        ),
      );
      if (outcome !== undefined && fixtureCase.expectValue !== undefined) {
        expect(outcome).toBe(fixtureCase.expectValue);
      }
      break;
    }
    case 'break-glass-severity': {
      expect(breakGlassSeverityFor(fixtureCase.severityTags ?? [])).toBe(
        fixtureCase.expectSeverity ?? 'standard',
      );
      break;
    }
    case 'set-deceased': {
      const outcome = wrapped(() => {
        const flag = setDeceasedFlag({
          tenantId: tenant,
          flagId: 'nfl-fx-0001',
          personId: deceasedPerson,
          sourceRef: fixtureCase.omitSource === true ? '' : 'synthetic-death-report-0001',
          actorRef: 'synthetic-front-desk-001',
          occurredAt: '2026-03-18T09:30:00Z',
        });
        return flag;
      }) as ReturnType<typeof setDeceasedFlag> | undefined;
      if (outcome !== undefined) {
        if (fixtureCase.expectSuppressionChannels !== undefined) {
          expect(outcome.suppressionDirective.cancelQueuedAcrossChannels).toHaveLength(
            fixtureCase.expectSuppressionChannels,
          );
          expect(outcome.suppressionDirective.gracePeriodSends).toBe(0);
        }
        if (fixtureCase.expectVendorPropagation !== undefined) {
          expect(outcome.suppressionDirective.vendorSidePropagationRequired).toBe(
            fixtureCase.expectVendorPropagation,
          );
        }
        expect(outcome.lockDirective.readOnly).toBe(true);
      }
      break;
    }
    case 'correct-deceased': {
      const events: PersonFlagEvent[] =
        fixtureCase.withPriorSet === false
          ? []
          : [
              setDeceasedFlag({
                tenantId: tenant,
                flagId: 'nfl-fx-0001',
                personId: deceasedPerson,
                sourceRef: 'synthetic-death-report-0001',
                actorRef: 'synthetic-front-desk-001',
                occurredAt: '2026-03-18T09:30:00Z',
              }).event,
            ];
      const outcome = wrapped(() =>
        correctDeceasedFlag(events, {
          tenantId: tenant,
          flagId: 'nfl-fx-0002',
          personId: deceasedPerson,
          correctionEvidenceRef:
            fixtureCase.omitCorrectionEvidence === true ? '' : 'synthetic-correction-evidence-0001',
          actorRef: 'synthetic-compliance-officer-001',
          occurredAt: '2026-03-20T09:30:00Z',
        }),
      ) as ReturnType<typeof correctDeceasedFlag> | undefined;
      if (outcome !== undefined && fixtureCase.expectDeceasedState !== undefined) {
        const state = deceasedFlagState([...events, outcome.event], deceasedPerson);
        expect(state.deceased).toBe(fixtureCase.expectDeceasedState);
        expect(outcome.restoreDirective.interimSilenceWasServiceFailure).toBe(false);
      }
      break;
    }
    case 'unlock-estate': {
      wrapped(() =>
        unlockChartForEstate({
          unlockRef: 'neu-fx-0001',
          personId: deceasedPerson,
          actorRoleKeys: fixtureCase.unlockRoles ?? ['practice-manager'],
          documentedPurposeRef:
            fixtureCase.omitPurposeRef === true ? '' : 'synthetic-estate-purpose-0001',
        }),
      );
      break;
    }
    case 'establish-authority': {
      const outcome = wrapped(() =>
        establishProxyAuthority({
          record: authorityFrom(fixtureCase.authority),
          relationshipVerified: fixtureCase.relationshipVerified ?? true,
          ...(fixtureCase.omitVerifier === true ? {} : { verifiedBy: 'synthetic-front-desk-001' }),
          packs: jurisdictionPacksV1,
          providerState: fixtureCase.providerState ?? 'NV',
        }),
      ) as ReturnType<typeof establishProxyAuthority> | undefined;
      if (outcome !== undefined && fixtureCase.expectOutcome !== undefined) {
        expect(outcome.outcome, fixtureCase.name).toBe(fixtureCase.expectOutcome);
      }
      break;
    }
    case 'replace-guardian': {
      const outcome = wrapped(() =>
        replaceGuardianAuthority({
          current: authorityFrom(fixtureCase.authority),
          order: { ...defaultOrder, ...(fixtureCase.orderFlags ?? {}) },
          newGranteePersonId: otherAdult,
          newScope: [{ segment: 'scheduling', actions: ['view'] }],
          openItems: toOpenCareItems(fixtureCase.openItems),
          decidedBy: 'synthetic-compliance-officer-001',
          verifiedBy: 'synthetic-compliance-officer-001',
        }),
      ) as ReturnType<typeof replaceGuardianAuthority> | undefined;
      if (outcome === undefined) {
        break;
      }
      if (fixtureCase.expectOutcome !== undefined) {
        expect(outcome.outcome, fixtureCase.name).toBe(fixtureCase.expectOutcome);
      }
      if (outcome.outcome === 'blocked-open-items' && fixtureCase.expectUndispositioned) {
        expect(outcome.undispositioned).toEqual(fixtureCase.expectUndispositioned);
      }
      if (outcome.outcome === 'replaced') {
        if (fixtureCase.expectNextVersion !== undefined) {
          expect(outcome.next.version).toBe(fixtureCase.expectNextVersion);
        }
        if (fixtureCase.expectPriorStatus !== undefined) {
          expect(outcome.priorEnded.status).toBe(fixtureCase.expectPriorStatus);
        }
      }
      break;
    }
    case 'rollback-replacement': {
      const current = authorityFrom(fixtureCase.authority);
      const replaced = replaceGuardianAuthority({
        current,
        order: defaultOrder,
        newGranteePersonId: otherAdult,
        newScope: [{ segment: 'scheduling', actions: ['view'] }],
        openItems: [],
        decidedBy: 'synthetic-compliance-officer-001',
        verifiedBy: 'synthetic-compliance-officer-001',
      });
      if (replaced.outcome !== 'replaced') {
        throw new Error('fixture precondition: replacement expected');
      }
      const rolled = rollbackGuardianReplacement(
        replaced.next,
        current,
        'synthetic-correction-evidence-0001',
        'synthetic-compliance-officer-001',
      );
      expect(rolled.reinstated.granteePersonId).toBe(current.granteePersonId);
      expect(rolled.reinstated.version).toBe(replaced.next.version + 1);
      expect(rolled.mistakenRetained.status).toBe('superseded');
      break;
    }
    case 'custody-resolve': {
      const competing = authorityFrom({ authorityId: 'nar-fx-0002', granteePersonId: otherAdult });
      const hold = openCustodyConflict(
        'nch-fx-0001',
        [authorityFrom(fixtureCase.authority), competing],
        {
          evidenceRefs: ['synthetic-guardian-evidence-0001'],
          jurisdiction: 'NV',
          permittedActions: ['clinically-necessary-care'],
          affectedEncounterRefs: [],
          safeContactRef: null,
        },
        'synthetic-neutral-pathway-0001',
      );
      const outcome = wrapped(() =>
        resolveCustodyConflict(hold, authorityFrom(fixtureCase.authority), {
          basis: (fixtureCase.custodyBasis ?? 'court-order') as never,
          evidenceRef: 'synthetic-court-order-0002',
          approvedBy: 'synthetic-compliance-officer-001',
          updates: {
            scope: [{ segment: 'messaging', actions: ['view'] }],
            contactRefs: [],
            appointmentRefs: [],
            disclosureRuleRefs: [],
          },
        }),
      ) as ReturnType<typeof resolveCustodyConflict> | undefined;
      if (outcome !== undefined && fixtureCase.expectResolvedVersion !== undefined) {
        expect(outcome.resolved.version).toBe(fixtureCase.expectResolvedVersion);
      }
      break;
    }
    case 'renewal-window': {
      const directive = wrapped(() => openRenewalWindow(authorityFrom(fixtureCase.authority))) as
        ReturnType<typeof openRenewalWindow> | undefined;
      if (directive !== undefined) {
        expect(directive.accessExtended).toBe(false);
      }
      break;
    }
    case 'expire-authority': {
      const outcome = wrapped(() =>
        expireTemporaryAuthority(
          authorityFrom(fixtureCase.authority),
          toOpenCareItems(fixtureCase.openItems),
          fixtureCase.asOfDate ?? '2026-06-02',
        ),
      ) as ReturnType<typeof expireTemporaryAuthority> | undefined;
      if (outcome !== undefined) {
        expect(outcome.expired.status).toBe('expired');
        if (fixtureCase.expectQueueCount !== undefined) {
          expect(outcome.exceptionQueue).toHaveLength(fixtureCase.expectQueueCount);
        }
      }
      break;
    }
    case 'attempt-extension': {
      const basis = fixtureCase.extensionBasis ?? 'portal-activity';
      const attempt =
        basis === 'valid-renewal-evidence'
          ? {
              basis: 'valid-renewal-evidence' as const,
              evidenceRef: 'synthetic-renewal-evidence-0001',
              newEffectiveDate: '2026-06-02',
              newExpiresOn: '2026-12-01',
              approvedBy: 'synthetic-front-desk-001',
            }
          : { basis: basis as 'portal-activity' };
      const outcome = attemptAuthorityExtension(authorityFrom(fixtureCase.authority), attempt);
      if (fixtureCase.expectOutcome !== undefined) {
        expect(outcome.outcome).toBe(fixtureCase.expectOutcome);
      }
      break;
    }
    case 'emancipation-establish': {
      const outcome = establishEmancipation({
        record: authorityFrom({
          kind: 'emancipation',
          granteePersonId: minor,
          subjectPersonId: minor,
          status: 'pending-verification',
          ...(fixtureCase.authority ?? {}),
        }),
        statusResolved: fixtureCase.statusResolved ?? true,
        verifiedBy: 'synthetic-compliance-officer-001',
      });
      if (fixtureCase.expectOutcome !== undefined) {
        expect(outcome.outcome).toBe(fixtureCase.expectOutcome);
      }
      break;
    }
    case 'emancipation-deliver': {
      const established = establishEmancipation({
        record: authorityFrom({
          kind: 'emancipation',
          granteePersonId: minor,
          subjectPersonId: minor,
          status: 'pending-verification',
        }),
        statusResolved: true,
        verifiedBy: 'synthetic-compliance-officer-001',
      });
      if (established.outcome !== 'established') {
        throw new Error('fixture precondition: emancipation expected');
      }
      const outcome = deliverEmancipatedArtifact(
        established.record,
        {
          kind: fixtureCase.artifactKind ?? 'clinical',
          recipientPersonId: fixtureCase.recipient === 'guardian' ? adult : minor,
        },
        [guarantorRoleBase],
      );
      expect(outcome.recipientAuthorized).toBe(fixtureCase.expectAuthorized ?? true);
      break;
    }
    case 'emancipation-version': {
      const outcome = versionLegalStatusChange(
        authorityFrom({
          kind: 'emancipation',
          granteePersonId: minor,
          subjectPersonId: minor,
          ...(fixtureCase.authority ?? {}),
        }),
        {
          evidenceRef: 'synthetic-status-change-0001',
          decidedBy: 'synthetic-compliance-officer-001',
          ended: fixtureCase.ended ?? false,
        },
      );
      expect(outcome.next.version).toBe(2);
      expect(outcome.earlierActivityRetained).toBe(true);
      break;
    }
    case 'incapacity-activate': {
      const outcome = activateIncapacityAuthority({
        contingent: authorityFrom({
          kind: 'incapacity-contingent',
          subjectPersonId: otherAdult,
          expiresOn: '2026-09-01',
          status: 'pending-verification',
        }),
        ...(fixtureCase.withTrigger === false
          ? {}
          : { triggeringDeterminationRef: 'synthetic-determination-0001' }),
        ...(fixtureCase.conflictingEvidence === true ? { conflictingCapacityEvidence: true } : {}),
        verifiedBy: 'synthetic-compliance-officer-001',
        reviewerRef: 'synthetic-reviewer-0001',
        expiresOn: '2026-09-01',
      });
      if (fixtureCase.expectOutcome !== undefined) {
        expect(outcome.outcome).toBe(fixtureCase.expectOutcome);
      }
      break;
    }
    case 'incapacity-deactivate': {
      const activated = activateIncapacityAuthority({
        contingent: authorityFrom({
          kind: 'incapacity-contingent',
          subjectPersonId: otherAdult,
          expiresOn: '2026-09-01',
          status: 'pending-verification',
        }),
        triggeringDeterminationRef: 'synthetic-determination-0001',
        verifiedBy: 'synthetic-compliance-officer-001',
        reviewerRef: 'synthetic-reviewer-0001',
        expiresOn: '2026-09-01',
      });
      if (activated.outcome !== 'activated') {
        throw new Error('fixture precondition: activation expected');
      }
      const outcome = deactivateOnCapacityReturn(activated.record, 'synthetic-physician-0001');
      expect(outcome.ended.status).toBe('ended');
      expect(outcome.futureActionsReturnTo).toBe(otherAdult);
      break;
    }
    case 'majority-evaluate': {
      const records = (fixtureCase.records ?? [{}]).map((partial) => authorityFrom(partial));
      const outcome = evaluateMajorityTransition({
        subjectBirthDate:
          fixtureCase.birthDate === undefined ? '2011-06-02' : fixtureCase.birthDate,
        authorityRecords: records,
        guardianSignedConsentRefs: ['synthetic-consent-0002'],
        packs: jurisdictionPacksV1,
        providerState: 'NV',
        patientState: fixtureCase.patientState ?? 'NV',
        asOfDate: fixtureCase.asOfDate ?? '2029-06-02',
        adultConsentCompleted: fixtureCase.adultConsentCompleted ?? false,
      });
      if (fixtureCase.expectPhase !== undefined) {
        expect(outcome.phase, fixtureCase.name).toBe(fixtureCase.expectPhase);
      }
      if (fixtureCase.expectSuspendedIds !== undefined) {
        expect(outcome.suspendedRecords.map((record) => record.authorityId).sort()).toEqual(
          [...fixtureCase.expectSuspendedIds].sort(),
        );
      }
      if (fixtureCase.expectPreservedIds !== undefined) {
        expect(outcome.preservedRecords.map((record) => record.authorityId).sort()).toEqual(
          [...fixtureCase.expectPreservedIds].sort(),
        );
      }
      if (fixtureCase.expectReConsent !== undefined) {
        expect(outcome.reConsentFlags).toEqual(fixtureCase.expectReConsent);
      }
      if (fixtureCase.expectCarveoutContains !== undefined) {
        expect(outcome.confidentialCarveoutObligations).toContain(
          fixtureCase.expectCarveoutContains,
        );
      }
      if (fixtureCase.expectConfidentialDefault !== undefined) {
        expect(outcome.confidentialDefault).toBe(fixtureCase.expectConfidentialDefault);
      }
      if (fixtureCase.expectContactDirective === true) {
        expect(outcome.contactDirective?.flagInheritedContactsUnverified).toBe(true);
        expect(outcome.contactDirective?.severGuardianOwnedNumbers).toBe(true);
      }
      break;
    }
    case 'guarantor-change': {
      const reviewed = {
        effectiveScope: true,
        dates: true,
        patientAccounts: true,
        balances: true,
        priorNotices: true,
        portalPermissions: true,
        source: true,
        ...(fixtureCase.reviewedMissing !== undefined
          ? { [fixtureCase.reviewedMissing]: false }
          : {}),
      };
      const outcome = wrapped(() =>
        changeGuarantorAuthority({
          current: guarantorRoleBase,
          newRole: {
            ...guarantorRoleBase,
            guarantorRoleId: 'ngr-jordan-for-casey',
            guarantorPersonId: otherAdult,
          },
          evidenceRef: 'synthetic-responsibility-evidence-0001',
          reviewed,
          blockers: (fixtureCase.blockers ?? []) as never,
          guarantorBillingConsentRef:
            fixtureCase.omitBillingConsent === true ? '' : 'synthetic-billing-consent-0001',
          decidedBy: 'synthetic-front-desk-001',
        }),
      ) as ReturnType<typeof changeGuarantorAuthority> | undefined;
      if (outcome !== undefined && fixtureCase.expectOutcome !== undefined) {
        expect(outcome.outcome).toBe(fixtureCase.expectOutcome);
      }
      break;
    }
    case 'guarantor-release': {
      const outcome = releaseGuarantor({
        role: guarantorRoleBase,
        patientPersonId: minor,
        unpaidBalance: fixtureCase.unpaidBalance ?? false,
        ...(fixtureCase.withPaymentMethod === true
          ? { patientPaymentMethodRef: 'synthetic-payment-method-0001' }
          : {}),
      });
      if (fixtureCase.expectOutcome !== undefined) {
        expect(outcome.outcome).toBe(fixtureCase.expectOutcome);
      }
      if (outcome.outcome === 'released' && fixtureCase.expectTransfersTo === 'patient') {
        expect(outcome.billingTransfersTo).toBe(minor);
      }
      break;
    }
    case 'guarantor-dispute': {
      const outcome = disputeGuarantorDesignation(guarantorRoleBase, {
        disputedBy: minor,
        reviewRef: 'synthetic-designation-review-0001',
      });
      expect(outcome.review).toBe('guarantor-designation-review');
      break;
    }
    case 'reassign-balances': {
      const outcome = wrapped(() =>
        reassignHistoricalBalances({
          balanceRefs: ['synthetic-balance-0001'],
          approvedBy: fixtureCase.omitApprover === true ? '' : 'synthetic-counselor-0001',
          legalBasisRef: 'synthetic-legal-basis-0001',
        }),
      ) as ReturnType<typeof reassignHistoricalBalances> | undefined;
      if (outcome !== undefined && fixtureCase.expectRewrites !== undefined) {
        expect(outcome.lineage[0]?.rewritesPriorTransactions).toBe(fixtureCase.expectRewrites);
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
