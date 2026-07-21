/**
 * Proxy/guardian authority records (WP-015; REQ-ID-006..014, -016, -023
 * blocked-state halves). Contract: docs/contracts/pdp-api.md (FROZEN)
 * decisions 5 and 6.
 *
 * Authority is a VERSIONED, EVIDENCED record — never an inference. The
 * candidate-basis vocabulary structurally excludes insurance-subscriber,
 * guarantor, household, and prior-message status (REQ-ID-011 exception 1),
 * mirroring how WP-013 excludes endpoints from merge sufficiency. Temporary
 * and incapacity kinds expire by construction; emancipation is the only
 * self-directed kind. Workflow surfaces (renewal tasks, exception queues,
 * review work items) are DIRECTIVE payloads here — WP-022 owns the WorkItem
 * execution (FWD-PDP-022-WORKITEMS).
 */

import { resolveJurisdiction } from '@practicehub/platform-core';

import type { JurisdictionResolution, JurisdictionRulePack } from '@practicehub/platform-core';
import type { PersonId } from '@practicehub/contracts';

import {
  PdpInvariantError,
  assertDataSegment,
  assertPdpAction,
  type DataSegment,
  type PdpAction,
} from './access-vocabulary.js';
import { assertIdentityId, type GuarantorRole } from './identity.js';

/* ------------------------------------------------------------------ *
 * Record model                                                        *
 * ------------------------------------------------------------------ */

export const authorityKinds = [
  'guardian-minor',
  'caregiver-grant',
  'court-order-guardian',
  'temporary-guardianship',
  'emancipation',
  'incapacity-contingent',
] as const;
export type AuthorityKind = (typeof authorityKinds)[number];

export const authorityStatuses = [
  'pending-verification',
  'active',
  'held-conflict',
  'suspended-majority',
  'expired',
  'ended',
  'superseded',
  'blocked',
] as const;
export type AuthorityStatus = (typeof authorityStatuses)[number];

/** Kinds that MUST carry an expiry (time-limited by construction). */
export const expiringAuthorityKinds: readonly AuthorityKind[] = [
  'temporary-guardianship',
  'incapacity-contingent',
];

export interface AuthorityScopeEntry {
  readonly segment: DataSegment;
  readonly actions: readonly PdpAction[];
}

export interface AuthorityRecord {
  readonly tenantId: string;
  readonly authorityId: string;
  readonly version: number;
  readonly kind: AuthorityKind;
  readonly granteePersonId: PersonId;
  readonly subjectPersonId: PersonId;
  readonly scope: readonly AuthorityScopeEntry[];
  /** Governing patient-fact state code, or null when unknown (fails safe). */
  readonly jurisdiction: string | null;
  readonly evidenceRef: string;
  /** Incapacity kinds: the triggering determination (never assertion alone). */
  readonly triggeringEvidenceRef?: string;
  /** Written consent artifact backing records-class scopes (MHRA-class). */
  readonly writtenConsentRef?: string;
  readonly consentCapturedOn?: string;
  /** Explicit legal basis for confidential-adolescent scope (court order). */
  readonly confidentialAccessBasisRef?: string;
  readonly effectiveDate: string;
  readonly expiresOn?: string;
  readonly renewalOwnerRef?: string;
  readonly verifiedBy?: string;
  readonly status: AuthorityStatus;
  readonly supersedesVersion?: number;
  readonly endedReason?: string;
  readonly decidedBy: string;
  readonly synthetic: boolean;
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(value: string, label: string): void {
  if (!isoDatePattern.test(value)) {
    throw new PdpInvariantError(`${label} must be an ISO date; received ${JSON.stringify(value)}`);
  }
}

export function assertAuthorityScopeWellFormed(scope: readonly AuthorityScopeEntry[]): void {
  if (scope.length === 0) {
    throw new PdpInvariantError('authority scope must name at least one segment');
  }
  for (const entry of scope) {
    assertDataSegment(entry.segment, 'authority scope segment');
    if (entry.actions.length === 0) {
      throw new PdpInvariantError(`authority scope for ${entry.segment} must name actions`);
    }
    for (const action of entry.actions) {
      assertPdpAction(action, 'authority scope action');
    }
  }
}

export function assertAuthorityRecordWellFormed(record: AuthorityRecord): void {
  assertIdentityId(record.tenantId, 'tenantId');
  assertIdentityId(record.authorityId, 'authorityId');
  if (!Number.isInteger(record.version) || record.version < 1) {
    throw new PdpInvariantError(`authority ${record.authorityId} version must be a positive int`);
  }
  if (!(authorityKinds as readonly string[]).includes(record.kind)) {
    throw new PdpInvariantError(`authority ${record.authorityId} kind ${record.kind} is unknown`);
  }
  if (record.kind === 'emancipation') {
    if (record.granteePersonId !== record.subjectPersonId) {
      throw new PdpInvariantError(
        `emancipation authority ${record.authorityId} is the subject's OWN independent ` +
          'authority — grantee and subject must be the same person',
      );
    }
  } else if (record.granteePersonId === record.subjectPersonId) {
    throw new PdpInvariantError(
      `authority ${record.authorityId} cannot grant a person authority over themselves`,
    );
  }
  assertAuthorityScopeWellFormed(record.scope);
  if (!record.evidenceRef) {
    throw new PdpInvariantError(`authority ${record.authorityId} requires an evidence reference`);
  }
  if (expiringAuthorityKinds.includes(record.kind) && record.expiresOn === undefined) {
    throw new PdpInvariantError(
      `authority ${record.authorityId} (${record.kind}) is time-limited by construction — ` +
        'expiresOn is required',
    );
  }
  if (record.kind === 'temporary-guardianship' && record.renewalOwnerRef === undefined) {
    throw new PdpInvariantError(
      `temporary authority ${record.authorityId} must name its renewal owner`,
    );
  }
  if (record.kind === 'incapacity-contingent' && record.status === 'active') {
    if (record.triggeringEvidenceRef === undefined) {
      throw new PdpInvariantError(
        `incapacity authority ${record.authorityId} cannot be active without the ` +
          'triggering determination evidence — an assertion alone never activates it',
      );
    }
  }
  if (record.status === 'active' && record.verifiedBy === undefined) {
    throw new PdpInvariantError(
      `authority ${record.authorityId} cannot be active without an attributed verifier`,
    );
  }
  assertIsoDate(record.effectiveDate, 'effectiveDate');
  if (record.expiresOn !== undefined) {
    assertIsoDate(record.expiresOn, 'expiresOn');
  }
}

/* ------------------------------------------------------------------ *
 * Establishment (REQ-ID-006, REQ-ID-014, REQ-ID-008 AC-5)             *
 * ------------------------------------------------------------------ */

export interface EstablishAuthorityRequest {
  readonly record: AuthorityRecord;
  /** Staff verification of relationship AND authority before any grant. */
  readonly relationshipVerified: boolean;
  readonly verifiedBy?: string;
  readonly packs: readonly JurisdictionRulePack[];
  readonly providerState: string | null;
}

export type EstablishAuthorityOutcome =
  | { readonly outcome: 'established'; readonly record: AuthorityRecord }
  | {
      readonly outcome: 'routed-to-staff-verification';
      readonly record: AuthorityRecord;
      readonly routedTo: 'trained-staff-verification';
    }
  | {
      readonly outcome: 'blocked-written-consent-required';
      readonly obligations: readonly string[];
    }
  | { readonly outcome: 'blocked-assertion-only' };

/** Segments whose proxy scope rides on a records-consent artifact. */
export const recordsConsentSegments: readonly DataSegment[] = [
  'clinical-notes',
  'results',
  'medications',
  'documents',
];

export function recordsConsentResolution(
  packs: readonly JurisdictionRulePack[],
  providerState: string | null,
  patientState: string | null,
): JurisdictionResolution {
  return resolveJurisdiction(packs, { providerState, patientState }, 'records-consent');
}

/**
 * Establish proxy/guardian authority (REQ-ID-006 AC-1). Verification precedes
 * grant; an unverified request routes to trained staff (EX-1); an incapacity
 * kind without its triggering determination is blocked outright (REQ-ID-014
 * EX-1); a records-class scope under a written-consent jurisdiction without
 * the written artifact is blocked (REQ-ID-008 AC-5 — jurisdiction as data).
 */
export function establishProxyAuthority(
  request: EstablishAuthorityRequest,
): EstablishAuthorityOutcome {
  const record = request.record;
  if (record.kind === 'incapacity-contingent' && record.triggeringEvidenceRef === undefined) {
    return { outcome: 'blocked-assertion-only' };
  }
  if (!request.relationshipVerified || request.verifiedBy === undefined) {
    const pending: AuthorityRecord = { ...record, status: 'pending-verification' };
    assertAuthorityRecordWellFormed(pending);
    return {
      outcome: 'routed-to-staff-verification',
      record: pending,
      routedTo: 'trained-staff-verification',
    };
  }
  const touchesRecords = record.scope.some((entry) =>
    recordsConsentSegments.includes(entry.segment),
  );
  if (touchesRecords) {
    const resolution = recordsConsentResolution(
      request.packs,
      request.providerState,
      record.jurisdiction,
    );
    if (
      resolution.obligations.includes('written-consent') &&
      record.writtenConsentRef === undefined
    ) {
      return { outcome: 'blocked-written-consent-required', obligations: resolution.obligations };
    }
  }
  const established: AuthorityRecord = {
    ...record,
    status: 'active',
    verifiedBy: request.verifiedBy,
  };
  assertAuthorityRecordWellFormed(established);
  return { outcome: 'established', record: established };
}

/* ------------------------------------------------------------------ *
 * Court-order replacement (REQ-ID-010)                                *
 * ------------------------------------------------------------------ */

export interface CourtOrderValidation {
  readonly jurisdictionValidated: boolean;
  readonly partiesValidated: boolean;
  readonly scopeApproved: boolean;
  readonly authenticityValidated: boolean;
  readonly effectiveDate: string;
  readonly ambiguous: boolean;
  readonly conflicting: boolean;
  readonly appealed: boolean;
  readonly orderEvidenceRef: string;
}

export interface OpenCareItem {
  readonly itemRef: string;
  readonly kind: 'appointment' | 'consent' | 'result' | 'care-task' | 'medication';
  readonly disposition?: 'new-owner' | 'acknowledged';
  readonly newOwnerRef?: string;
}

export interface GuardianReplacementRequest {
  readonly current: AuthorityRecord;
  readonly order: CourtOrderValidation;
  readonly newGranteePersonId: PersonId;
  readonly newScope: readonly AuthorityScopeEntry[];
  readonly openItems: readonly OpenCareItem[];
  readonly decidedBy: string;
  readonly verifiedBy: string;
}

export type GuardianReplacementOutcome =
  | {
      readonly outcome: 'replaced';
      readonly priorEnded: AuthorityRecord;
      readonly next: AuthorityRecord;
      /** Both guardians receive ONLY the notices the order permits (AC-4). */
      readonly noticeDirective: {
        readonly priorGuardian: 'order-permitted-notices-only';
        readonly newGuardian: 'order-permitted-notices-only';
      };
    }
  | {
      readonly outcome: 'blocked-escalated';
      readonly escalatedTo: readonly string[];
      readonly minimumNecessaryCareContinues: true;
    }
  | {
      readonly outcome: 'blocked-open-items';
      readonly undispositioned: readonly string[];
    };

/**
 * Replace guardian authority from a validated court order (REQ-ID-010).
 * Ambiguous/conflicting/appealed orders block automated replacement and
 * escalate while minimum-necessary care continues (EX-1); every open item
 * needs a disposition — none is silently closed (AC-3); the change is a new
 * VERSION so a mistaken replacement rolls back from the chain (EX-2).
 */
export function replaceGuardianAuthority(
  request: GuardianReplacementRequest,
): GuardianReplacementOutcome {
  const { order } = request;
  if (order.ambiguous || order.conflicting || order.appealed) {
    return {
      outcome: 'blocked-escalated',
      escalatedTo: ['compliance-privacy-officer'],
      minimumNecessaryCareContinues: true,
    };
  }
  if (
    !order.jurisdictionValidated ||
    !order.partiesValidated ||
    !order.scopeApproved ||
    !order.authenticityValidated
  ) {
    throw new PdpInvariantError(
      'a guardianship decision records validated jurisdiction, parties, scope, and ' +
        'authenticity before any access change (REQ-ID-010 AC-1)',
    );
  }
  const undispositioned = request.openItems
    .filter((item) => item.disposition === undefined)
    .map((item) => item.itemRef);
  if (undispositioned.length > 0) {
    return { outcome: 'blocked-open-items', undispositioned };
  }
  const priorEnded: AuthorityRecord = {
    ...request.current,
    status: 'superseded',
    endedReason: 'court-order-replacement',
  };
  const next: AuthorityRecord = {
    ...request.current,
    version: request.current.version + 1,
    kind: 'court-order-guardian',
    granteePersonId: request.newGranteePersonId,
    scope: request.newScope,
    evidenceRef: order.orderEvidenceRef,
    effectiveDate: order.effectiveDate,
    status: 'active',
    verifiedBy: request.verifiedBy,
    decidedBy: request.decidedBy,
    supersedesVersion: request.current.version,
  };
  assertAuthorityRecordWellFormed(next);
  return {
    outcome: 'replaced',
    priorEnded,
    next,
    noticeDirective: {
      priorGuardian: 'order-permitted-notices-only',
      newGuardian: 'order-permitted-notices-only',
    },
  };
}

/**
 * Roll a mistaken replacement back FROM THE VERSION CHAIN (REQ-ID-010 EX-2):
 * the prior version is reinstated as a new version citing the correction
 * evidence — nothing already taken is erased, and the actors who took those
 * actions remain on the record.
 */
export function rollbackGuardianReplacement(
  mistaken: AuthorityRecord,
  prior: AuthorityRecord,
  correctionEvidenceRef: string,
  decidedBy: string,
): { readonly reinstated: AuthorityRecord; readonly mistakenRetained: AuthorityRecord } {
  if (mistaken.supersedesVersion !== prior.version) {
    throw new PdpInvariantError(
      'rollback resolves from the version chain — the mistaken record must name the ' +
        'version it superseded',
    );
  }
  if (!correctionEvidenceRef) {
    throw new PdpInvariantError('rollback requires correction evidence');
  }
  const reinstated: AuthorityRecord = {
    ...prior,
    version: mistaken.version + 1,
    evidenceRef: correctionEvidenceRef,
    status: 'active',
    supersedesVersion: mistaken.version,
    decidedBy,
  };
  const mistakenRetained: AuthorityRecord = {
    ...mistaken,
    status: 'superseded',
    endedReason: 'mistaken-replacement-rolled-back',
  };
  assertAuthorityRecordWellFormed(reinstated);
  return { reinstated, mistakenRetained };
}

/* ------------------------------------------------------------------ *
 * Custody conflict (REQ-ID-011)                                       *
 * ------------------------------------------------------------------ */

/**
 * The ONLY bases that can resolve a custody conflict. Insurance-subscriber,
 * guarantor, household, and prior-message status are structurally excluded
 * (REQ-ID-011 EX-1) — they are not members of this vocabulary.
 */
export const custodyAuthorityBases = [
  'court-order',
  'legal-agreement',
  'verified-legal-document',
] as const;
export type CustodyAuthorityBasis = (typeof custodyAuthorityBases)[number];

/** Named so tests can prove the exclusion — never a resolution basis. */
export const custodyNonAuthorityBases = [
  'insurance-subscriber',
  'guarantor-status',
  'household-membership',
  'prior-message-thread',
] as const;

export interface CustodyConflictHold {
  readonly holdRef: string;
  readonly tenantId: string;
  readonly subjectPersonId: PersonId;
  /** What trained staff see when the conflict is logged (AC-1). */
  readonly display: {
    readonly evidenceRefs: readonly string[];
    readonly jurisdiction: string | null;
    readonly permittedActions: readonly string[];
    readonly affectedEncounterRefs: readonly string[];
    readonly safeContactRef: string | null;
  };
  readonly heldRecords: readonly AuthorityRecord[];
  readonly neutralPathwayRef: string;
}

export function openCustodyConflict(
  holdRef: string,
  records: readonly AuthorityRecord[],
  display: CustodyConflictHold['display'],
  neutralPathwayRef: string,
): CustodyConflictHold {
  if (records.length < 2) {
    throw new PdpInvariantError('a custody conflict involves at least two authority claims');
  }
  const [first] = records;
  if (first === undefined) {
    throw new PdpInvariantError('a custody conflict requires authority records');
  }
  return {
    holdRef,
    tenantId: first.tenantId,
    subjectPersonId: first.subjectPersonId,
    display,
    heldRecords: records.map((record) => ({ ...record, status: 'held-conflict' as const })),
    neutralPathwayRef,
  };
}

/** A contested action while held: withheld; the neutral pathway continues. */
export function evaluateContestedAction(hold: CustodyConflictHold): {
  readonly action: 'held';
  readonly neutralPathwayContinues: true;
  readonly neutralPathwayRef: string;
} {
  return {
    action: 'held',
    neutralPathwayContinues: true,
    neutralPathwayRef: hold.neutralPathwayRef,
  };
}

export interface CustodyResolution {
  readonly basis: CustodyAuthorityBasis;
  readonly evidenceRef: string;
  readonly approvedBy: string;
  /** Scope, contacts, appointments, and disclosure rules update TOGETHER. */
  readonly updates: {
    readonly scope: readonly AuthorityScopeEntry[];
    readonly contactRefs: readonly string[];
    readonly appointmentRefs: readonly string[];
    readonly disclosureRuleRefs: readonly string[];
  };
}

export function resolveCustodyConflict(
  hold: CustodyConflictHold,
  prevailing: AuthorityRecord,
  resolution: CustodyResolution,
): {
  readonly resolved: AuthorityRecord;
  readonly appliedTogether: CustodyResolution['updates'];
  readonly versionProvenance: { readonly fromVersion: number; readonly basisRef: string };
} {
  if (!(custodyAuthorityBases as readonly string[]).includes(resolution.basis)) {
    throw new PdpInvariantError(
      'custody resolves only on authoritative legal evidence — insurance-subscriber, ' +
        'guarantor, household, and prior-message status can never carry the decision ' +
        '(REQ-ID-011 exception 1)',
    );
  }
  if (!hold.heldRecords.some((record) => record.authorityId === prevailing.authorityId)) {
    throw new PdpInvariantError('the prevailing record must be one of the held claims');
  }
  const resolved: AuthorityRecord = {
    ...prevailing,
    version: prevailing.version + 1,
    scope: resolution.updates.scope,
    evidenceRef: resolution.evidenceRef,
    status: 'active',
    verifiedBy: resolution.approvedBy,
    supersedesVersion: prevailing.version,
    decidedBy: resolution.approvedBy,
  };
  assertAuthorityRecordWellFormed(resolved);
  return {
    resolved,
    appliedTogether: resolution.updates,
    versionProvenance: { fromVersion: prevailing.version, basisRef: resolution.evidenceRef },
  };
}

/** Patient-safety escalation never widens either caregiver's access (EX-2). */
export function escalateCustodySafetyConcern(hold: CustodyConflictHold): {
  readonly escalatedTo: readonly string[];
  readonly subjectPersonId: PersonId;
  readonly accessWidened: false;
} {
  return {
    escalatedTo: ['physician-app', 'compliance-privacy-officer'],
    subjectPersonId: hold.subjectPersonId,
    accessWidened: false,
  };
}

/* ------------------------------------------------------------------ *
 * Temporary authority expiry (REQ-ID-012)                             *
 * ------------------------------------------------------------------ */

export interface RenewalWindowDirective {
  readonly kind: 'authority-renewal-task';
  readonly authorityId: string;
  readonly renewalOwnerRef: string;
  readonly accessExtended: false;
}

/** The renewal window opens a task WITHOUT extending access (AC-2). */
export function openRenewalWindow(record: AuthorityRecord): RenewalWindowDirective {
  if (record.kind !== 'temporary-guardianship' || record.renewalOwnerRef === undefined) {
    throw new PdpInvariantError('renewal windows apply to temporary authority with an owner');
  }
  return {
    kind: 'authority-renewal-task',
    authorityId: record.authorityId,
    renewalOwnerRef: record.renewalOwnerRef,
    accessExtended: false,
  };
}

export interface ExpiredAuthorityOutcome {
  readonly expired: AuthorityRecord;
  /** Pending work moves to a HUMAN exception queue for lawful reassignment. */
  readonly exceptionQueue: readonly {
    readonly itemRef: string;
    readonly queue: 'human-exception-queue';
    readonly reason: 'lawful-reassignment-required';
  }[];
}

export function expireTemporaryAuthority(
  record: AuthorityRecord,
  openItems: readonly OpenCareItem[],
  asOfDate: string,
): ExpiredAuthorityOutcome {
  if (record.expiresOn === undefined || asOfDate < record.expiresOn) {
    throw new PdpInvariantError('authority has not reached its expiration event');
  }
  return {
    expired: { ...record, status: 'expired' },
    exceptionQueue: openItems.map((item) => ({
      itemRef: item.itemRef,
      queue: 'human-exception-queue',
      reason: 'lawful-reassignment-required',
    })),
  };
}

export const invalidExtensionBases = [
  'portal-activity',
  'staff-convenience',
  'financial-relationship',
] as const;

export type ExtensionAttempt =
  | { readonly basis: (typeof invalidExtensionBases)[number] }
  | {
      readonly basis: 'valid-renewal-evidence';
      readonly evidenceRef: string;
      readonly newEffectiveDate: string;
      readonly newExpiresOn: string;
      readonly approvedBy: string;
    };

export type ExtensionOutcome =
  | { readonly outcome: 'refused'; readonly reason: 'not-an-authority-basis' }
  | {
      readonly outcome: 'renewed';
      readonly renewed: AuthorityRecord;
      readonly heldWorkReconciled: true;
    };

/**
 * Expired authority is never extended by portal activity, staff convenience,
 * or an unrelated financial relationship (EX-1); a valid renewal resumes from
 * the NEW effective version and reconciles held work (AC-4).
 */
export function attemptAuthorityExtension(
  record: AuthorityRecord,
  attempt: ExtensionAttempt,
): ExtensionOutcome {
  if (attempt.basis !== 'valid-renewal-evidence') {
    return { outcome: 'refused', reason: 'not-an-authority-basis' };
  }
  const renewed: AuthorityRecord = {
    ...record,
    version: record.version + 1,
    evidenceRef: attempt.evidenceRef,
    effectiveDate: attempt.newEffectiveDate,
    expiresOn: attempt.newExpiresOn,
    status: 'active',
    verifiedBy: attempt.approvedBy,
    supersedesVersion: record.version,
  };
  assertAuthorityRecordWellFormed(renewed);
  return { outcome: 'renewed', renewed, heldWorkReconciled: true };
}

/** No lawful proxy available: urgent needs escalate under policy (EX-2). */
export function escalateNoLawfulProxy(): {
  readonly escalatedTo: readonly string[];
  readonly under: 'safeguarding-policy';
} {
  return {
    escalatedTo: ['physician-app', 'compliance-privacy-officer'],
    under: 'safeguarding-policy',
  };
}

/* ------------------------------------------------------------------ *
 * Emancipation (REQ-ID-013)                                           *
 * ------------------------------------------------------------------ */

export type EmancipationOutcome =
  | { readonly outcome: 'established'; readonly record: AuthorityRecord }
  | {
      readonly outcome: 'held-compliance-review';
      readonly contestedDisclosure: 'denied-by-default';
      readonly emergencyCareDelayed: false;
    };

export function establishEmancipation(request: {
  readonly record: AuthorityRecord;
  readonly statusResolved: boolean;
  readonly verifiedBy: string;
}): EmancipationOutcome {
  if (request.record.kind !== 'emancipation') {
    throw new PdpInvariantError('establishEmancipation requires an emancipation-kind record');
  }
  if (!request.statusResolved) {
    return {
      outcome: 'held-compliance-review',
      contestedDisclosure: 'denied-by-default',
      emergencyCareDelayed: false,
    };
  }
  const record: AuthorityRecord = {
    ...request.record,
    status: 'active',
    verifiedBy: request.verifiedBy,
  };
  assertAuthorityRecordWellFormed(record);
  return { outcome: 'established', record };
}

/**
 * Financial/clinical artifact delivery checks recipient authority for the
 * clinical AND guarantor dimensions SEPARATELY (REQ-ID-013 AC-3).
 */
export function deliverEmancipatedArtifact(
  emancipation: AuthorityRecord,
  artifact: { readonly kind: 'clinical' | 'financial'; readonly recipientPersonId: PersonId },
  guarantorRoles: readonly GuarantorRole[],
): { readonly recipientAuthorized: boolean; readonly checkedAgainst: string } {
  if (emancipation.kind !== 'emancipation' || emancipation.status !== 'active') {
    throw new PdpInvariantError('artifact delivery evaluates against active emancipation');
  }
  if (artifact.kind === 'clinical') {
    return {
      recipientAuthorized: artifact.recipientPersonId === emancipation.subjectPersonId,
      checkedAgainst: 'emancipation-clinical-scope',
    };
  }
  const guarantorAuthorized = guarantorRoles.some(
    (role) => role.status === 'active' && role.guarantorPersonId === artifact.recipientPersonId,
  );
  return {
    recipientAuthorized:
      guarantorAuthorized || artifact.recipientPersonId === emancipation.subjectPersonId,
    checkedAgainst: 'guarantor-authority',
  };
}

/** A later legal-status change re-versions; earlier lawful activity stays. */
export function versionLegalStatusChange(
  record: AuthorityRecord,
  change: { readonly evidenceRef: string; readonly decidedBy: string; readonly ended: boolean },
): {
  readonly next: AuthorityRecord;
  readonly earlierActivityRetained: true;
} {
  const next: AuthorityRecord = {
    ...record,
    version: record.version + 1,
    evidenceRef: change.evidenceRef,
    status: change.ended ? 'ended' : 'active',
    ...(change.ended ? { endedReason: 'legal-status-change' } : {}),
    supersedesVersion: record.version,
    decidedBy: change.decidedBy,
  };
  return { next, earlierActivityRetained: true };
}

/* ------------------------------------------------------------------ *
 * Incapacity activation (REQ-ID-014)                                  *
 * ------------------------------------------------------------------ */

export type IncapacityActivationOutcome =
  | { readonly outcome: 'activated'; readonly record: AuthorityRecord }
  | { readonly outcome: 'blocked-assertion-only' }
  | {
      readonly outcome: 'blocked-escalated';
      readonly nonurgentDelegatedActionsBlocked: true;
      readonly escalatedTo: readonly string[];
    };

export function activateIncapacityAuthority(request: {
  readonly contingent: AuthorityRecord;
  readonly triggeringDeterminationRef?: string;
  readonly conflictingCapacityEvidence?: boolean;
  readonly verifiedBy: string;
  readonly reviewerRef: string;
  readonly expiresOn: string;
}): IncapacityActivationOutcome {
  if (request.contingent.kind !== 'incapacity-contingent') {
    throw new PdpInvariantError('activation applies to an incapacity-contingent record');
  }
  if (request.triggeringDeterminationRef === undefined) {
    return { outcome: 'blocked-assertion-only' };
  }
  if (request.conflictingCapacityEvidence === true) {
    return {
      outcome: 'blocked-escalated',
      nonurgentDelegatedActionsBlocked: true,
      escalatedTo: ['physician-app', 'compliance-privacy-officer'],
    };
  }
  const record: AuthorityRecord = {
    ...request.contingent,
    status: 'active',
    triggeringEvidenceRef: request.triggeringDeterminationRef,
    verifiedBy: request.verifiedBy,
    renewalOwnerRef: request.reviewerRef,
    expiresOn: request.expiresOn,
  };
  assertAuthorityRecordWellFormed(record);
  return { outcome: 'activated', record };
}

/** Capacity returns: scope withdrawn; future actions return to the patient. */
export function deactivateOnCapacityReturn(
  record: AuthorityRecord,
  reviewedBy: string,
): { readonly ended: AuthorityRecord; readonly futureActionsReturnTo: PersonId } {
  if (record.kind !== 'incapacity-contingent') {
    throw new PdpInvariantError('capacity-return deactivation applies to incapacity authority');
  }
  return {
    ended: {
      ...record,
      status: 'ended',
      endedReason: `capacity-returned:${reviewedBy}`,
    },
    futureActionsReturnTo: record.subjectPersonId,
  };
}

/* ------------------------------------------------------------------ *
 * Majority transition (REQ-ID-007)                                    *
 * ------------------------------------------------------------------ */

export const majorityAgeFloorYears = 18;
const reviewLeadDays = 30;

function addYears(isoDate: string, years: number): string {
  const [y, m, d] = isoDate.split('-');
  return `${String(Number(y) + years).padStart(4, '0')}-${m}-${d}`;
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Kinds that derive from guardian authority and suspend at majority. */
const guardianDerivedKinds: readonly AuthorityKind[] = [
  'guardian-minor',
  'caregiver-grant',
  'temporary-guardianship',
];

export interface MajorityTransitionEvaluation {
  readonly phase:
    | 'pre-review'
    | 'review-window'
    | 'suspended-pending-adult-consent'
    | 'transitioned'
    | 'unresolved-birth-date';
  readonly majorityDate?: string;
  readonly reviewOpensOn?: string;
  /** ≥30-day-lead review work item (REQ-ID-007 AC-1; execution WP-022). */
  readonly workItemDirective?: {
    readonly kind: 'majority-transition-review';
    readonly dueBy: string;
  };
  readonly suspendedRecords: readonly AuthorityRecord[];
  readonly preservedRecords: readonly AuthorityRecord[];
  /** Denial explains the transition — never a silent error (AC-9). */
  readonly denialExplanation?: {
    readonly code: 'majority-transition';
    readonly explains: 'guardian-access-suspended-at-majority';
  };
  /** Guardian-signed consents needing the adult's own re-consent (AC-8). */
  readonly reConsentFlags: readonly string[];
  /** Guardian-inherited contact handling (AC-10; execution WP-044). */
  readonly contactDirective?: {
    readonly flagInheritedContactsUnverified: true;
    readonly clinicalNotificationsRoute: 'portal-only-until-adult-confirms';
    readonly severGuardianOwnedNumbers: true;
  };
  /** State-specific confidential carve-outs, as resolver DATA (EX-3). */
  readonly confidentialCarveoutObligations: readonly string[];
  /** Unresolvable age/jurisdiction: confidential denies by default. */
  readonly confidentialDefault: 'deny' | 'per-scope';
}

export function evaluateMajorityTransition(request: {
  readonly subjectBirthDate: string | null;
  readonly authorityRecords: readonly AuthorityRecord[];
  readonly guardianSignedConsentRefs: readonly string[];
  readonly packs: readonly JurisdictionRulePack[];
  readonly providerState: string | null;
  readonly patientState: string | null;
  readonly asOfDate: string;
  readonly adultConsentCompleted: boolean;
}): MajorityTransitionEvaluation {
  const minorsResolution = resolveJurisdiction(
    request.packs,
    { providerState: request.providerState, patientState: request.patientState },
    'minors-part2',
  );
  if (request.subjectBirthDate === null) {
    return {
      phase: 'unresolved-birth-date',
      suspendedRecords: [],
      preservedRecords: [],
      reConsentFlags: [],
      confidentialCarveoutObligations: minorsResolution.obligations,
      confidentialDefault: 'deny',
    };
  }
  const majorityDate = addYears(request.subjectBirthDate, majorityAgeFloorYears);
  const reviewOpensOn = addDays(majorityDate, -reviewLeadDays);
  if (request.asOfDate < reviewOpensOn) {
    return {
      phase: 'pre-review',
      majorityDate,
      reviewOpensOn,
      suspendedRecords: [],
      preservedRecords: [],
      reConsentFlags: [],
      confidentialCarveoutObligations: minorsResolution.obligations,
      confidentialDefault: 'per-scope',
    };
  }
  if (request.asOfDate < majorityDate) {
    return {
      phase: 'review-window',
      majorityDate,
      reviewOpensOn,
      workItemDirective: { kind: 'majority-transition-review', dueBy: majorityDate },
      suspendedRecords: [],
      preservedRecords: [],
      reConsentFlags: [],
      confidentialCarveoutObligations: minorsResolution.obligations,
      confidentialDefault: 'per-scope',
    };
  }
  // A documented continuing-authority order (disability-related
  // guardianship/conservatorship past majority) preserves access ONLY with
  // evidence AND an evidence-backed expiration (EX-2/EX-5) — a court-order
  // record without an expiry suspends like any guardian-derived authority:
  // continuing access is never indefinite.
  const continuesPastMajority = (record: AuthorityRecord): boolean =>
    record.kind === 'court-order-guardian' && record.expiresOn !== undefined;
  const suspended = request.authorityRecords
    .filter(
      (record) =>
        (guardianDerivedKinds.includes(record.kind) || record.kind === 'court-order-guardian') &&
        !continuesPastMajority(record),
    )
    .map((record) => ({ ...record, status: 'suspended-majority' as const }));
  return {
    phase: request.adultConsentCompleted ? 'transitioned' : 'suspended-pending-adult-consent',
    majorityDate,
    reviewOpensOn,
    suspendedRecords: suspended,
    preservedRecords: request.authorityRecords.filter(
      (record) =>
        continuesPastMajority(record) ||
        (!guardianDerivedKinds.includes(record.kind) && record.kind !== 'court-order-guardian'),
    ),
    denialExplanation: {
      code: 'majority-transition',
      explains: 'guardian-access-suspended-at-majority',
    },
    reConsentFlags: request.adultConsentCompleted ? [] : request.guardianSignedConsentRefs,
    contactDirective: {
      flagInheritedContactsUnverified: true,
      clinicalNotificationsRoute: 'portal-only-until-adult-confirms',
      severGuardianOwnedNumbers: true,
    },
    confidentialCarveoutObligations: minorsResolution.obligations,
    confidentialDefault: 'per-scope',
  };
}

/* ------------------------------------------------------------------ *
 * Guarantor authority change (REQ-ID-016 / REQ-ID-023)                *
 * ------------------------------------------------------------------ */

export const guarantorChangeBlockers = [
  'conflicting-custody',
  'disputed-responsibility',
  'bankruptcy',
  'confidential-minor-service',
  'unverified-caller',
] as const;
export type GuarantorChangeBlocker = (typeof guarantorChangeBlockers)[number];

export interface GuarantorChangeRequest {
  readonly current: GuarantorRole;
  readonly newRole: GuarantorRole;
  readonly evidenceRef: string;
  /** Every reviewed dimension of REQ-ID-016 AC-1 must be affirmed. */
  readonly reviewed: {
    readonly effectiveScope: boolean;
    readonly dates: boolean;
    readonly patientAccounts: boolean;
    readonly balances: boolean;
    readonly priorNotices: boolean;
    readonly portalPermissions: boolean;
    readonly source: boolean;
  };
  readonly blockers: readonly GuarantorChangeBlocker[];
  /** The new guarantor's OWN billing consent — distinct from treatment. */
  readonly guarantorBillingConsentRef: string;
  readonly decidedBy: string;
}

export type GuarantorChangeOutcome =
  | {
      readonly outcome: 'blocked-review';
      readonly statementReleaseHeld: true;
      readonly blockers: readonly GuarantorChangeBlocker[];
    }
  | {
      readonly outcome: 'changed';
      readonly priorEnded: GuarantorRole;
      /** Prior actors lose ONLY the authority that ended (AC-2). */
      readonly onlyFinancialAuthorityEnded: true;
      readonly newRole: GuarantorRole;
      readonly statementsRouteTo: PersonId;
    };

export function changeGuarantorAuthority(request: GuarantorChangeRequest): GuarantorChangeOutcome {
  if (request.blockers.length > 0) {
    return { outcome: 'blocked-review', statementReleaseHeld: true, blockers: request.blockers };
  }
  const reviewedAll = Object.values(request.reviewed).every((flag) => flag === true);
  if (!reviewedAll) {
    throw new PdpInvariantError(
      'a guarantor change reviews effective scope, dates, patient accounts, balances, ' +
        'prior notices, portal permissions, and source before applying (REQ-ID-016 AC-1)',
    );
  }
  if (!request.guarantorBillingConsentRef) {
    throw new PdpInvariantError(
      "the guarantor's own consent to be billed is captured separately from the " +
        "patient's treatment consent (REQ-ID-023 AC-4)",
    );
  }
  return {
    outcome: 'changed',
    priorEnded: {
      ...request.current,
      status: 'ended',
      endedReason: 'financial-responsibility-change',
    },
    onlyFinancialAuthorityEnded: true,
    newRole: request.newRole,
    statementsRouteTo: request.newRole.guarantorPersonId,
  };
}

export interface HistoricalReassignment {
  readonly balanceRefs: readonly string[];
  /** A HUMAN counselor approves historical reassignment (REQ-ID-016 AC-3). */
  readonly approvedBy: string;
  readonly legalBasisRef: string;
}

export function reassignHistoricalBalances(reassignment: HistoricalReassignment): {
  readonly lineage: readonly {
    readonly balanceRef: string;
    readonly legalBasisRef: string;
    readonly rewritesPriorTransactions: false;
  }[];
} {
  if (!reassignment.approvedBy || !reassignment.legalBasisRef) {
    throw new PdpInvariantError(
      'historical balance reassignment requires a human approver and a legal basis ' +
        '(REQ-ID-016 AC-3) — ledger lineage never rewrites prior transactions',
    );
  }
  return {
    lineage: reassignment.balanceRefs.map((balanceRef) => ({
      balanceRef,
      legalBasisRef: reassignment.legalBasisRef,
      rewritesPriorTransactions: false,
    })),
  };
}

export type GuarantorReleaseOutcome =
  | { readonly outcome: 'blocked-payment-method-required' }
  | {
      readonly outcome: 'released';
      readonly ended: GuarantorRole;
      readonly billingTransfersTo: PersonId;
    };

/**
 * Patient-initiated guarantor removal (REQ-ID-023 AC-3/AC-6/EX-2): with an
 * unpaid balance the release requires a valid patient payment method or plan;
 * on release the guarantor's access ends.
 */
export function releaseGuarantor(request: {
  readonly role: GuarantorRole;
  readonly patientPersonId: PersonId;
  readonly unpaidBalance: boolean;
  readonly patientPaymentMethodRef?: string;
  readonly paymentPlanRef?: string;
}): GuarantorReleaseOutcome {
  if (
    request.unpaidBalance &&
    request.patientPaymentMethodRef === undefined &&
    request.paymentPlanRef === undefined
  ) {
    return { outcome: 'blocked-payment-method-required' };
  }
  return {
    outcome: 'released',
    ended: { ...request.role, status: 'ended', endedReason: 'patient-requested-release' },
    billingTransfersTo: request.patientPersonId,
  };
}

/** A contested guarantor designation has a removal path (REQ-ID-023 EX-4). */
export function disputeGuarantorDesignation(
  role: GuarantorRole,
  dispute: { readonly disputedBy: PersonId; readonly reviewRef: string },
): {
  readonly review: 'guarantor-designation-review';
  readonly reviewRef: string;
  readonly role: GuarantorRole;
} {
  if (!dispute.reviewRef) {
    throw new PdpInvariantError('a designation dispute opens an attributed review');
  }
  return { review: 'guarantor-designation-review', reviewRef: dispute.reviewRef, role };
}
