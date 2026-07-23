/**
 * Periodic access-recertification workflow (WP-017, M02). Contract:
 * docs/contracts/elevation-api.md (FROZEN). Requirement: REQ-ADM-018 (periodic
 * access review WORKFLOW with manager attestation queues). Executes the
 * FWD-PDP-017-BREAKGLASS clause "scheduled access-recertification executes
 * runAccessReview findings".
 *
 * The EVALUATION substrate is WP-015 (`runAccessReview` + `attestGrant`,
 * REQ-ID-018). This module is the WORKFLOW around it: a scheduled cycle runs
 * the review, routes each staff member's findings into a manager attestation
 * queue (WP-022 WorkItem descriptors), and records the per-grant attestation
 * decisions as evidence. A `revoke` attestation carries the WP-015
 * access-change directive — a review that finds excess access acts, never just
 * notes.
 */

import type { TenantId } from '@practicehub/contracts';

import {
  assertId,
  assertInstant,
  assertRef,
  configChangeAuditInput,
  type AuthorityReviewWorkItem,
  type ElevationConfigAuditInput,
} from './elevation-shared.js';
import {
  attestGrant,
  runAccessReview,
  type AccessOverride,
  type ActualGrant,
  type ExternalRoleDefinition,
  type ReviewFinding,
  type RoleAssignment,
  type RoleTemplate,
} from './pdp.js';

export interface RecertificationCycleRequest {
  readonly tenantId: TenantId;
  readonly cycleId: string;
  readonly assignments: readonly RoleAssignment[];
  readonly templates: readonly RoleTemplate[];
  readonly overrides: readonly AccessOverride[];
  readonly actualGrants: readonly ActualGrant[];
  readonly externalRoleDefinitions?: readonly ExternalRoleDefinition[];
  /** Who owns each staff member's attestation queue (the manager pool ref). */
  readonly attestationPoolRef: string;
  readonly openedBy: string;
  readonly asOfDate: string;
  readonly occurredAt: string;
}

export interface RecertificationCycle {
  readonly tenantId: TenantId;
  readonly cycleId: string;
  readonly findings: readonly ReviewFinding[];
  readonly openedBy: string;
  readonly openedAt: string;
  readonly synthetic: true;
}

export interface RecertificationScheduleOutcome {
  readonly cycle: RecertificationCycle;
  /** One attestation WorkItem per staff member with findings (origin authority-review). */
  readonly attestationQueue: readonly AuthorityReviewWorkItem[];
  readonly auditInput: ElevationConfigAuditInput;
}

function staffAccountOf(finding: ReviewFinding): string | null {
  return 'staffAccountId' in finding ? finding.staffAccountId : null;
}

/**
 * Schedule a recertification cycle (REQ-ADM-018): run the WP-015 review and
 * route each staff member's findings into a manager attestation WorkItem. A
 * cycle with no findings produces an empty queue (a clean review is not a
 * failure — it simply queues nothing). Findings not scoped to a single staff
 * member (a role-definition mismatch) route to the pool as a reconciliation
 * item.
 */
export function scheduleAccessRecertification(
  request: RecertificationCycleRequest,
): RecertificationScheduleOutcome {
  assertId(request.cycleId, 'cycleId');
  assertRef(request.attestationPoolRef, 'attestationPoolRef');
  assertRef(request.openedBy, 'openedBy');
  assertInstant(request.occurredAt, 'occurredAt');

  const { findings } = runAccessReview({
    tenantId: request.tenantId,
    assignments: request.assignments,
    templates: request.templates,
    overrides: request.overrides,
    actualGrants: request.actualGrants,
    ...(request.externalRoleDefinitions !== undefined
      ? { externalRoleDefinitions: request.externalRoleDefinitions }
      : {}),
    asOfDate: request.asOfDate,
  });

  // Group findings by the staff member they concern (mismatch findings that
  // name no staff member route to a single reconciliation item for the pool).
  const byStaff = new Map<string, ReviewFinding[]>();
  const unscoped: ReviewFinding[] = [];
  for (const finding of findings) {
    const staffAccountId = staffAccountOf(finding);
    if (staffAccountId === null) {
      unscoped.push(finding);
      continue;
    }
    const list = byStaff.get(staffAccountId) ?? [];
    list.push(finding);
    byStaff.set(staffAccountId, list);
  }

  const attestationQueue: AuthorityReviewWorkItem[] = [...byStaff.keys()]
    .sort()
    .map((staffAccountId) => ({
      workItemId: `recert-${request.cycleId}-${staffAccountId}`,
      origin: 'authority-review' as const,
      subjectRef: `staff-account:${staffAccountId}`,
      purpose: 'access-recertification-attestation',
      risk: 'routine' as const,
      serviceTier: 'access-review',
      slaPolicyId: null,
      policyVersion: null,
      responseDueAt: null,
      poolId: request.attestationPoolRef,
      openedAt: request.occurredAt,
    }));
  if (unscoped.length > 0) {
    attestationQueue.push({
      workItemId: `recert-${request.cycleId}-reconciliation`,
      origin: 'authority-review',
      subjectRef: `recertification-cycle:${request.cycleId}`,
      purpose: 'access-recertification-reconciliation',
      risk: 'routine',
      serviceTier: 'access-review',
      slaPolicyId: null,
      policyVersion: null,
      responseDueAt: null,
      poolId: request.attestationPoolRef,
      openedAt: request.occurredAt,
    });
  }

  const cycle: RecertificationCycle = {
    tenantId: request.tenantId,
    cycleId: request.cycleId,
    findings,
    openedBy: request.openedBy,
    openedAt: request.occurredAt,
    synthetic: true,
  };
  const auditInput = configChangeAuditInput({
    auditId: `recert-open-${request.cycleId}`,
    tenantId: request.tenantId,
    action: 'access-recertification-cycle',
    actorRef: request.openedBy,
    occurredAt: request.occurredAt,
    configRef: `access-recertification:${request.cycleId}`,
  });
  return { cycle, attestationQueue, auditInput };
}

export const recertificationAttesterRoles = [
  'practice-manager',
  'compliance-privacy-officer',
  'it-security-admin',
] as const;
export type RecertificationAttesterRole = (typeof recertificationAttesterRoles)[number];

export type RecertificationDecision = 'confirmed' | 'revoked';

export interface RecertificationAttestationRequest {
  readonly tenantId: TenantId;
  readonly attestationId: string;
  readonly cycleId: string;
  readonly grant: ActualGrant;
  readonly attesterPersonId: string;
  readonly attesterRole: RecertificationAttesterRole;
  readonly decision: 'confirm' | 'revoke';
  readonly evidenceRef: string;
  readonly reason: string;
  readonly occurredAt: string;
}

export interface RecertificationAttestation {
  readonly tenantId: TenantId;
  readonly attestationId: string;
  readonly cycleId: string;
  readonly staffAccountId: string;
  readonly grantRef: string;
  readonly attesterPersonId: string;
  readonly attesterRole: RecertificationAttesterRole;
  readonly decision: RecertificationDecision;
  readonly evidenceRef: string;
  readonly attestedAt: string;
  readonly synthetic: true;
}

export interface RecertificationAttestationOutcome {
  readonly attestation: RecertificationAttestation;
  readonly auditInput: ElevationConfigAuditInput;
  /** Present iff the manager revoked the grant — the WP-015 access-change directive. */
  readonly accessChangeDirective: {
    readonly kind: 'revoke-access';
    readonly staffAccountId: string;
    readonly segment: string;
    readonly action: string;
  } | null;
}

/**
 * Record a manager's attestation over one grant (REQ-ADM-018 AC): the WP-015
 * `attestGrant` decides the outcome (a revoke carries the access-change
 * directive), and the attestation is persisted with attribution + evidence
 * (fail-closed). The attestation record is the recertification EVIDENCE.
 */
export function recordRecertificationAttestation(
  request: RecertificationAttestationRequest,
): RecertificationAttestationOutcome {
  assertId(request.attestationId, 'attestationId');
  assertRef(request.evidenceRef, 'evidenceRef');
  assertInstant(request.occurredAt, 'occurredAt');
  const outcome = attestGrant(
    request.grant,
    request.decision,
    request.attesterPersonId,
    request.reason,
  );
  const grantRef = `${request.grant.system}:${request.grant.segment}:${request.grant.action}`;
  const attestation: RecertificationAttestation = {
    tenantId: request.tenantId,
    attestationId: request.attestationId,
    cycleId: request.cycleId,
    staffAccountId: request.grant.staffAccountId,
    grantRef,
    attesterPersonId: request.attesterPersonId,
    attesterRole: request.attesterRole,
    decision: outcome.attested,
    evidenceRef: request.evidenceRef,
    attestedAt: request.occurredAt,
    synthetic: true,
  };
  const auditInput = configChangeAuditInput({
    auditId: `recert-attest-${request.attestationId}`,
    tenantId: request.tenantId,
    action: 'access-recertification-attestation',
    actorRef: `person:${request.attesterPersonId}`,
    occurredAt: request.occurredAt,
    configRef: `recertification-attestation:${request.attestationId}`,
    subjectRef: `staff-account:${request.grant.staffAccountId}`,
  });
  return {
    attestation,
    auditInput,
    accessChangeDirective: outcome.attested === 'revoked' ? outcome.accessChangeDirective : null,
  };
}

/** Re-export for callers assembling the review input from a cycle. */
export type { ReviewFinding } from './pdp.js';
