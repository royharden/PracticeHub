/**
 * Policy Decision Point (WP-015). Contract: docs/contracts/pdp-api.md
 * (FROZEN); architecture ADR-006 Decisions 2 and 4.
 *
 * ONE decision point: RBAC grants the base permit (versioned role templates,
 * REQ-ID-018 / R6-REQ-002 deny-by-default), ABAC guards only ever DENY or
 * attach obligations (purpose-of-use, partition tags, patient-relationship,
 * jurisdiction, consent, deceased lock, step-up). Every decision — allow AND
 * deny — is born with its `access`-stream audit input (FWD-AUD-015-PDP):
 * there is no code path that produces a decision without one, and the
 * deny-audit completeness test sweeps the full grid through the real
 * emitter. Permission caches key on invalidation epochs composing WP-016
 * merge/unmerge events with PDP authority events (FWD-MERGE-015-CACHE +
 * REQ-ID-018 AC-5: no stale permission survives).
 */

import { jurisdictionPacksV1 } from '@practicehub/platform-core';

import type { JurisdictionRulePack } from '@practicehub/platform-core';
import type { LegalEntityId, LocationId, PatientRecordId, PersonId } from '@practicehub/contracts';

import {
  PdpInvariantError,
  accessPartitionTags,
  assertDataSegment,
  assertPdpAction,
  assertPurposeOfUse,
  canonicalRoleKeys,
  type AccessPartitionTag,
  type CanonicalRoleKey,
  type DataSegment,
  type PdpAction,
  type PurposeOfUse,
} from './access-vocabulary.js';
import { chartUnlockRoles, lockedSegmentsOnDeceased, type EstateUnlock } from './chart-lock.js';
import { findValidGipaAuthorization, type GipaAuthorization } from './gipa.js';
import { assertIdentityId, type GuarantorRole } from './identity.js';
import {
  readThroughCache,
  invalidationEpochs,
  type CachedIdentityAssertion,
  type CacheReadResult,
  type MergeEvent,
} from './merge.js';
import {
  recordsConsentResolution,
  recordsConsentSegments,
  type AuthorityRecord,
} from './proxy-authority.js';

/* ------------------------------------------------------------------ *
 * Role templates, assignments, overrides (REQ-ID-018)                 *
 * ------------------------------------------------------------------ */

export interface RolePermit {
  readonly segment: DataSegment;
  readonly actions: readonly PdpAction[];
}

export interface RoleTemplate {
  readonly tenantId: string;
  readonly roleKey: CanonicalRoleKey;
  readonly version: number;
  /** The MINIMUM segment × action set the role requires — may be empty. */
  readonly permits: readonly RolePermit[];
  readonly status: 'active' | 'superseded';
  readonly changedBy: string;
  readonly changeReason: string;
  readonly synthetic: boolean;
}

export interface RoleAssignment {
  readonly tenantId: string;
  readonly assignmentId: string;
  readonly staffAccountId: string;
  readonly staffPersonId: PersonId;
  readonly roleKey: CanonicalRoleKey;
  readonly templateVersion: number;
  /** Empty = every location of the assigned entity. */
  readonly locationScope: readonly LocationId[];
  readonly effectiveDate: string;
  readonly status: 'active' | 'ended';
  readonly endedReason?: string;
  readonly endedBy?: string;
  readonly assignedBy: string;
  readonly synthetic: boolean;
}

export interface AccessOverride {
  readonly tenantId: string;
  readonly overrideId: string;
  readonly staffAccountId: string;
  readonly segment: DataSegment;
  readonly actions: readonly PdpAction[];
  readonly justification: string;
  readonly approvedBy: string;
  /** Time-boxed by construction — never a permanent widen. */
  readonly expiresOn: string;
  readonly flaggedForReview: true;
  readonly status: 'active' | 'revoked' | 'expired';
  readonly synthetic: boolean;
}

export function assertRoleTemplateWellFormed(template: RoleTemplate): void {
  assertIdentityId(template.tenantId, 'tenantId');
  if (!(canonicalRoleKeys as readonly string[]).includes(template.roleKey)) {
    throw new PdpInvariantError(`unknown role key ${JSON.stringify(template.roleKey)}`);
  }
  if (!Number.isInteger(template.version) || template.version < 1) {
    throw new PdpInvariantError(`template ${template.roleKey} version must be a positive int`);
  }
  for (const permit of template.permits) {
    assertDataSegment(permit.segment, `template ${template.roleKey} permit segment`);
    if (permit.actions.length === 0) {
      throw new PdpInvariantError(`template ${template.roleKey} permit needs actions`);
    }
    for (const action of permit.actions) {
      assertPdpAction(action, `template ${template.roleKey} permit action`);
    }
  }
  if (!template.changedBy || !template.changeReason) {
    throw new PdpInvariantError(
      `template ${template.roleKey} changes are versioned AND attributed (REQ-ID-018 AC-3)`,
    );
  }
}

/**
 * Assign a role template (REQ-ID-018 AC-7 + EX-4): the template reference IS
 * the permit set — there is no per-segment input through which an admin can
 * accidentally grant outside it — and every prior active assignment for the
 * staff account ends IN THE SAME ACT, never left active "just in case".
 */
export function assignRole(
  existing: readonly RoleAssignment[],
  next: RoleAssignment,
): { readonly ended: readonly RoleAssignment[]; readonly active: RoleAssignment } {
  assertIdentityId(next.tenantId, 'tenantId');
  assertIdentityId(next.assignmentId, 'assignmentId');
  if (next.status !== 'active') {
    throw new PdpInvariantError('assignRole activates the new assignment');
  }
  const ended = existing
    .filter(
      (assignment) =>
        assignment.staffAccountId === next.staffAccountId && assignment.status === 'active',
    )
    .map((assignment) => ({
      ...assignment,
      status: 'ended' as const,
      endedReason: 'superseded-by-new-assignment',
      endedBy: next.assignedBy,
    }));
  return { ended, active: next };
}

export function endRoleAssignment(
  assignment: RoleAssignment,
  endedBy: string,
  endedReason: string,
): RoleAssignment {
  if (!endedBy || !endedReason) {
    throw new PdpInvariantError('ending an assignment is attributed with a reason');
  }
  return { ...assignment, status: 'ended', endedBy, endedReason };
}

/**
 * Grant a beyond-template override (REQ-ID-018 AC-8 + EX-2): documented
 * justification, named approver, HARD expiry, always flagged for compliance
 * review — and NEVER the genetic segment (REQ-ID-019 AC-5/EX-3: genetic
 * inherits stricter permissions; only clinical role templates grant it).
 */
export function grantAccessOverride(request: {
  readonly tenantId: string;
  readonly overrideId: string;
  readonly staffAccountId: string;
  readonly segment: DataSegment;
  readonly actions: readonly PdpAction[];
  readonly justification: string;
  readonly approvedBy: string;
  readonly expiresOn: string;
}): AccessOverride {
  if (!request.justification) {
    throw new PdpInvariantError('an override requires a documented justification');
  }
  if (!request.approvedBy) {
    throw new PdpInvariantError('an override requires a named approver');
  }
  if (!request.expiresOn) {
    throw new PdpInvariantError('an override is time-boxed by construction — expiry required');
  }
  if (request.segment === 'genetic') {
    throw new PdpInvariantError(
      'an access override can never grant the genetic segment — there is no ' +
        'override escape hatch for the GIPA partition (REQ-ID-019)',
    );
  }
  return {
    tenantId: request.tenantId,
    overrideId: request.overrideId,
    staffAccountId: request.staffAccountId,
    segment: request.segment,
    actions: request.actions,
    justification: request.justification,
    approvedBy: request.approvedBy,
    expiresOn: request.expiresOn,
    flaggedForReview: true,
    status: 'active',
    synthetic: true,
  };
}

/* ------------------------------------------------------------------ *
 * Access review evaluation (REQ-ID-018 AC-2/AC-4/AC-9, EX-1/EX-3)     *
 * ------------------------------------------------------------------ */

export interface ActualGrant {
  readonly staffAccountId: string;
  readonly system: string;
  readonly segment: string;
  readonly action: string;
}

export interface ExternalRoleDefinition {
  readonly system: string;
  readonly roleKey: CanonicalRoleKey;
  readonly permits: readonly RolePermit[];
}

export type ReviewFinding =
  | {
      readonly kind: 'drift-remediation-required';
      readonly staffAccountId: string;
      readonly grant: ActualGrant;
      readonly disposition: 'required-remediation';
    }
  | {
      readonly kind: 'combined-footprint';
      readonly staffAccountId: string;
      readonly systems: readonly string[];
      readonly grants: readonly ActualGrant[];
    }
  | {
      readonly kind: 'role-definition-mismatch-reconciliation';
      readonly roleKey: CanonicalRoleKey;
      readonly system: string;
    }
  | {
      readonly kind: 'template-reevaluation';
      readonly staffAccountId: string;
      readonly assignmentId: string;
      readonly pinnedVersion: number;
      readonly currentVersion: number;
    };

function currentActiveTemplate(
  templates: readonly RoleTemplate[],
  tenantId: string,
  roleKey: CanonicalRoleKey,
): RoleTemplate | undefined {
  return templates
    .filter(
      (template) =>
        template.tenantId === tenantId &&
        template.roleKey === roleKey &&
        template.status === 'active',
    )
    .sort((a, b) => b.version - a.version)[0];
}

function permitCovers(permits: readonly RolePermit[], segment: string, action: string): boolean {
  return permits.some(
    (permit) =>
      permit.segment === segment && (permit.actions as readonly string[]).includes(action),
  );
}

/**
 * The recurring least-privilege review EVALUATION (REQ-ID-018 AC-2): actual
 * permissions compared against the CURRENT role definition; drift is a
 * required remediation, never an accepted deviation (EX-1); the footprint is
 * the user's COMBINED cross-system access (AC-4); a differing external role
 * definition is a reconciliation finding, never an assumed-equivalent pass
 * (EX-3). Attestation queues and cadence are WP-017/WP-022 workflow.
 */
export function runAccessReview(input: {
  readonly tenantId: string;
  readonly assignments: readonly RoleAssignment[];
  readonly templates: readonly RoleTemplate[];
  readonly overrides: readonly AccessOverride[];
  readonly actualGrants: readonly ActualGrant[];
  readonly externalRoleDefinitions?: readonly ExternalRoleDefinition[];
  readonly asOfDate: string;
}): { readonly findings: readonly ReviewFinding[] } {
  const findings: ReviewFinding[] = [];
  const staffIds = [...new Set(input.actualGrants.map((grant) => grant.staffAccountId))];
  for (const staffAccountId of staffIds) {
    const grants = input.actualGrants.filter((grant) => grant.staffAccountId === staffAccountId);
    const active = input.assignments.filter(
      (assignment) =>
        assignment.staffAccountId === staffAccountId && assignment.status === 'active',
    );
    const expected: RolePermit[] = [];
    for (const assignment of active) {
      const template = currentActiveTemplate(input.templates, input.tenantId, assignment.roleKey);
      if (template === undefined) {
        continue;
      }
      expected.push(...template.permits);
      if (assignment.templateVersion !== template.version) {
        findings.push({
          kind: 'template-reevaluation',
          staffAccountId,
          assignmentId: assignment.assignmentId,
          pinnedVersion: assignment.templateVersion,
          currentVersion: template.version,
        });
      }
    }
    const liveOverrides = input.overrides.filter(
      (override) =>
        override.staffAccountId === staffAccountId &&
        override.status === 'active' &&
        input.asOfDate < override.expiresOn,
    );
    for (const grant of grants.filter((entry) => entry.system === 'practicehub')) {
      const covered =
        permitCovers(expected, grant.segment, grant.action) ||
        liveOverrides.some(
          (override) =>
            override.segment === grant.segment &&
            (override.actions as readonly string[]).includes(grant.action),
        );
      if (!covered) {
        findings.push({
          kind: 'drift-remediation-required',
          staffAccountId,
          grant,
          disposition: 'required-remediation',
        });
      }
    }
    const systems = [...new Set(grants.map((grant) => grant.system))];
    if (systems.length > 1) {
      findings.push({ kind: 'combined-footprint', staffAccountId, systems, grants });
    }
  }
  for (const external of input.externalRoleDefinitions ?? []) {
    const platform = currentActiveTemplate(input.templates, input.tenantId, external.roleKey);
    if (platform === undefined) {
      continue;
    }
    const sameShape =
      external.permits.length === platform.permits.length &&
      external.permits.every((permit) =>
        permit.actions.every((action) => permitCovers(platform.permits, permit.segment, action)),
      );
    if (!sameShape) {
      findings.push({
        kind: 'role-definition-mismatch-reconciliation',
        roleKey: external.roleKey,
        system: external.system,
      });
    }
  }
  return { findings };
}

export type AttestationOutcome =
  | { readonly attested: 'confirmed'; readonly by: string; readonly reason: string }
  | {
      readonly attested: 'revoked';
      readonly by: string;
      readonly reason: string;
      /** Revocation triggers an ACTUAL access change, not a record update. */
      readonly accessChangeDirective: {
        readonly kind: 'revoke-access';
        readonly staffAccountId: string;
        readonly segment: string;
        readonly action: string;
      };
    };

export function attestGrant(
  grant: ActualGrant,
  decision: 'confirm' | 'revoke',
  by: string,
  reason: string,
): AttestationOutcome {
  if (!by || !reason) {
    throw new PdpInvariantError('attestation is logged with who and why');
  }
  if (decision === 'confirm') {
    return { attested: 'confirmed', by, reason };
  }
  return {
    attested: 'revoked',
    by,
    reason,
    accessChangeDirective: {
      kind: 'revoke-access',
      staffAccountId: grant.staffAccountId,
      segment: grant.segment,
      action: grant.action,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Separation of duties (ADR-006 Decision 4)                           *
 * ------------------------------------------------------------------ */

export interface SodPair {
  readonly sodId: string;
  readonly firstDuty: string;
  readonly secondDuty: string;
}

export interface SodPolicy {
  readonly version: number;
  readonly status: 'draft';
  readonly pendingRef: string;
  readonly pairs: readonly SodPair[];
}

/** Draft pending the section-11 approval-matrix graduation (WP-012 defect). */
export const sodPairsV1: SodPolicy = {
  version: 1,
  status: 'draft',
  pendingRef: 'section-11-approval-matrix-graduation',
  pairs: [
    { sodId: 'sod-gate-1', firstDuty: 'verification-gate-editor', secondDuty: 'implementer' },
    { sodId: 'sod-act-1', firstDuty: 'activation-approver', secondDuty: 'migration-signer' },
    { sodId: 'sod-ai-1', firstDuty: 'ai-governance-approver', secondDuty: 'feature-owner' },
  ],
};

export function evaluateSeparationOfDuties(
  policy: SodPolicy,
  sodId: string,
  firstActorRef: string,
  secondActorRef: string,
): { readonly compliant: boolean; readonly sodId: string } {
  const pair = policy.pairs.find((candidate) => candidate.sodId === sodId);
  if (pair === undefined) {
    throw new PdpInvariantError(`unknown SoD pair ${JSON.stringify(sodId)}`);
  }
  return { compliant: firstActorRef !== secondActorRef, sodId };
}

export function assertSeparationOfDuties(
  policy: SodPolicy,
  sodId: string,
  firstActorRef: string,
  secondActorRef: string,
): void {
  if (!evaluateSeparationOfDuties(policy, sodId, firstActorRef, secondActorRef).compliant) {
    const pair = policy.pairs.find((candidate) => candidate.sodId === sodId);
    throw new PdpInvariantError(
      `separation of duties ${sodId}: ${pair?.firstDuty ?? 'first duty'} and ` +
        `${pair?.secondDuty ?? 'second duty'} cannot be the same actor`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Policy data of record                                               *
 * ------------------------------------------------------------------ */

/** Sensitive views requiring step-up for portal-side principals. */
export const sensitiveSegmentsV1: readonly DataSegment[] = [
  'clinical-notes',
  'results',
  'medications',
  'documents',
  'genetic',
  'confidential-adolescent',
];

export interface PdpPolicy {
  readonly version: string;
  readonly sensitiveSegments: readonly DataSegment[];
  readonly sodPairs: SodPolicy;
  readonly packs: readonly JurisdictionRulePack[];
}

export const pdpPolicyV1: PdpPolicy = {
  version: 'pdp-policy-v1',
  sensitiveSegments: sensitiveSegmentsV1,
  sodPairs: sodPairsV1,
  packs: jurisdictionPacksV1,
};

/* ------------------------------------------------------------------ *
 * The decision point                                                  *
 * ------------------------------------------------------------------ */

export type PdpActor =
  | {
      readonly kind: 'staff';
      readonly actorRef: string;
      readonly staffAccountId: string;
      readonly personId: PersonId;
      readonly assignments: readonly RoleAssignment[];
      readonly templates: readonly RoleTemplate[];
      readonly overrides: readonly AccessOverride[];
    }
  | { readonly kind: 'patient'; readonly actorRef: string; readonly personId: PersonId }
  | {
      readonly kind: 'proxy';
      readonly actorRef: string;
      readonly personId: PersonId;
      readonly authorityRecords: readonly AuthorityRecord[];
    }
  | {
      readonly kind: 'guarantor';
      readonly actorRef: string;
      readonly personId: PersonId;
      readonly guarantorRoles: readonly GuarantorRole[];
    }
  | {
      readonly kind: 'employer-sponsor-admin';
      readonly actorRef: string;
      readonly legalEntityId: LegalEntityId;
    };

export type ConsentAnswer = 'granted' | 'denied' | 'unavailable';

export interface PdpRequest {
  readonly tenantId: string;
  readonly actor: PdpActor;
  readonly segment: DataSegment;
  readonly action: PdpAction;
  readonly purpose: PurposeOfUse;
  readonly subjectPersonId?: PersonId;
  readonly subjectPatientRecordId?: PatientRecordId;
  readonly partitionTags?: readonly AccessPartitionTag[];
  readonly locationId?: LocationId;
  /** Consent-ledger answer for disclosures; ABSENT fails closed (WP-018). */
  readonly consent?: ConsentAnswer;
  readonly stepUpSatisfied?: boolean;
  readonly subjectDeceased?: boolean;
  readonly estateUnlock?: EstateUnlock;
  readonly gipaAuthorizations?: readonly GipaAuthorization[];
  readonly providerState?: string | null;
  readonly patientState?: string | null;
  /** Whole-second UTC instant — becomes the audit occurredAt. */
  readonly occurredAt: string;
  readonly auditId: string;
}

export const pdpDenialCodes = [
  'no-permit',
  'template-missing',
  'location-out-of-scope',
  'not-self',
  'no-authority-record',
  'proxy-scope-exceeded',
  'authority-expired',
  'authority-not-verified',
  'custody-conflict-held',
  'majority-transition',
  'minor-confidential-protected',
  'records-consent-expired',
  'guarantor-no-clinical',
  'employer-surface-structural',
  'employer-genetic-structural',
  'genetic-minimum-necessary',
  'genetic-override-impossible',
  'gipa-authorization-required',
  'consent-not-granted',
  'consent-unavailable',
  'chart-locked-deceased',
  'step-up-required',
] as const;
export type PdpDenialCode = (typeof pdpDenialCodes)[number];

export type PdpObligation =
  'step-up-required' | 'independent-review-required' | 'override-basis-in-use';

/** Structurally the audit-emit `access`-stream input (audit-emit.md). */
export interface PdpAccessAuditInput {
  readonly auditId: string;
  readonly tenantId: string;
  readonly stream: 'access';
  readonly action: string;
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly subjectRef: string;
  readonly decision: 'allow' | 'deny';
  readonly reason: PurposeOfUse;
  readonly detail: Readonly<Record<string, string>>;
  readonly partitionTags?: readonly AccessPartitionTag[];
  readonly synthetic: true;
}

export interface PdpDecision {
  readonly allowed: boolean;
  readonly effect: 'allow' | 'deny';
  readonly denialCodes: readonly PdpDenialCode[];
  readonly obligations: readonly PdpObligation[];
  readonly basisRefs: readonly string[];
  readonly policyVersion: string;
  readonly breakGlassSeverity?: 'elevated-genetic' | 'standard';
  /** Present on EVERY decision — the deny-audit completeness surface. */
  readonly auditInput: PdpAccessAuditInput;
}

const portalSideKinds: readonly PdpActor['kind'][] = ['patient', 'proxy', 'guarantor'];

const patientSelfEditSegments: readonly DataSegment[] = [
  'demographics',
  'scheduling',
  'messaging',
  'payment-methods',
];

const guarantorSegments: readonly DataSegment[] = ['statements', 'payment-methods'];

const clinicalSegments: readonly DataSegment[] = [
  'clinical-notes',
  'results',
  'medications',
  'documents',
  'genetic',
  'confidential-adolescent',
];

const geneticAllowedPurposes: readonly PurposeOfUse[] = [
  'treatment',
  'patient-request',
  'legal-obligation',
  'break-glass-emergency',
];

interface BaseEvaluation {
  permitted: boolean;
  denial?: PdpDenialCode;
  basisRefs: string[];
  obligations: PdpObligation[];
  /** Role keys carried by the matched staff assignments (unlock check). */
  matchedRoleKeys: CanonicalRoleKey[];
  overrideBasis: boolean;
}

function evaluateStaffBase(
  actor: Extract<PdpActor, { kind: 'staff' }>,
  request: PdpRequest,
  asOfDate: string,
): BaseEvaluation {
  const active = actor.assignments.filter(
    (assignment) =>
      assignment.status === 'active' &&
      assignment.staffAccountId === actor.staffAccountId &&
      assignment.effectiveDate <= asOfDate,
  );
  const inLocation = active.filter(
    (assignment) =>
      assignment.locationScope.length === 0 ||
      request.locationId === undefined ||
      assignment.locationScope.includes(request.locationId),
  );
  if (active.length > 0 && inLocation.length === 0) {
    return {
      permitted: false,
      denial: 'location-out-of-scope',
      basisRefs: [],
      obligations: [],
      matchedRoleKeys: [],
      overrideBasis: false,
    };
  }
  const matchedRoleKeys = inLocation.map((assignment) => assignment.roleKey);
  for (const assignment of inLocation) {
    const template = actor.templates.find(
      (candidate) =>
        candidate.tenantId === assignment.tenantId &&
        candidate.roleKey === assignment.roleKey &&
        candidate.version === assignment.templateVersion,
    );
    if (template === undefined) {
      return {
        permitted: false,
        denial: 'template-missing',
        basisRefs: [],
        obligations: [],
        matchedRoleKeys,
        overrideBasis: false,
      };
    }
    if (permitCovers(template.permits, request.segment, request.action)) {
      return {
        permitted: true,
        basisRefs: [`role-template:${template.roleKey}:v${template.version}`],
        obligations: [],
        matchedRoleKeys,
        overrideBasis: false,
      };
    }
  }
  const override = actor.overrides.find(
    (candidate) =>
      candidate.staffAccountId === actor.staffAccountId &&
      candidate.status === 'active' &&
      asOfDate < candidate.expiresOn &&
      candidate.segment === request.segment &&
      (candidate.actions as readonly string[]).includes(request.action),
  );
  if (override !== undefined) {
    return {
      permitted: true,
      basisRefs: [`access-override:${override.overrideId}`],
      obligations: ['override-basis-in-use'],
      matchedRoleKeys,
      overrideBasis: true,
    };
  }
  return {
    permitted: false,
    denial: 'no-permit',
    basisRefs: [],
    obligations: [],
    matchedRoleKeys,
    overrideBasis: false,
  };
}

function evaluateProxyBase(
  actor: Extract<PdpActor, { kind: 'proxy' }>,
  request: PdpRequest,
  asOfDate: string,
): BaseEvaluation {
  const none: Omit<BaseEvaluation, 'denial'> = {
    permitted: false,
    basisRefs: [],
    obligations: [],
    matchedRoleKeys: [],
    overrideBasis: false,
  };
  const records = actor.authorityRecords.filter(
    (record) =>
      record.granteePersonId === actor.personId &&
      record.subjectPersonId === request.subjectPersonId,
  );
  if (records.length === 0) {
    return { ...none, denial: 'no-authority-record' };
  }
  const live = records.filter(
    (record) =>
      record.status === 'active' && (record.expiresOn === undefined || asOfDate < record.expiresOn),
  );
  const covering = live.find((record) =>
    record.scope.some(
      (entry) => entry.segment === request.segment && entry.actions.includes(request.action),
    ),
  );
  if (covering !== undefined) {
    return {
      permitted: true,
      basisRefs: [`authority:${covering.authorityId}:v${covering.version}`],
      obligations: [],
      matchedRoleKeys: [],
      overrideBasis: false,
    };
  }
  if (live.length > 0) {
    return { ...none, denial: 'proxy-scope-exceeded' };
  }
  const byStatus = (status: AuthorityRecord['status']): boolean =>
    records.some((record) => record.status === status);
  if (byStatus('suspended-majority')) {
    return { ...none, denial: 'majority-transition' };
  }
  if (byStatus('held-conflict')) {
    return { ...none, denial: 'custody-conflict-held' };
  }
  if (
    byStatus('expired') ||
    records.some(
      (record) =>
        record.status === 'active' &&
        record.expiresOn !== undefined &&
        asOfDate >= record.expiresOn,
    )
  ) {
    return { ...none, denial: 'authority-expired' };
  }
  return { ...none, denial: 'authority-not-verified' };
}

function evaluateGuarantorBase(
  actor: Extract<PdpActor, { kind: 'guarantor' }>,
  request: PdpRequest,
): BaseEvaluation {
  const none: Omit<BaseEvaluation, 'denial'> = {
    permitted: false,
    basisRefs: [],
    obligations: [],
    matchedRoleKeys: [],
    overrideBasis: false,
  };
  if (clinicalSegments.includes(request.segment)) {
    // Billing responsibility NEVER implies clinical access (REQ-ID-023 AC-1).
    return { ...none, denial: 'guarantor-no-clinical' };
  }
  const role = actor.guarantorRoles.find(
    (candidate) =>
      candidate.status === 'active' &&
      candidate.guarantorPersonId === actor.personId &&
      candidate.patientRecordId === request.subjectPatientRecordId,
  );
  if (role === undefined) {
    return { ...none, denial: 'no-authority-record' };
  }
  if (
    guarantorSegments.includes(request.segment) &&
    (role.scope as readonly string[]).includes(request.segment) &&
    request.action !== 'edit'
  ) {
    return {
      permitted: true,
      basisRefs: [`guarantor-role:${role.guarantorRoleId}`],
      obligations: [],
      matchedRoleKeys: [],
      overrideBasis: false,
    };
  }
  if (
    guarantorSegments.includes(request.segment) &&
    (role.scope as readonly string[]).includes(request.segment) &&
    request.action === 'edit' &&
    request.segment === 'payment-methods'
  ) {
    // Guarantors manage payment methods (REQ-ID-023 AC-1).
    return {
      permitted: true,
      basisRefs: [`guarantor-role:${role.guarantorRoleId}`],
      obligations: [],
      matchedRoleKeys: [],
      overrideBasis: false,
    };
  }
  return { ...none, denial: 'no-permit' };
}

/**
 * THE decision point (pdp-api.md decision 1). RBAC/relationship base permit,
 * then guards that only DENY or attach obligations, then the decision with
 * its audit input — allow AND deny, one per evaluation, by construction.
 */
export function evaluateAccess(policy: PdpPolicy, request: PdpRequest): PdpDecision {
  assertIdentityId(request.tenantId, 'tenantId');
  assertDataSegment(request.segment, 'segment');
  assertPdpAction(request.action, 'action');
  assertPurposeOfUse(request.purpose, 'purpose');
  for (const tag of request.partitionTags ?? []) {
    if (!(accessPartitionTags as readonly string[]).includes(tag)) {
      throw new PdpInvariantError(`unknown partition tag ${JSON.stringify(tag)}`);
    }
  }
  const asOfDate = request.occurredAt.slice(0, 10);
  const actor = request.actor;
  if (actor.kind !== 'employer-sponsor-admin' && request.subjectPersonId === undefined) {
    throw new PdpInvariantError(
      'a person-data decision names its subject — the access audit record requires it',
    );
  }

  let base: BaseEvaluation;
  switch (actor.kind) {
    case 'staff':
      base = evaluateStaffBase(actor, request, asOfDate);
      break;
    case 'patient':
      base =
        request.subjectPersonId === actor.personId
          ? {
              permitted:
                request.action === 'view' ||
                request.action === 'export' ||
                patientSelfEditSegments.includes(request.segment),
              ...(request.action === 'edit' && !patientSelfEditSegments.includes(request.segment)
                ? { denial: 'no-permit' as const }
                : {}),
              basisRefs: ['patient-self'],
              obligations: [],
              matchedRoleKeys: [],
              overrideBasis: false,
            }
          : {
              permitted: false,
              denial: 'not-self',
              basisRefs: [],
              obligations: [],
              matchedRoleKeys: [],
              overrideBasis: false,
            };
      break;
    case 'proxy':
      base = evaluateProxyBase(actor, request, asOfDate);
      break;
    case 'guarantor':
      base = evaluateGuarantorBase(actor, request);
      break;
    case 'employer-sponsor-admin':
      base = {
        permitted: false,
        denial: 'employer-surface-structural',
        basisRefs: [],
        obligations: [],
        matchedRoleKeys: [],
        overrideBasis: false,
      };
      break;
    default: {
      const exhaustive: never = actor;
      throw new PdpInvariantError(`unknown actor kind ${JSON.stringify(exhaustive)}`);
    }
  }

  const denials: PdpDenialCode[] = base.denial === undefined ? [] : [base.denial];
  const obligations: PdpObligation[] = [...base.obligations];
  const basisRefs: string[] = [...base.basisRefs];
  const effectiveTags: AccessPartitionTag[] = [
    ...new Set<AccessPartitionTag>([
      ...(request.partitionTags ?? []),
      ...(request.segment === 'genetic' ? (['gipa-genetic'] as const) : []),
    ]),
  ];
  let permitted = base.permitted;
  let breakGlassSeverity: 'elevated-genetic' | 'standard' | undefined;

  // Break-glass widens READ scope past no-permit for staff — and nothing
  // else: every guard below still applies (ADR-006 Decision 3 deviation).
  if (
    actor.kind === 'staff' &&
    request.purpose === 'break-glass-emergency' &&
    request.action === 'view' &&
    !permitted &&
    base.denial === 'no-permit'
  ) {
    permitted = true;
    denials.length = 0;
    basisRefs.push('break-glass-widened-read');
    obligations.push('independent-review-required');
    breakGlassSeverity = effectiveTags.includes('gipa-genetic') ? 'elevated-genetic' : 'standard';
  }

  // GIPA partition guard (REQ-ID-019).
  if (effectiveTags.includes('gipa-genetic') && permitted) {
    if (actor.kind === 'employer-sponsor-admin') {
      denials.push('employer-genetic-structural');
    }
    if (base.overrideBasis) {
      denials.push('genetic-override-impossible');
    }
    if (!geneticAllowedPurposes.includes(request.purpose)) {
      denials.push('genetic-minimum-necessary');
    }
    if (request.action === 'export') {
      const authorization =
        request.subjectPersonId === undefined
          ? undefined
          : findValidGipaAuthorization(
              request.gipaAuthorizations ?? [],
              request.subjectPersonId,
              asOfDate,
            );
      if (authorization === undefined) {
        denials.push('gipa-authorization-required');
      } else {
        basisRefs.push(`gipa-authorization:${authorization.authorizationId}`);
      }
    }
  }
  if (actor.kind === 'employer-sponsor-admin' && effectiveTags.includes('gipa-genetic')) {
    // Even on the already-denied employer path the genetic denial is named:
    // there is no employer escape hatch, override, or admin exception.
    if (!denials.includes('employer-genetic-structural')) {
      denials.push('employer-genetic-structural');
    }
  }

  // Consent fails closed on disclosures (pdp-api.md decision 9).
  if (permitted && request.action === 'export') {
    const selfRequest =
      actor.kind === 'patient' &&
      request.purpose === 'patient-request' &&
      request.subjectPersonId === actor.personId;
    if (!selfRequest) {
      if (request.consent === 'denied') {
        denials.push('consent-not-granted');
      } else if (request.consent !== 'granted') {
        denials.push('consent-unavailable');
      }
    }
  }

  // Deceased chart lock (REQ-ID-021 lock half).
  if (
    permitted &&
    request.subjectDeceased === true &&
    request.action === 'edit' &&
    lockedSegmentsOnDeceased.includes(request.segment)
  ) {
    const estateUnlocked =
      actor.kind === 'staff' &&
      request.purpose === 'legal-obligation' &&
      request.estateUnlock !== undefined &&
      request.estateUnlock.personId === request.subjectPersonId &&
      base.matchedRoleKeys.some((role) => chartUnlockRoles.includes(role));
    if (!estateUnlocked) {
      denials.push('chart-locked-deceased');
    } else {
      basisRefs.push(`estate-unlock:${request.estateUnlock?.unlockRef ?? 'missing'}`);
    }
  }

  // Minor confidential segment: proxies and guarantors never see it without
  // an explicit legal basis; unresolved rules deny by default (REQ-ID-006).
  if (permitted && request.segment === 'confidential-adolescent') {
    if (actor.kind === 'proxy') {
      const basis = actor.authorityRecords.find(
        (record) =>
          record.subjectPersonId === request.subjectPersonId &&
          record.status === 'active' &&
          record.confidentialAccessBasisRef !== undefined,
      );
      if (basis === undefined) {
        denials.push('minor-confidential-protected');
      } else {
        basisRefs.push(`confidential-basis:${basis.confidentialAccessBasisRef ?? ''}`);
      }
    } else if (actor.kind === 'guarantor') {
      denials.push('minor-confidential-protected');
    }
  }

  // MHRA-class records-consent expiry auto-suspends records scopes while
  // other scopes continue (REQ-ID-008 AC-5/EX-6 — jurisdiction as data).
  if (
    permitted &&
    actor.kind === 'proxy' &&
    recordsConsentSegments.includes(request.segment) &&
    denials.length === 0
  ) {
    const covering = actor.authorityRecords.find(
      (record) =>
        record.granteePersonId === actor.personId &&
        record.subjectPersonId === request.subjectPersonId &&
        record.status === 'active',
    );
    if (covering?.consentCapturedOn !== undefined) {
      const resolution = recordsConsentResolution(
        policy.packs,
        request.providerState ?? null,
        request.patientState ?? covering.jurisdiction,
      );
      const expiryDays = resolution.scalars['consent-expiry-days'];
      if (resolution.obligations.includes('consent-expiry') && expiryDays !== undefined) {
        const capturedMs = Date.parse(`${covering.consentCapturedOn}T00:00:00Z`);
        const asOfMs = Date.parse(`${asOfDate}T00:00:00Z`);
        const ageDays = Math.floor((asOfMs - capturedMs) / 86_400_000);
        if (ageDays > expiryDays) {
          denials.push('records-consent-expired');
        }
      }
    }
  }

  // Sensitive views require step-up for portal-side principals
  // (FWD-AUTH-015-PDP: the mechanism is WP-014's; the placement is policy).
  if (
    permitted &&
    policy.sensitiveSegments.includes(request.segment) &&
    portalSideKinds.includes(actor.kind) &&
    request.stepUpSatisfied !== true
  ) {
    denials.push('step-up-required');
    obligations.push('step-up-required');
  }

  const allowed = permitted && denials.length === 0;
  const firstDenial = denials[0];
  const firstBasis = basisRefs[0];
  const subjectRef =
    request.subjectPersonId ??
    (actor.kind === 'employer-sponsor-admin'
      ? `employer-roster:${actor.legalEntityId}`
      : undefined);
  if (subjectRef === undefined) {
    throw new PdpInvariantError('unreachable: every decision carries a subject reference');
  }
  const auditInput: PdpAccessAuditInput = {
    auditId: request.auditId,
    tenantId: request.tenantId,
    stream: 'access',
    action: `pdp-${request.action}-${request.segment}`,
    actorRef: actor.actorRef,
    occurredAt: request.occurredAt,
    subjectRef,
    decision: allowed ? 'allow' : 'deny',
    reason: request.purpose,
    detail: {
      policy_version: policy.version,
      ...(firstBasis !== undefined ? { basis_ref: firstBasis } : {}),
      ...(firstDenial !== undefined ? { denial_code: firstDenial } : {}),
    },
    ...(effectiveTags.length > 0 ? { partitionTags: effectiveTags } : {}),
    synthetic: true,
  };
  return {
    allowed,
    effect: allowed ? 'allow' : 'deny',
    denialCodes: denials,
    obligations,
    basisRefs,
    policyVersion: policy.version,
    ...(breakGlassSeverity !== undefined ? { breakGlassSeverity } : {}),
    auditInput,
  };
}

/* ------------------------------------------------------------------ *
 * Permission cache epochs (FWD-MERGE-015-CACHE; REQ-ID-018 AC-5)      *
 * ------------------------------------------------------------------ */

/** An authority-affecting act naming every person whose permits it touches. */
export interface PdpAuthorityEvent {
  readonly eventRef: string;
  readonly personIds: readonly PersonId[];
}

/**
 * The PDP epoch stream: WP-016 merge/unmerge events PLUS PDP authority
 * events (role assignment/end, override grant/expiry, authority record
 * transitions). A cached permit written before ANY of them is refused.
 */
export function pdpInvalidationEpochs(
  mergeEvents: readonly MergeEvent[],
  authorityEvents: readonly PdpAuthorityEvent[],
): ReadonlyMap<PersonId, number> {
  const epochs = new Map<PersonId, number>(invalidationEpochs(mergeEvents));
  for (const event of authorityEvents) {
    for (const personId of event.personIds) {
      epochs.set(personId, (epochs.get(personId) ?? 0) + 1);
    }
  }
  return epochs;
}

/** Same refusal semantics as the WP-016 identity cache — no stale permit. */
export function readPdpCache(
  epochs: ReadonlyMap<PersonId, number>,
  entry: CachedIdentityAssertion,
): CacheReadResult {
  return readThroughCache(epochs, entry);
}

/* ------------------------------------------------------------------ *
 * Canonical template seed data (REQ-ID-018 AC-6; seed 010)            *
 * ------------------------------------------------------------------ */

const template = (
  roleKey: CanonicalRoleKey,
  permits: readonly RolePermit[],
): Omit<RoleTemplate, 'tenantId'> => ({
  roleKey,
  version: 1,
  permits,
  status: 'active',
  changedBy: 'synthetic-it-admin-001',
  changeReason: 'initial-minimum-necessary-baseline',
  synthetic: true,
});

/**
 * Canonical v1 minimum-necessary permit templates (REQ-ID-018 AC-1/AC-6).
 * `it-security-admin` and `employer-sponsor-admin` carry EMPTY permit sets:
 * administration is not data access, and the employer surface has its own
 * structural query path — both are standing deny-by-default proofs.
 */
export const canonicalRoleTemplateSeedsV1: readonly Omit<RoleTemplate, 'tenantId'>[] = [
  template('front-desk', [
    { segment: 'demographics', actions: ['view', 'edit'] },
    { segment: 'scheduling', actions: ['view', 'edit'] },
    { segment: 'messaging', actions: ['view', 'edit'] },
    { segment: 'statements', actions: ['view'] },
  ]),
  template('ma-nurse', [
    { segment: 'demographics', actions: ['view'] },
    { segment: 'scheduling', actions: ['view', 'edit'] },
    { segment: 'messaging', actions: ['view', 'edit'] },
    { segment: 'clinical-notes', actions: ['view', 'edit'] },
    { segment: 'results', actions: ['view'] },
    { segment: 'medications', actions: ['view'] },
  ]),
  template('physician-app', [
    { segment: 'demographics', actions: ['view'] },
    { segment: 'scheduling', actions: ['view'] },
    { segment: 'messaging', actions: ['view', 'edit'] },
    { segment: 'clinical-notes', actions: ['view', 'edit'] },
    { segment: 'results', actions: ['view', 'edit'] },
    { segment: 'medications', actions: ['view', 'edit'] },
    { segment: 'documents', actions: ['view', 'edit'] },
    { segment: 'genetic', actions: ['view', 'edit'] },
    { segment: 'confidential-adolescent', actions: ['view', 'edit'] },
  ]),
  template('biller-coder', [
    { segment: 'demographics', actions: ['view'] },
    { segment: 'statements', actions: ['view', 'edit'] },
    { segment: 'payment-methods', actions: ['view'] },
  ]),
  template('practice-manager', [
    { segment: 'demographics', actions: ['view', 'edit'] },
    { segment: 'scheduling', actions: ['view', 'edit'] },
    { segment: 'messaging', actions: ['view'] },
    { segment: 'statements', actions: ['view', 'edit'] },
    { segment: 'payment-methods', actions: ['view'] },
    { segment: 'documents', actions: ['view'] },
  ]),
  template('it-security-admin', []),
  template('compliance-privacy-officer', [
    { segment: 'demographics', actions: ['view'] },
    { segment: 'documents', actions: ['view', 'export'] },
    { segment: 'clinical-notes', actions: ['view', 'export'] },
    { segment: 'results', actions: ['view', 'export'] },
    { segment: 'genetic', actions: ['view', 'export'] },
    { segment: 'statements', actions: ['view'] },
  ]),
  template('employer-sponsor-admin', []),
];

export const pdpSeedBeginMarker = '-- pdp:generated:begin';
export const pdpSeedEndMarker = '-- pdp:generated:end';

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/**
 * Render the canonical role-template seed as idempotent SQL. The committed
 * seed file embeds this output between the pdp markers with a drift test —
 * `canonicalRoleTemplateSeedsV1` is the ONE data source for template permits.
 */
export function renderPdpTemplateSeedSection(tenantId: string): string {
  const rows = canonicalRoleTemplateSeedsV1.map(
    (seed) =>
      `  (${sqlLiteral(tenantId)}, ${sqlLiteral(seed.roleKey)}, ${seed.version}, ` +
      `${sqlLiteral(JSON.stringify(seed.permits))}::jsonb, ${sqlLiteral(seed.status)}, ` +
      `${sqlLiteral(seed.changedBy)}, ${sqlLiteral(seed.changeReason)}, true)`,
  );
  return [
    pdpSeedBeginMarker,
    '-- Generated by @practicehub/identity renderPdpTemplateSeedSection from',
    '-- canonicalRoleTemplateSeedsV1. Regenerate on any template change; the',
    '-- drift test fails on divergence.',
    'INSERT INTO identity.role_template',
    '  (tenant_id, role_key, version, permits, status, changed_by, change_reason, synthetic)',
    'VALUES',
    rows.join(',\n'),
    'ON CONFLICT (tenant_id, role_key, version) DO UPDATE',
    'SET permits = EXCLUDED.permits,',
    '    status = EXCLUDED.status,',
    '    changed_by = EXCLUDED.changed_by,',
    '    change_reason = EXCLUDED.change_reason,',
    '    synthetic = EXCLUDED.synthetic;',
    pdpSeedEndMarker,
  ].join('\n');
}
