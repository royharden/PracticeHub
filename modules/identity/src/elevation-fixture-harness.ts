/**
 * Shared executable harness for the WP-017 fixture packs (break-glass +
 * offboarding + credential-anomaly + access recertification). Every case runs
 * against the REAL domain functions — a fixture that merely "exists" without
 * encoding its acceptance criterion cannot pass. Review-009 discipline: the
 * accepted-op list is validated at LOAD, the dispatcher ends in a throwing
 * default, and every case that produces an audit input re-emits it through the
 * REAL WP-020 store. Test-only module (imported by the fixture suite).
 */
import { emitAuditEvent, emptyChainState, type AuditEmitInput } from '@practicehub/audit-evidence';
import { expect } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import type { DataSegment } from './access-vocabulary.js';
import {
  breakGlassStatus,
  completeBreakGlassReview,
  grantBreakGlass,
  type BreakGlassReviewOutcomeResult,
  type BreakGlassReviewerRole,
} from './break-glass.js';
import {
  detectSessionAnomalies,
  detectSnooping,
  openAccessAnomalyInvestigation,
  remediateAnomaly,
  type AnomalyDisposition,
  type AnomalyPattern,
} from './credential-anomaly.js';
import { executeOffboarding, type OffboardingKind, type OwnedWorkKind } from './offboarding.js';
import {
  recordRecertificationAttestation,
  scheduleAccessRecertification,
} from './access-recertification.js';
import { canonicalRoleTemplateSeedsV1, type RoleAssignment, type RoleTemplate } from './pdp.js';

export const tenant = 'northwind-synthetic' as TenantId;
export const accessor = 'np-morgan-lee' as PersonId;
export const subject = 'np-alex-rivera' as PersonId;
export const reviewer = 'np-jordan-kim' as PersonId;

export const acceptedOps = [
  'grant-break-glass',
  'break-glass-status',
  'break-glass-review',
  'offboard',
  'detect-session-anomaly',
  'detect-snooping',
  'open-anomaly',
  'remediate-anomaly',
  'schedule-recert',
  'attest-recert',
] as const;
export type FixtureOp = (typeof acceptedOps)[number];

const templates: readonly RoleTemplate[] = canonicalRoleTemplateSeedsV1.map((seed) => ({
  ...seed,
  tenantId: tenant,
}));

const frontDeskAssignment: RoleAssignment = {
  tenantId: tenant,
  assignmentId: 'nra-morgan-front-desk',
  staffAccountId: 'nsa-morgan-lee',
  staffPersonId: 'np-morgan-lee' as PersonId,
  roleKey: 'front-desk',
  templateVersion: 1,
  locationScope: [],
  effectiveDate: '2026-01-01',
  status: 'active',
  assignedBy: 'synthetic-it-admin-001',
  synthetic: true,
};

export interface FixtureCase {
  readonly name: string;
  readonly op: FixtureOp;
  readonly expectError?: string;
  // grant-break-glass / break-glass-status
  readonly scope?: readonly DataSegment[];
  readonly reasonCode?: string;
  readonly partitionTags?: readonly ('gipa-genetic' | 'chd' | 'biometric' | 'part2')[];
  readonly windowMinutes?: number;
  readonly reviewWindowMinutes?: number;
  readonly omitJustification?: boolean;
  readonly nowIso?: string;
  readonly expectSeverity?: string;
  readonly expectStatus?: string;
  readonly expectExpiresAt?: string;
  // break-glass-review
  readonly reviewerIsAccessor?: boolean;
  readonly reviewOutcome?: 'access-appropriate' | 'access-inappropriate-escalate';
  readonly reviewerRole?: BreakGlassReviewerRole;
  readonly omitReviewEvidence?: boolean;
  readonly expectEscalation?: boolean;
  // offboard
  readonly kind?: OffboardingKind;
  readonly hasEpcsToken?: boolean;
  readonly ownedWork?: readonly { readonly ownedRef: string; readonly ownedKind: OwnedWorkKind }[];
  readonly targets?: readonly {
    readonly ownedRef: string;
    readonly toOwnerRef: string;
    readonly contextPackageRef: string;
  }[];
  readonly dropOneTarget?: boolean;
  readonly emptyContextOnFirst?: boolean;
  readonly expectReassignments?: number;
  readonly expectRevokedScopesContains?: readonly string[];
  // detect-session-anomaly
  readonly sightings?: readonly {
    readonly deviceId: string;
    readonly locationRef: string;
    readonly observedAt: string;
  }[];
  readonly expectSignalKinds?: readonly string[];
  // detect-snooping
  readonly accesses?: readonly {
    readonly accessRef: string;
    readonly hadTreatmentRelationship: boolean;
    readonly withinAssignment: boolean;
  }[];
  readonly expectFlagged?: readonly string[];
  // open-anomaly / remediate-anomaly
  readonly pattern?: AnomalyPattern;
  readonly signals?: readonly {
    readonly signalRef: string;
    readonly detail: string;
    readonly observedAt: string;
  }[];
  readonly containmentRef?: string;
  readonly disposition?: AnomalyDisposition;
  readonly omitRemediationEvidence?: boolean;
  // schedule-recert / attest-recert
  readonly withDrift?: boolean;
  readonly expectQueueForStaff?: boolean;
  readonly expectFindingKinds?: readonly string[];
  readonly decision?: 'confirm' | 'revoke';
  readonly omitAttestationEvidence?: boolean;
  readonly expectDirective?: boolean;
}

export interface ElevationFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly cases: readonly FixtureCase[];
}

function emit(input: unknown): void {
  const emitted = emitAuditEvent(emptyChainState, input as AuditEmitInput);
  expect(emitted.record.synthetic).toBe(true);
}

function runGrantBreakGlass(fixtureCase: FixtureCase): void {
  const outcome = grantBreakGlass({
    tenantId: tenant,
    grantId: 'bg-fx-0001',
    staffAccountId: 'nsa-morgan-lee',
    accessorPersonId: accessor,
    subjectPersonId: subject,
    scope: fixtureCase.scope ?? ['clinical-notes'],
    reasonCode: (fixtureCase.reasonCode ?? 'emergency-care') as never,
    justificationRef:
      fixtureCase.omitJustification === true ? '' : 'synthetic-break-glass-reason-fx',
    ...(fixtureCase.partitionTags !== undefined
      ? { partitionTags: fixtureCase.partitionTags }
      : {}),
    initiatedBy: 'synthetic-it-admin-001',
    effectiveAt: '2026-03-25T10:00:00Z',
    windowMinutes: fixtureCase.windowMinutes ?? 60,
    reviewWindowMinutes: fixtureCase.reviewWindowMinutes ?? 1440,
  });
  emit(outcome.auditInput);
  expect(outcome.obligations).toEqual(['independent-review-required']);
  if (fixtureCase.expectSeverity !== undefined) {
    expect(outcome.grant.severity).toBe(fixtureCase.expectSeverity);
  }
  if (fixtureCase.expectExpiresAt !== undefined) {
    expect(outcome.grant.expiresAt).toBe(fixtureCase.expectExpiresAt);
  }
}

function runBreakGlassStatus(fixtureCase: FixtureCase): void {
  const { grant } = grantBreakGlass({
    tenantId: tenant,
    grantId: 'bg-fx-status',
    staffAccountId: 'nsa-morgan-lee',
    accessorPersonId: accessor,
    subjectPersonId: subject,
    scope: fixtureCase.scope ?? ['clinical-notes'],
    reasonCode: 'emergency-care',
    justificationRef: 'synthetic-break-glass-reason-fx',
    initiatedBy: 'synthetic-it-admin-001',
    effectiveAt: '2026-03-25T10:00:00Z',
    windowMinutes: fixtureCase.windowMinutes ?? 60,
    reviewWindowMinutes: 1440,
  });
  expect(breakGlassStatus(grant, fixtureCase.nowIso ?? '2026-03-25T10:30:00Z')).toBe(
    fixtureCase.expectStatus ?? 'active',
  );
}

function runBreakGlassReview(fixtureCase: FixtureCase): void {
  const { grant } = grantBreakGlass({
    tenantId: tenant,
    grantId: 'bg-fx-review',
    staffAccountId: 'nsa-morgan-lee',
    accessorPersonId: accessor,
    subjectPersonId: subject,
    scope: ['clinical-notes'],
    reasonCode: 'emergency-care',
    justificationRef: 'synthetic-break-glass-reason-fx',
    initiatedBy: 'synthetic-it-admin-001',
    effectiveAt: '2026-03-25T10:00:00Z',
    windowMinutes: 60,
    reviewWindowMinutes: 1440,
  });
  const outcome: BreakGlassReviewOutcomeResult = completeBreakGlassReview(grant, {
    reviewId: 'bgr-fx-0001',
    reviewerPersonId: fixtureCase.reviewerIsAccessor === true ? accessor : reviewer,
    reviewerRole: fixtureCase.reviewerRole ?? 'compliance-privacy-officer',
    outcome: fixtureCase.reviewOutcome ?? 'access-appropriate',
    evidenceRef: fixtureCase.omitReviewEvidence === true ? '' : 'synthetic-review-evidence-fx',
    occurredAt: '2026-03-26T09:00:00Z',
  });
  emit(outcome.auditInput);
  if (fixtureCase.expectEscalation !== undefined) {
    expect(outcome.escalation !== null).toBe(fixtureCase.expectEscalation);
  }
}

function runOffboard(fixtureCase: FixtureCase): void {
  const ownedWork = fixtureCase.ownedWork ?? [{ ownedRef: 'thread:th-fx', ownedKind: 'thread' }];
  const baseTargets =
    fixtureCase.targets ??
    ownedWork.map((item, index) => ({
      ownedRef: item.ownedRef,
      toOwnerRef: 'staff-account:nsa-jordan-kim',
      contextPackageRef: `synthetic-context-package-fx-${index}`,
    }));
  const targets = baseTargets
    .filter((_, index) => !(fixtureCase.dropOneTarget === true && index === baseTargets.length - 1))
    .map((target, index) =>
      fixtureCase.emptyContextOnFirst === true && index === 0
        ? { ...target, contextPackageRef: '' }
        : target,
    );
  const result = executeOffboarding({
    tenantId: tenant,
    offboardingId: 'off-fx-0001',
    staffAccountId: 'nsa-morgan-lee',
    staffPersonId: accessor,
    kind: fixtureCase.kind ?? 'planned',
    reasonRef: 'synthetic-offboarding-reason-fx',
    executedBy: 'synthetic-it-admin-001',
    occurredAt: '2026-03-25T17:00:00Z',
    hasEpcsToken: fixtureCase.hasEpcsToken ?? false,
    activeSessions: [],
    ownedWork,
    reassignmentTargets: targets,
  });
  emit(result.auditInput);
  if (fixtureCase.expectReassignments !== undefined) {
    expect(result.reassignments).toHaveLength(fixtureCase.expectReassignments);
  }
  for (const scope of fixtureCase.expectRevokedScopesContains ?? []) {
    expect(result.case.revokedScopes).toContain(scope);
  }
}

function runDetectSessionAnomaly(fixtureCase: FixtureCase): void {
  const signals = detectSessionAnomalies(
    (fixtureCase.sightings ?? []).map((sighting, index) => ({
      sessionId: `nse-fx-${index}`,
      deviceId: sighting.deviceId,
      locationRef: sighting.locationRef,
      observedAt: sighting.observedAt,
    })),
  );
  for (const kind of fixtureCase.expectSignalKinds ?? []) {
    expect(signals.map((signal) => signal.kind)).toContain(kind);
  }
  if ((fixtureCase.expectSignalKinds ?? []).length === 0) {
    expect(signals).toHaveLength(0);
  }
}

function runDetectSnooping(fixtureCase: FixtureCase): void {
  const findings = detectSnooping(
    (fixtureCase.accesses ?? []).map((access) => ({
      accessRef: access.accessRef,
      subjectPersonId: subject,
      segment: 'clinical-notes',
      hadTreatmentRelationship: access.hadTreatmentRelationship,
      withinAssignment: access.withinAssignment,
      observedAt: '2026-03-25T10:00:00Z',
    })),
  );
  expect(findings.map((finding) => finding.accessRef)).toEqual(fixtureCase.expectFlagged ?? []);
}

function runOpenAnomaly(fixtureCase: FixtureCase): void {
  const outcome = openAccessAnomalyInvestigation({
    tenantId: tenant,
    anomalyId: 'anom-fx-0001',
    pattern: fixtureCase.pattern ?? 'snooping-access',
    subjectStaffPersonId: accessor,
    signals: fixtureCase.signals ?? [
      {
        signalRef: 'sig-fx-1',
        detail: 'access:access-2:clinical-notes',
        observedAt: '2026-03-25T10:00:00Z',
      },
    ],
    detectedAt: '2026-03-25T11:00:00Z',
    openedBy: 'synthetic-it-admin-001',
    ...(fixtureCase.containmentRef !== undefined
      ? { containmentRef: fixtureCase.containmentRef }
      : {}),
  });
  emit(outcome.auditInput);
  if (fixtureCase.expectStatus !== undefined) {
    expect(outcome.case.status).toBe(fixtureCase.expectStatus);
  }
}

function runRemediateAnomaly(fixtureCase: FixtureCase): void {
  const opened = openAccessAnomalyInvestigation({
    tenantId: tenant,
    anomalyId: 'anom-fx-remediate',
    pattern: 'snooping-access',
    subjectStaffPersonId: accessor,
    signals: [
      {
        signalRef: 'sig-fx-1',
        detail: 'access:access-2:clinical-notes',
        observedAt: '2026-03-25T10:00:00Z',
      },
    ],
    detectedAt: '2026-03-25T11:00:00Z',
    openedBy: 'synthetic-it-admin-001',
  });
  const outcome = remediateAnomaly(opened.case, {
    disposition: fixtureCase.disposition ?? 'confirmed-violation',
    remediationEvidenceRef:
      fixtureCase.omitRemediationEvidence === true ? '' : 'synthetic-remediation-evidence-fx',
    resolvedBy: 'synthetic-compliance-officer-001',
    occurredAt: '2026-03-26T09:00:00Z',
  });
  emit(outcome.auditInput);
  if (fixtureCase.expectStatus !== undefined) {
    expect(outcome.case.status).toBe(fixtureCase.expectStatus);
  }
}

function runScheduleRecert(fixtureCase: FixtureCase): void {
  const actualGrants =
    fixtureCase.withDrift === false
      ? [
          {
            staffAccountId: 'nsa-morgan-lee',
            system: 'practicehub',
            segment: 'scheduling',
            action: 'view',
          },
        ]
      : [
          {
            staffAccountId: 'nsa-morgan-lee',
            system: 'practicehub',
            segment: 'medications',
            action: 'edit',
          },
        ];
  const outcome = scheduleAccessRecertification({
    tenantId: tenant,
    cycleId: 'recert-fx-0001',
    assignments: [frontDeskAssignment],
    templates,
    overrides: [],
    actualGrants,
    attestationPoolRef: 'practice-manager-pool',
    openedBy: 'synthetic-it-admin-001',
    asOfDate: '2026-03-25',
    occurredAt: '2026-03-25T12:00:00Z',
  });
  emit(outcome.auditInput);
  for (const kind of fixtureCase.expectFindingKinds ?? []) {
    expect(outcome.cycle.findings.map((finding) => finding.kind)).toContain(kind);
  }
  if (fixtureCase.expectQueueForStaff !== undefined) {
    expect(
      outcome.attestationQueue.some((item) => item.subjectRef === 'staff-account:nsa-morgan-lee'),
    ).toBe(fixtureCase.expectQueueForStaff);
  }
}

function runAttestRecert(fixtureCase: FixtureCase): void {
  const outcome = recordRecertificationAttestation({
    tenantId: tenant,
    attestationId: 'recert-att-fx-0001',
    cycleId: 'recert-fx-0001',
    grant: {
      staffAccountId: 'nsa-morgan-lee',
      system: 'practicehub',
      segment: 'medications',
      action: 'edit',
    },
    attesterPersonId: 'np-taylor-manager',
    attesterRole: 'practice-manager',
    decision: fixtureCase.decision ?? 'revoke',
    evidenceRef:
      fixtureCase.omitAttestationEvidence === true ? '' : 'synthetic-attestation-evidence-fx',
    reason: 'synthetic recertification attestation',
    occurredAt: '2026-03-26T09:00:00Z',
  });
  emit(outcome.auditInput);
  if (fixtureCase.expectDirective !== undefined) {
    expect(outcome.accessChangeDirective !== null).toBe(fixtureCase.expectDirective);
  }
}

export function runFixtureCase(fixtureCase: FixtureCase): void {
  const invoke = (): void => {
    switch (fixtureCase.op) {
      case 'grant-break-glass':
        return runGrantBreakGlass(fixtureCase);
      case 'break-glass-status':
        return runBreakGlassStatus(fixtureCase);
      case 'break-glass-review':
        return runBreakGlassReview(fixtureCase);
      case 'offboard':
        return runOffboard(fixtureCase);
      case 'detect-session-anomaly':
        return runDetectSessionAnomaly(fixtureCase);
      case 'detect-snooping':
        return runDetectSnooping(fixtureCase);
      case 'open-anomaly':
        return runOpenAnomaly(fixtureCase);
      case 'remediate-anomaly':
        return runRemediateAnomaly(fixtureCase);
      case 'schedule-recert':
        return runScheduleRecert(fixtureCase);
      case 'attest-recert':
        return runAttestRecert(fixtureCase);
      default: {
        throw new Error(
          `unrecognized fixture op ${JSON.stringify((fixtureCase as { op: string }).op)} — ` +
            'the dispatcher refuses unknown cases (review-009)',
        );
      }
    }
  };
  if (fixtureCase.expectError !== undefined) {
    expect(invoke).toThrow(fixtureCase.expectError);
    return;
  }
  invoke();
}
