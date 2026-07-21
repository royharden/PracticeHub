/**
 * Merge governance (WP-016). Contract: docs/contracts/merge-governance.md
 * (FROZEN). Executes FWD-ID-016-UNMERGE from identity-types.md: the
 * possible-match queue persists as merge cases; merge and unmerge are
 * reversible with lineage; identity-derived caches invalidate so no stale
 * permission survives. Compliance trace: R6-REQ-007 (governed merge).
 *
 * Structural guarantees, in the shapes rather than in review memory:
 * - opening a case never merges (there is no auto-merge code path);
 * - every merge passes assertMergeAuthorizationBasis (REQ-ID-017 exception:
 *   endpoint equality / household address never authorize);
 * - lineage is written by the same act that merges — an unlineaged merge is
 *   unrepresentable in the return shape;
 * - unmerge without lineage is BLOCKED (manual chart review), never guessed.
 */

import type { PersonId, TenantId } from '@practicehub/contracts';

import { IdentityInvariantError, assertIdentityId } from './identity.js';
import {
  MergeGovernanceError,
  assertMergeAuthorizationBasis,
  identityMatchAttributes,
  type IdentityAttributeSet,
  type IdentityMatchAttribute,
  type MatchCandidate,
  type MatchablePerson,
  type MergeAuthorizationBasis,
} from './matching.js';
import { findIdentityCandidates } from './matching.js';

/* ------------------------------------------------------------------ *
 * Merge cases — the persisted possible-match queue (REQ-ID-003 AC-2, *
 * REQ-ID-009, REQ-ID-020 AC-3, REQ-ID-026 AC-1, REQ-ID-030)          *
 * ------------------------------------------------------------------ */

export const mergeCaseKinds = [
  'possible-match',
  'check-in-duplicate',
  'staff-flagged-duplicate',
  'wrong-merge-suspect',
] as const;
export type MergeCaseKind = (typeof mergeCaseKinds)[number];

export const mergeCaseStatuses = [
  'open',
  'resolved-linked',
  'resolved-distinct',
  'resolved-merged',
  'dismissed',
] as const;
export type MergeCaseStatus = (typeof mergeCaseStatuses)[number];

/**
 * REQ-ID-009 exception: these collision shapes require specialized checks
 * and block automated outreach while unresolved.
 */
export const specializedReviewPatterns = [
  'minor-or-proxy',
  'shared-household-contact',
  'name-change',
  'sponsor-roster',
  'duplicate-payment-rail-email',
] as const;
export type SpecializedReviewPattern = (typeof specializedReviewPatterns)[number];

export const mergeConfidenceLevels = ['high', 'medium', 'low'] as const;
export type MergeConfidence = (typeof mergeConfidenceLevels)[number];

export type MergeCaseResolutionKind = 'linked' | 'confirmed-distinct' | 'merged' | 'dismissed';

export interface MergeCaseResolution {
  readonly kind: MergeCaseResolutionKind;
  readonly decidedBy: string;
  readonly reason: string;
  /** Approved evidence; required for `linked` and `merged` (REQ-ID-009 AC-2). */
  readonly evidenceRef?: string;
  /** Required when the case carries specialized patterns and resolves toward link/merge. */
  readonly specializedChecksRef?: string;
  /** `confirmed-distinct`: the pair is not re-flagged absent new evidence. */
  readonly doNotReflag?: boolean;
  /** Set by executeMerge when kind is `merged`. */
  readonly mergeEventId?: string;
}

export interface MergeCase {
  readonly caseId: string;
  readonly tenantId: TenantId;
  readonly kind: MergeCaseKind;
  readonly status: MergeCaseStatus;
  /** The identities under review — at least two, always distinct. */
  readonly personIds: readonly PersonId[];
  /** Attribute NAMES only — record values never sit on the case (REQ-ID-003 exception 1). */
  readonly matchedAttributes: readonly IdentityMatchAttribute[];
  readonly conflictingAttributes: readonly IdentityMatchAttribute[];
  readonly confidence: MergeConfidence;
  /** True when outreach could hit the wrong person while unresolved (REQ-ID-009 AC-1). */
  readonly contactRisk: boolean;
  /** Pending operations shown in the workspace (REQ-ID-009 AC-1). */
  readonly pendingOperations: readonly string[];
  /** Source-id refs (`system:value`) shown in the workspace (REQ-ID-009 AC-1). */
  readonly sourceIdRefs: readonly string[];
  readonly specializedPatterns: readonly SpecializedReviewPattern[];
  readonly openedBy: string;
  readonly source: string;
  readonly resolution?: MergeCaseResolution;
  readonly synthetic: boolean;
}

export interface OpenMergeCaseInput {
  readonly caseId: string;
  readonly tenantId: TenantId;
  readonly kind: MergeCaseKind;
  readonly personIds: readonly PersonId[];
  readonly matchedAttributes: readonly IdentityMatchAttribute[];
  readonly conflictingAttributes?: readonly IdentityMatchAttribute[];
  readonly confidence: MergeConfidence;
  readonly contactRisk?: boolean;
  readonly pendingOperations?: readonly string[];
  readonly sourceIdRefs?: readonly string[];
  readonly specializedPatterns?: readonly SpecializedReviewPattern[];
  readonly openedBy: string;
  readonly source: string;
}

/** Opening a case quarantines — it never merges, links, or messages anyone. */
export function openMergeCase(input: OpenMergeCaseInput): MergeCase {
  assertIdentityId(input.tenantId, 'tenantId');
  assertIdentityId(input.caseId, 'caseId');
  const distinct = new Set(input.personIds);
  if (input.personIds.length < 2 || distinct.size !== input.personIds.length) {
    throw new MergeGovernanceError(
      `merge case ${input.caseId} requires at least two distinct persons under review`,
    );
  }
  if (!input.openedBy || !input.source) {
    throw new MergeGovernanceError(
      `merge case ${input.caseId} must record who opened it and from which source`,
    );
  }
  return {
    caseId: input.caseId,
    tenantId: input.tenantId,
    kind: input.kind,
    status: 'open',
    personIds: input.personIds,
    matchedAttributes: input.matchedAttributes,
    conflictingAttributes: input.conflictingAttributes ?? [],
    confidence: input.confidence,
    contactRisk: input.contactRisk ?? false,
    pendingOperations: input.pendingOperations ?? [],
    sourceIdRefs: input.sourceIdRefs ?? [],
    specializedPatterns: input.specializedPatterns ?? [],
    openedBy: input.openedBy,
    source: input.source,
    synthetic: true,
  };
}

/**
 * REQ-ID-009 exception: specialized-pattern collisions block automated
 * outreach to every person under review while unresolved. Contact-risk cases
 * suppress the same way — a collision flagged as contact-risk must not be
 * messaged on either identity until a human resolves it.
 */
export function outreachSuppressedPersonIds(cases: readonly MergeCase[]): readonly PersonId[] {
  const suppressed = new Set<PersonId>();
  for (const mergeCase of cases) {
    if (mergeCase.status !== 'open') {
      continue;
    }
    if (mergeCase.specializedPatterns.length > 0 || mergeCase.contactRisk) {
      for (const personId of mergeCase.personIds) {
        suppressed.add(personId);
      }
    }
  }
  return [...suppressed].sort((left, right) => left.localeCompare(right));
}

/**
 * Resolve a case. Attribution and a reason are mandatory; `linked`/`merged`
 * carry approved evidence (REQ-ID-009 AC-2); specialized patterns require
 * their checks before any link/merge (REQ-ID-009 exception); a `merged`
 * resolution must name its merge event — resolveMergeCase alone cannot merge.
 */
export function resolveMergeCase(mergeCase: MergeCase, resolution: MergeCaseResolution): MergeCase {
  if (mergeCase.status !== 'open') {
    throw new MergeGovernanceError(
      `merge case ${mergeCase.caseId} is ${mergeCase.status}; only an open case resolves`,
    );
  }
  if (!resolution.decidedBy || !resolution.reason) {
    throw new MergeGovernanceError(
      `merge case ${mergeCase.caseId} resolution must be attributed with a recorded reason`,
    );
  }
  if ((resolution.kind === 'linked' || resolution.kind === 'merged') && !resolution.evidenceRef) {
    throw new MergeGovernanceError(
      `merge case ${mergeCase.caseId} cannot resolve to ${resolution.kind} without approved ` +
        'identity evidence (REQ-ID-009 AC-2)',
    );
  }
  if (
    mergeCase.specializedPatterns.length > 0 &&
    (resolution.kind === 'linked' || resolution.kind === 'merged') &&
    !resolution.specializedChecksRef
  ) {
    throw new MergeGovernanceError(
      `merge case ${mergeCase.caseId} carries specialized patterns ` +
        `(${mergeCase.specializedPatterns.join(', ')}) — link/merge requires the specialized ` +
        'checks reference (REQ-ID-009 exception)',
    );
  }
  if (resolution.kind === 'merged' && !resolution.mergeEventId) {
    throw new MergeGovernanceError(
      `merge case ${mergeCase.caseId} cannot resolve to merged without its merge event — ` +
        'merges execute through executeMerge, never by case edit',
    );
  }
  const status: MergeCaseStatus =
    resolution.kind === 'linked'
      ? 'resolved-linked'
      : resolution.kind === 'confirmed-distinct'
        ? 'resolved-distinct'
        : resolution.kind === 'merged'
          ? 'resolved-merged'
          : 'dismissed';
  return { ...mergeCase, status, resolution };
}

/**
 * REQ-ID-020 exception 1 / REQ-ID-030 AC-3: a pair resolved
 * `confirmed-distinct` (or dismissed) with do-not-reflag is not re-flagged by
 * the same signals; NEW evidence re-opens the question.
 */
export function shouldReflagPair(
  priorCases: readonly MergeCase[],
  personA: PersonId,
  personB: PersonId,
  newEvidenceRef?: string,
): boolean {
  const covered = priorCases.some(
    (mergeCase) =>
      (mergeCase.status === 'resolved-distinct' || mergeCase.status === 'dismissed') &&
      mergeCase.resolution?.doNotReflag === true &&
      mergeCase.personIds.includes(personA) &&
      mergeCase.personIds.includes(personB),
  );
  if (!covered) {
    return true;
  }
  return Boolean(newEvidenceRef);
}

/* ------------------------------------------------------------------ *
 * Check-in duplicate flag (REQ-ID-030)                               *
 * ------------------------------------------------------------------ */

export type CheckInEvaluation =
  | { readonly outcome: 'no-match'; readonly proceed: true }
  | {
      readonly outcome: 'duplicate-warning';
      /** Strong candidates (name/birth-date backed) — shown side by side BEFORE completion. */
      readonly candidates: readonly MatchCandidate[];
      /** Household-only matches — advisory, never blocking (exception 2). */
      readonly advisoryHouseholdMatches: readonly MatchCandidate[];
      readonly blocksCompletion: true;
      readonly comparison: 'side-by-side';
    }
  | {
      readonly outcome: 'advisory-only';
      readonly advisoryHouseholdMatches: readonly MatchCandidate[];
      readonly proceed: true;
    };

/**
 * REQ-ID-030 AC-1 + exception 2: only a STRONG candidate (carrying a
 * merge-sufficient attribute) raises the blocking warning. A guardian and a
 * minor sharing phone/address match only on household attributes — those
 * candidates are structurally `strong=false` and cannot block check-in.
 */
export function evaluateCheckInIdentity(
  entered: IdentityAttributeSet,
  existing: readonly MatchablePerson[],
): CheckInEvaluation {
  const candidates = findIdentityCandidates(entered, existing);
  const strong = candidates.filter((candidate) => candidate.strong);
  const household = candidates.filter((candidate) => !candidate.strong);
  if (strong.length > 0) {
    return {
      outcome: 'duplicate-warning',
      candidates: strong,
      advisoryHouseholdMatches: household,
      blocksCompletion: true,
      comparison: 'side-by-side',
    };
  }
  if (household.length > 0) {
    return { outcome: 'advisory-only', advisoryHouseholdMatches: household, proceed: true };
  }
  return { outcome: 'no-match', proceed: true };
}

export interface CheckInConfirmation {
  readonly decision: 'same-person' | 'different-person' | 'unresolved';
  readonly decidedBy: string;
  readonly reason?: string;
  /** REQ-ID-030 AC-5: acquired-clinic duplicates route to the migration queue. */
  readonly acquiredClinicDuplicate?: boolean;
}

export type CheckInResolution =
  | {
      readonly outcome: 'proceed-existing-record';
      readonly newRecordCreated: false;
      readonly resolutionLogged: true;
      readonly decidedBy: string;
    }
  | {
      readonly outcome: 'proceed-new-record';
      readonly nearMatchLogged: 'reviewed-and-dismissed';
      readonly reason: string;
      readonly decidedBy: string;
    }
  | {
      readonly outcome: 'check-in-paused';
      readonly billingBlocked: true;
      readonly clinicalDocumentationBlocked: true;
      readonly routedTo: 'merge-review-queue' | 'data-migration-merge-queue';
    };

/**
 * REQ-ID-030 AC-2/AC-3/AC-5: same person → the EXISTING record, logged;
 * different person → new record with the near-match logged
 * reviewed-and-dismissed (a legal name change is a note, not a data error —
 * exception 3, carried in `reason`); unresolved → check-in pauses and the
 * patient is billed and documented against NO record while it stands.
 */
export function confirmCheckInResolution(confirmation: CheckInConfirmation): CheckInResolution {
  if (confirmation.decision !== 'unresolved' && !confirmation.decidedBy) {
    throw new MergeGovernanceError('a check-in duplicate decision must be attributed');
  }
  if (confirmation.decision === 'same-person') {
    return {
      outcome: 'proceed-existing-record',
      newRecordCreated: false,
      resolutionLogged: true,
      decidedBy: confirmation.decidedBy,
    };
  }
  if (confirmation.decision === 'different-person') {
    if (!confirmation.reason) {
      throw new MergeGovernanceError(
        'dismissing a near-match as a different person requires a recorded reason (REQ-ID-030 AC-3)',
      );
    }
    return {
      outcome: 'proceed-new-record',
      nearMatchLogged: 'reviewed-and-dismissed',
      reason: confirmation.reason,
      decidedBy: confirmation.decidedBy,
    };
  }
  return {
    outcome: 'check-in-paused',
    billingBlocked: true,
    clinicalDocumentationBlocked: true,
    routedTo: confirmation.acquiredClinicDuplicate
      ? 'data-migration-merge-queue'
      : 'merge-review-queue',
  };
}

/**
 * REQ-ID-030 AC-4: a duplicate discovered after both records carry activity
 * routes to the merge-review queue — never resolved unilaterally at the desk.
 */
export function routePostHocDuplicate(bothRecordsHaveActivity: boolean): {
  readonly routedTo: 'merge-review-queue' | 'front-desk-resolution';
  readonly frontDeskMayResolve: boolean;
} {
  if (bothRecordsHaveActivity) {
    return { routedTo: 'merge-review-queue', frontDeskMayResolve: false };
  }
  return { routedTo: 'front-desk-resolution', frontDeskMayResolve: true };
}

/* ------------------------------------------------------------------ *
 * Foreign-chart flag (REQ-ID-020)                                    *
 * ------------------------------------------------------------------ */

export interface ForeignChartLink {
  readonly sourceSystem: string;
  readonly sourceValue: string;
  readonly migrationStatus: 'unreconciled' | 'in-review' | 'reconciled';
  /** Which data this source contributed — renders once reconciled (AC-4). */
  readonly contributedFields: readonly string[];
}

export type ForeignChartView =
  | {
      readonly banner: {
        readonly sourceSystems: readonly string[];
        readonly migrationStatus: 'unreconciled' | 'in-review';
      };
      readonly reconciled: false;
    }
  | {
      readonly banner: null;
      readonly reconciled: true;
      /** Per-source contribution provenance (REQ-ID-020 AC-4). */
      readonly provenance: readonly {
        readonly sourceSystem: string;
        readonly contributedFields: readonly string[];
      }[];
    };

export function foreignChartBanner(links: readonly ForeignChartLink[]): ForeignChartView {
  const outstanding = links.filter((link) => link.migrationStatus !== 'reconciled');
  if (outstanding.length > 0) {
    const status = outstanding.some((link) => link.migrationStatus === 'unreconciled')
      ? 'unreconciled'
      : 'in-review';
    return {
      banner: {
        sourceSystems: [...new Set(outstanding.map((link) => link.sourceSystem))].sort((a, b) =>
          a.localeCompare(b),
        ),
        migrationStatus: status,
      },
      reconciled: false,
    };
  }
  return {
    banner: null,
    reconciled: true,
    provenance: links.map((link) => ({
      sourceSystem: link.sourceSystem,
      contributedFields: link.contributedFields,
    })),
  };
}

/** REQ-ID-020 AC-3: staff flag a suspected duplicate straight into the reconciliation queue. */
export function flagSuspectedDuplicate(
  input: Omit<OpenMergeCaseInput, 'kind'>,
): MergeCase & { readonly routedTo: 'data-migration-reconciliation-queue' } {
  const mergeCase = openMergeCase({ ...input, kind: 'staff-flagged-duplicate' });
  return { ...mergeCase, routedTo: 'data-migration-reconciliation-queue' };
}

/* ------------------------------------------------------------------ *
 * Wrong-merge detection (REQ-ID-026 AC-1)                            *
 * ------------------------------------------------------------------ */

export interface MergedChartFacts {
  readonly birthDates: readonly string[];
  readonly sexes: readonly string[];
  readonly divergentContactHistory: boolean;
  readonly activeInsuranceCount: number;
}

export interface WrongMergeDetection {
  readonly flagged: boolean;
  readonly signals: readonly string[];
  /** Detection NEVER unmerges — a human reviews first (REQ-ID-026 AC-1). */
  readonly disposition: 'human-review-required' | 'none';
  readonly autoUnmerge: false;
}

export function detectWrongMergeSuspects(facts: MergedChartFacts): WrongMergeDetection {
  const signals: string[] = [];
  if (new Set(facts.birthDates.filter(Boolean)).size > 1) {
    signals.push('conflicting-birth-date');
  }
  if (new Set(facts.sexes.filter(Boolean)).size > 1) {
    signals.push('conflicting-sex');
  }
  if (facts.divergentContactHistory) {
    signals.push('divergent-contact-history');
  }
  if (facts.activeInsuranceCount > 1) {
    signals.push('multiple-active-insurances');
  }
  return {
    flagged: signals.length > 0,
    signals,
    disposition: signals.length > 0 ? 'human-review-required' : 'none',
    autoUnmerge: false,
  };
}

/* ------------------------------------------------------------------ *
 * Merge execution with lineage (REQ-ID-009 AC-2/AC-3, REQ-ID-026)    *
 * ------------------------------------------------------------------ */

/** Identity-owned artifact vocabulary v1 (contract-frozen). */
export const mergeArtifactKinds = [
  'patient-record',
  'person-name',
  'endpoint-association',
  'source-identifier',
  'guarantor-role',
  'proxy-grant',
  'timeline-entry',
] as const;
export type MergeArtifactKind = (typeof mergeArtifactKinds)[number];

export interface MergeArtifact {
  readonly kind: string;
  readonly artifactRef: string;
  readonly ownerPersonId: PersonId;
}

export type MergeEventKind = 'merge' | 'unmerge';

export interface MergeEvent {
  readonly eventId: string;
  readonly tenantId: TenantId;
  readonly caseId: string;
  readonly kind: MergeEventKind;
  readonly survivorPersonId: PersonId;
  readonly mergedPersonId: PersonId;
  readonly basisAttributes: readonly IdentityMatchAttribute[];
  readonly decidedBy: string;
  readonly rationale: string;
  readonly evidenceRef?: string;
  readonly reversesEventId?: string;
  readonly synthetic: boolean;
}

export type MergeLineageDisposition = 're-attributed' | 'indeterminate-quarantined';

export interface MergeLineageRecord {
  readonly lineageId: string;
  readonly tenantId: TenantId;
  readonly eventId: string;
  readonly artifactKind: string;
  readonly artifactRef: string;
  readonly fromPersonId: PersonId;
  readonly toPersonId: PersonId;
  readonly disposition: MergeLineageDisposition;
  readonly synthetic: boolean;
}

export interface MergeExecutionInput {
  readonly mergeCase: MergeCase;
  readonly basis: MergeAuthorizationBasis;
  readonly eventId: string;
  readonly survivorPersonId: PersonId;
  readonly mergedPersonId: PersonId;
  /** Artifacts of the merged-away person to re-attribute — lineage per artifact. */
  readonly artifacts: readonly MergeArtifact[];
  /** All source-id refs of the merged-away person — every alias is preserved. */
  readonly mergedPersonSourceIdRefs: readonly string[];
  readonly rationale: string;
  readonly evidenceRef: string;
  readonly specializedChecksRef?: string;
}

export interface MergeExecution {
  readonly event: MergeEvent;
  readonly lineage: readonly MergeLineageRecord[];
  readonly resolvedCase: MergeCase;
  /** Every merged-away alias, retained on the survivor (REQ-ID-009 AC-2). */
  readonly preservedAliases: readonly string[];
  readonly aliasesPreserved: true;
}

/**
 * Execute a governed merge. Authorization passes assertMergeAuthorizationBasis
 * on EVERY path; the recognized-artifact fail-safe blocks the whole merge on
 * an unanticipated artifact kind — nothing is silently skipped; lineage is
 * emitted by the same act, so an unlineaged merge cannot exist.
 */
export function executeMerge(input: MergeExecutionInput): MergeExecution {
  assertIdentityId(input.eventId, 'eventId');
  assertMergeAuthorizationBasis(input.basis);
  if (input.survivorPersonId === input.mergedPersonId) {
    throw new MergeGovernanceError('a person cannot merge with themselves');
  }
  if (
    !input.mergeCase.personIds.includes(input.survivorPersonId) ||
    !input.mergeCase.personIds.includes(input.mergedPersonId)
  ) {
    throw new MergeGovernanceError(
      `merge case ${input.mergeCase.caseId} does not cover both persons ` +
        `(${input.survivorPersonId}, ${input.mergedPersonId})`,
    );
  }
  const recognized: readonly string[] = mergeArtifactKinds;
  const unrecognized = input.artifacts.filter((artifact) => !recognized.includes(artifact.kind));
  if (unrecognized.length > 0) {
    throw new MergeGovernanceError(
      'merge blocked — unrecognized artifact kind(s) ' +
        `${[...new Set(unrecognized.map((artifact) => artifact.kind))].join(', ')}: an ` +
        'unanticipated record type fails safe for review, never silently skips re-attribution',
    );
  }
  const foreign = input.artifacts.filter(
    (artifact) => artifact.ownerPersonId !== input.mergedPersonId,
  );
  if (foreign.length > 0) {
    throw new MergeGovernanceError(
      `merge artifacts must belong to the merged-away person; ` +
        `${foreign.map((artifact) => artifact.artifactRef).join(', ')} do not`,
    );
  }
  const event: MergeEvent = {
    eventId: input.eventId,
    tenantId: input.mergeCase.tenantId,
    caseId: input.mergeCase.caseId,
    kind: 'merge',
    survivorPersonId: input.survivorPersonId,
    mergedPersonId: input.mergedPersonId,
    basisAttributes: input.basis.comparedAttributes,
    decidedBy: input.basis.decidedBy,
    rationale: input.rationale,
    evidenceRef: input.evidenceRef,
    synthetic: true,
  };
  const lineage: MergeLineageRecord[] = input.artifacts.map((artifact, index) => ({
    lineageId: `${input.eventId}-l${String(index + 1).padStart(3, '0')}`,
    tenantId: input.mergeCase.tenantId,
    eventId: input.eventId,
    artifactKind: artifact.kind,
    artifactRef: artifact.artifactRef,
    fromPersonId: input.mergedPersonId,
    toPersonId: input.survivorPersonId,
    disposition: 're-attributed',
    synthetic: true,
  }));
  const resolvedCase = resolveMergeCase(input.mergeCase, {
    kind: 'merged',
    decidedBy: input.basis.decidedBy,
    reason: input.rationale,
    evidenceRef: input.evidenceRef,
    ...(input.specializedChecksRef !== undefined
      ? { specializedChecksRef: input.specializedChecksRef }
      : {}),
    mergeEventId: input.eventId,
  });
  return {
    event,
    lineage,
    resolvedCase,
    preservedAliases: [...input.mergedPersonSourceIdRefs],
    aliasesPreserved: true,
  };
}

/**
 * REQ-MIG-014 AC-4 engine mechanics / REQ-ID-009 AC-2: a merged-away person
 * id remains resolvable — the event chain redirects it to the current
 * survivor; an unmerge event cancels the redirect it reverses.
 */
export function resolveMergedPerson(
  events: readonly MergeEvent[],
  personId: PersonId,
): { readonly personId: PersonId; readonly redirected: boolean } {
  const reversed = new Set(
    events
      .filter((event) => event.kind === 'unmerge' && event.reversesEventId !== undefined)
      .map((event) => event.reversesEventId as string),
  );
  let current = personId;
  let redirected = false;
  // Follow at most one redirect per event to terminate on any input.
  for (let hops = 0; hops <= events.length; hops += 1) {
    const merge = events.find(
      (event) =>
        event.kind === 'merge' && !reversed.has(event.eventId) && event.mergedPersonId === current,
    );
    if (!merge) {
      return { personId: current, redirected };
    }
    current = merge.survivorPersonId;
    redirected = true;
  }
  return { personId: current, redirected };
}

/* ------------------------------------------------------------------ *
 * Unmerge (REQ-ID-026)                                               *
 * ------------------------------------------------------------------ */

export interface PostMergeArtifact {
  readonly kind: string;
  readonly artifactRef: string;
  /** Which of the two identities the artifact determinably references. */
  readonly referencesPersonIds: readonly PersonId[];
}

export interface UnmergeReconciliationRow {
  readonly artifactRef: string;
  readonly artifactKind: string;
  readonly preUnmergeOwner: PersonId;
  readonly postUnmergeOwner: PersonId | 'indeterminate';
}

export interface UnmergeReconciliationReport {
  readonly rows: readonly UnmergeReconciliationRow[];
  readonly indeterminateCount: number;
}

export interface UnmergeExecutionInput {
  readonly mergeEvent: MergeEvent;
  readonly lineage: readonly MergeLineageRecord[];
  /** Artifacts created AFTER the merge — attributed or quarantined, never guessed. */
  readonly postMergeArtifacts: readonly PostMergeArtifact[];
  readonly eventId: string;
  readonly approvedBy: string;
  readonly rationale: string;
  /**
   * Injectable per-artifact restore applier; a throw simulates a midway
   * failure and MUST roll the operation back to the merged state.
   */
  readonly applyRestore?: (record: MergeLineageRecord) => void;
}

export type UnmergeOutcome =
  | {
      readonly outcome: 'unmerged';
      readonly event: MergeEvent;
      readonly restoredLineage: readonly MergeLineageRecord[];
      readonly quarantined: readonly MergeLineageRecord[];
      readonly report: UnmergeReconciliationReport;
    }
  | {
      readonly outcome: 'blocked-no-lineage';
      readonly manualChartReviewOpened: true;
      readonly autoSplitRefused: true;
    }
  | {
      readonly outcome: 'rolled-back-to-merged';
      readonly noHalfSplit: true;
      readonly p0Alert: {
        readonly severity: 'P0';
        readonly kind: 'unmerge-partial-failure';
        readonly failedArtifactRef: string;
      };
    };

/**
 * Reverse a merge from its retained lineage. No lineage → blocked with a
 * manual chart-review workflow (exception 1); a both-identity post-merge
 * artifact quarantines as indeterminate (AC-3/exception 2); a midway failure
 * rolls back to the merged state with a P0 alert — no half-split chart
 * (exception 3). The reconciliation report shows every artifact's pre- and
 * post-unmerge owner (AC-3).
 */
export function executeUnmerge(input: UnmergeExecutionInput): UnmergeOutcome {
  assertIdentityId(input.eventId, 'eventId');
  if (input.mergeEvent.kind !== 'merge') {
    throw new MergeGovernanceError('only a merge event is reversible by unmerge');
  }
  if (!input.approvedBy || !input.rationale) {
    throw new MergeGovernanceError(
      'an unmerge must be approved by an attributed operator with a documented rationale ' +
        '(REQ-ID-026 AC-4)',
    );
  }
  const eventLineage = input.lineage.filter(
    (record) =>
      record.eventId === input.mergeEvent.eventId && record.disposition === 're-attributed',
  );
  if (eventLineage.length === 0) {
    return { outcome: 'blocked-no-lineage', manualChartReviewOpened: true, autoSplitRefused: true };
  }
  const restoredLineage: MergeLineageRecord[] = [];
  for (const [index, record] of eventLineage.entries()) {
    const mirror: MergeLineageRecord = {
      lineageId: `${input.eventId}-r${String(index + 1).padStart(3, '0')}`,
      tenantId: record.tenantId,
      eventId: input.eventId,
      artifactKind: record.artifactKind,
      artifactRef: record.artifactRef,
      fromPersonId: record.toPersonId,
      toPersonId: record.fromPersonId,
      disposition: 're-attributed',
      synthetic: true,
    };
    try {
      input.applyRestore?.(mirror);
    } catch {
      // Exception 3: nothing partial escapes — the merged state stands.
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
  const quarantined: MergeLineageRecord[] = [];
  const reportRows: UnmergeReconciliationRow[] = restoredLineage.map((record) => ({
    artifactRef: record.artifactRef,
    artifactKind: record.artifactKind,
    preUnmergeOwner: record.fromPersonId,
    postUnmergeOwner: record.toPersonId,
  }));
  for (const [index, artifact] of input.postMergeArtifacts.entries()) {
    const references = [...new Set(artifact.referencesPersonIds)].filter(
      (personId) => personId === survivorPersonId || personId === mergedPersonId,
    );
    if (references.length === 1 && references[0] !== undefined) {
      reportRows.push({
        artifactRef: artifact.artifactRef,
        artifactKind: artifact.kind,
        preUnmergeOwner: survivorPersonId,
        postUnmergeOwner: references[0],
      });
      continue;
    }
    // AC-3 + exception 2: references both, or neither determinably — held
    // for manual adjudication, never guessed.
    const record: MergeLineageRecord = {
      lineageId: `${input.eventId}-q${String(index + 1).padStart(3, '0')}`,
      tenantId: input.mergeEvent.tenantId,
      eventId: input.eventId,
      artifactKind: artifact.kind,
      artifactRef: artifact.artifactRef,
      fromPersonId: survivorPersonId,
      toPersonId: survivorPersonId,
      disposition: 'indeterminate-quarantined',
      synthetic: true,
    };
    quarantined.push(record);
    reportRows.push({
      artifactRef: artifact.artifactRef,
      artifactKind: artifact.kind,
      preUnmergeOwner: survivorPersonId,
      postUnmergeOwner: 'indeterminate',
    });
  }
  const event: MergeEvent = {
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
  };
  return {
    outcome: 'unmerged',
    event,
    restoredLineage,
    quarantined,
    report: { rows: reportRows, indeterminateCount: quarantined.length },
  };
}

/* ------------------------------------------------------------------ *
 * Downstream propagation (REQ-ID-027)                                *
 * ------------------------------------------------------------------ */

export const downstreamSystemOwners = {
  claims: 'rcm',
  messages: 'comms',
  'portal-results': 'clinical',
  referrals: 'clinical',
} as const;
export type DownstreamSystem = keyof typeof downstreamSystemOwners;

export interface DownstreamExposure {
  readonly system: DownstreamSystem;
  readonly artifactRef: string;
  /** Who the artifact actually reached / was filed under. */
  readonly exposedPersonId: PersonId;
  /** Who it should have been about, post-unmerge. */
  readonly correctPersonId: PersonId;
  readonly status: 'submitted' | 'adjudicated-paid' | 'sent' | 'released' | 'active';
  readonly electronicCorrectionSupported: boolean;
  /** A care decision materialized on commingled data (e.g. a prescription). */
  readonly materializedClinicalDecision?: boolean;
}

export interface CorrectionDirective {
  readonly system: DownstreamSystem;
  readonly ownerRole: (typeof downstreamSystemOwners)[DownstreamSystem];
  readonly artifactRef: string;
  readonly action: 'electronic-correction' | 'rcm-void-rebill-refund' | 'manual-correction-task';
  readonly trackedConfirmationRequired: boolean;
}

export interface WrongDisclosureIncident {
  readonly artifactRef: string;
  readonly system: DownstreamSystem;
  readonly exposedPersonId: PersonId;
  readonly linkedWorkflow: 'phi-breach-evaluation';
}

export interface HarmReviewTask {
  readonly taskOwner: 'clinician';
  readonly question: 'clinical-decision-on-commingled-data';
  readonly findingRecorded: boolean;
}

export interface ProviderEscalation {
  readonly artifactRef: string;
  readonly escalateTo: 'treating-provider';
  readonly immediate: true;
}

export interface UnmergePropagation {
  readonly directives: readonly CorrectionDirective[];
  readonly wrongDisclosureIncidents: readonly WrongDisclosureIncident[];
  readonly harmReview: HarmReviewTask;
  readonly escalations: readonly ProviderEscalation[];
}

/**
 * REQ-ID-027: every affected downstream artifact gets a correction directive
 * with a named owner (AC-1); wrong-recipient releases open a wrong-disclosure
 * incident on the PHI-breach workflow (AC-2); a clinician harm review is
 * tasked (AC-3) and a materialized clinical decision escalates immediately
 * (exception 2); paid claims route to RCM void/rebill (exception 1); systems
 * without electronic correction get manual tracked tasks (exception 3).
 */
export function propagateUnmerge(exposures: readonly DownstreamExposure[]): UnmergePropagation {
  const directives: CorrectionDirective[] = [];
  const incidents: WrongDisclosureIncident[] = [];
  const escalations: ProviderEscalation[] = [];
  for (const exposure of exposures) {
    const action: CorrectionDirective['action'] =
      exposure.system === 'claims' && exposure.status === 'adjudicated-paid'
        ? 'rcm-void-rebill-refund'
        : exposure.electronicCorrectionSupported
          ? 'electronic-correction'
          : 'manual-correction-task';
    directives.push({
      system: exposure.system,
      ownerRole: downstreamSystemOwners[exposure.system],
      artifactRef: exposure.artifactRef,
      action,
      trackedConfirmationRequired: true,
    });
    const wrongRecipient = exposure.exposedPersonId !== exposure.correctPersonId;
    if (wrongRecipient && (exposure.status === 'sent' || exposure.status === 'released')) {
      incidents.push({
        artifactRef: exposure.artifactRef,
        system: exposure.system,
        exposedPersonId: exposure.exposedPersonId,
        linkedWorkflow: 'phi-breach-evaluation',
      });
    }
    if (exposure.materializedClinicalDecision) {
      escalations.push({
        artifactRef: exposure.artifactRef,
        escalateTo: 'treating-provider',
        immediate: true,
      });
    }
  }
  return {
    directives,
    wrongDisclosureIncidents: incidents,
    harmReview: {
      taskOwner: 'clinician',
      question: 'clinical-decision-on-commingled-data',
      findingRecorded: false,
    },
    escalations,
  };
}

export type UnmergeClosureReport =
  | { readonly complete: true; readonly confirmedCount: number }
  | {
      readonly complete: false;
      readonly outstanding: readonly string[];
    };

/** REQ-ID-027 AC-4: closure only when EVERY directive carries its confirmation. */
export function unmergeClosureReport(
  directives: readonly CorrectionDirective[],
  confirmations: ReadonlyMap<string, string>,
): UnmergeClosureReport {
  const outstanding = directives
    .filter((directive) => !confirmations.get(directive.artifactRef))
    .map((directive) => directive.artifactRef);
  if (outstanding.length > 0) {
    return { complete: false, outstanding };
  }
  return { complete: true, confirmedCount: directives.length };
}

/* ------------------------------------------------------------------ *
 * Cache invalidation — no stale permission survives (the WP-016 gate) *
 * ------------------------------------------------------------------ */

/**
 * A person's invalidation epoch is the count of merge/unmerge events touching
 * them — survivor AND merged-away, and an unmerge bumps BOTH again (the
 * merged view is stale after reversal too).
 */
export function invalidationEpochs(events: readonly MergeEvent[]): ReadonlyMap<PersonId, number> {
  const epochs = new Map<PersonId, number>();
  for (const event of events) {
    for (const personId of [event.survivorPersonId, event.mergedPersonId]) {
      epochs.set(personId, (epochs.get(personId) ?? 0) + 1);
    }
  }
  return epochs;
}

/**
 * Any cached identity-derived assertion: a PDP permission scope, an outreach
 * resolution, a chart projection. It carries the epoch observed at write.
 */
export interface CachedIdentityAssertion {
  readonly personId: PersonId;
  readonly epochAtWrite: number;
  readonly payloadRef: string;
}

export function currentEpoch(epochs: ReadonlyMap<PersonId, number>, personId: PersonId): number {
  return epochs.get(personId) ?? 0;
}

export function isCacheEntryStale(
  epochs: ReadonlyMap<PersonId, number>,
  entry: CachedIdentityAssertion,
): boolean {
  return entry.epochAtWrite < currentEpoch(epochs, entry.personId);
}

export type CacheReadResult =
  | { readonly served: true; readonly payloadRef: string }
  | { readonly served: false; readonly refused: 'stale-identity-cache' };

/**
 * The gate property: an entry written before ANY merge/unmerge touching its
 * person is refused after it — no stale permission survives.
 */
export function readThroughCache(
  epochs: ReadonlyMap<PersonId, number>,
  entry: CachedIdentityAssertion,
): CacheReadResult {
  if (isCacheEntryStale(epochs, entry)) {
    return { served: false, refused: 'stale-identity-cache' };
  }
  return { served: true, payloadRef: entry.payloadRef };
}

/* ------------------------------------------------------------------ *
 * Shared validation helper for persisted shapes                       *
 * ------------------------------------------------------------------ */

export function assertMergeEventWellFormed(event: MergeEvent): void {
  assertIdentityId(event.tenantId, 'tenantId');
  assertIdentityId(event.eventId, 'eventId');
  if (event.survivorPersonId === event.mergedPersonId) {
    throw new IdentityInvariantError(
      `merge event ${event.eventId} cannot relate a person to themselves`,
    );
  }
  if (!event.decidedBy || !event.rationale) {
    throw new IdentityInvariantError(
      `merge event ${event.eventId} must carry its decision maker and rationale`,
    );
  }
  if (event.kind === 'merge') {
    assertMergeAuthorizationBasis({
      comparedAttributes: event.basisAttributes,
      decidedBy: event.decidedBy,
    });
    const vocabulary: readonly string[] = identityMatchAttributes;
    const unknown = event.basisAttributes.filter((attribute) => !vocabulary.includes(attribute));
    if (unknown.length > 0) {
      throw new IdentityInvariantError(
        `merge event ${event.eventId} carries unknown basis attributes: ${unknown.join(', ')}`,
      );
    }
  }
  if (event.kind === 'unmerge' && !event.reversesEventId) {
    throw new IdentityInvariantError(
      `unmerge event ${event.eventId} must name the merge event it reverses`,
    );
  }
}
