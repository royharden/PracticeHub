/**
 * Break-glass emergency-access lifecycle (WP-017, M02). Contract:
 * docs/contracts/elevation-api.md (FROZEN). Requirements: REQ-ID-001
 * (break-glass emergency access with mandatory after-the-fact review),
 * REQ-ADM-017 (break-glass GRANT mechanism), R6-REQ-003 (reason captured at
 * time of use + mandatory review task that ages/escalates on a compliance
 * worklist). Executes FWD-PDP-017-BREAKGLASS over the WP-015 purpose hook.
 *
 * ADR-006 Decision 3: break-glass is a TIME-LIMITED, SCOPED, READ-ONLY
 * elevation with a NAMED REASON, AUTO-EXPIRY, and a MANDATORY INDEPENDENT
 * review. It NEVER bypasses consent / partition / deceased egress guards — it
 * widens READ scope past RBAC no-permit only (the WP-015
 * `break-glass-emergency` purpose is the enforcement point; this module is the
 * grant/reason/expiry/review wrapper). Emergency WRITE paths go through normal
 * command authorization with emergency reason codes, never through break-glass
 * (AC-11 deviation): the scope here is segments to READ — there is no action
 * field, so a write elevation is unrepresentable.
 */

import type { PersonId, TenantId } from '@practicehub/contracts';

import type { AccessPartitionTag, DataSegment } from './access-vocabulary.js';
import {
  ElevationError,
  addMinutes,
  assertId,
  assertInstant,
  assertRef,
  instantBefore,
  type AuthorityReviewWorkItem,
} from './elevation-shared.js';
import { breakGlassSeverityFor } from './gipa.js';

/**
 * The reason captured at time of use (R6-REQ-003) — a closed vocabulary so the
 * "named reason" is machine-checkable and PHI-free (the free-text detail, if
 * any, rides `justificationRef` as a grammar-clean pointer, never a column of
 * prose).
 */
export const breakGlassReasonCodes = [
  'emergency-care',
  'patient-safety',
  'coverage-gap',
  'disaster-continuity',
  'urgent-records-request',
] as const;
export type BreakGlassReasonCode = (typeof breakGlassReasonCodes)[number];

export type BreakGlassSeverity = 'standard' | 'elevated-genetic';

/** A break-glass grant reads named segments — read-only by construction (no action field). */
export type BreakGlassScope = readonly DataSegment[];

export interface BreakGlassGrantRequest {
  readonly tenantId: TenantId;
  readonly grantId: string;
  readonly staffAccountId: string;
  /** The workforce member who USES the elevation (the accessor). */
  readonly accessorPersonId: PersonId;
  readonly subjectPersonId: PersonId;
  readonly scope: BreakGlassScope;
  readonly reasonCode: BreakGlassReasonCode;
  /** Grammar-clean pointer to the captured reason narrative (R6-REQ-003). */
  readonly justificationRef: string;
  /** Partition tags of the data reached — drives the elevated-genetic severity. */
  readonly partitionTags?: readonly AccessPartitionTag[];
  /** Attributed initiator ref (who authorized the elevation). */
  readonly initiatedBy: string;
  readonly effectiveAt: string;
  /** Elevation window; the grant auto-expires at effectiveAt + windowMinutes. */
  readonly windowMinutes: number;
  /** After-the-fact review is due this many minutes past expiry (the review clock). */
  readonly reviewWindowMinutes: number;
  /** SLA policy the review WorkItem ages against (WP-022); null → no SLA (sorts below). */
  readonly reviewSlaPolicyId?: string;
  readonly reviewPolicyVersion?: number;
  readonly reviewServiceTier?: string;
}

export interface BreakGlassGrant {
  readonly tenantId: TenantId;
  readonly grantId: string;
  readonly staffAccountId: string;
  readonly accessorPersonId: PersonId;
  readonly subjectPersonId: PersonId;
  readonly scope: BreakGlassScope;
  readonly reasonCode: BreakGlassReasonCode;
  readonly justificationRef: string;
  readonly severity: BreakGlassSeverity;
  readonly initiatedBy: string;
  readonly effectiveAt: string;
  readonly expiresAt: string;
  readonly reviewDueAt: string;
  readonly synthetic: true;
}

/** Break-glass stream audit input (WP-020) — subjectRef + reason are required. */
export interface BreakGlassAuditInput {
  readonly auditId: string;
  readonly tenantId: string;
  readonly stream: 'break-glass';
  readonly action: 'break-glass-grant' | 'break-glass-review';
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly subjectRef: string;
  readonly reason: 'break-glass-emergency' | 'investigation';
  readonly partitionTags?: readonly AccessPartitionTag[];
  readonly detail: { readonly config_ref: string };
  readonly synthetic: true;
}

export const breakGlassIndependentReviewObligation = 'independent-review-required';

export interface BreakGlassGrantOutcome {
  readonly grant: BreakGlassGrant;
  readonly auditInput: BreakGlassAuditInput;
  /** The mandatory after-the-fact review, as a WP-022 WorkItem descriptor. */
  readonly reviewWorkItem: AuthorityReviewWorkItem;
  /** Always carries the independent-review obligation (ADR-006 Decision 3). */
  readonly obligations: readonly [typeof breakGlassIndependentReviewObligation];
}

/**
 * Grant a break-glass elevation (REQ-ID-001 / REQ-ADM-017): scoped READ,
 * named reason captured, auto-expiry, and a mandatory-review WorkItem born
 * with the grant. Fails closed on an empty/oversized scope, a missing reason
 * or justification, a non-positive window, or a malformed instant. The
 * emergency WRITE path is structurally absent (scope has no action). The grant
 * itself is authority-INCREASING and is the gated `grantBreakGlassCommand`
 * path (floored simulated).
 */
export function grantBreakGlass(request: BreakGlassGrantRequest): BreakGlassGrantOutcome {
  assertId(request.grantId, 'grantId');
  assertRef(request.staffAccountId, 'staffAccountId');
  assertRef(request.initiatedBy, 'initiatedBy');
  assertRef(request.justificationRef, 'justificationRef');
  assertInstant(request.effectiveAt, 'effectiveAt');
  if (request.scope.length === 0) {
    throw new ElevationError(
      `break-glass grant ${request.grantId} requires at least one read segment`,
    );
  }
  if (new Set(request.scope).size !== request.scope.length) {
    throw new ElevationError(`break-glass grant ${request.grantId} scope has duplicate segments`);
  }
  if (!Number.isInteger(request.windowMinutes) || request.windowMinutes <= 0) {
    throw new ElevationError(
      `break-glass grant ${request.grantId} window must be a positive integer of minutes`,
    );
  }
  if (!Number.isInteger(request.reviewWindowMinutes) || request.reviewWindowMinutes <= 0) {
    throw new ElevationError(
      `break-glass grant ${request.grantId} review window must be a positive integer of minutes`,
    );
  }
  const expiresAt = addMinutes(request.effectiveAt, request.windowMinutes);
  const reviewDueAt = addMinutes(expiresAt, request.reviewWindowMinutes);
  const partitionTags = request.partitionTags ?? [];
  const severity = breakGlassSeverityFor(partitionTags);

  const grant: BreakGlassGrant = {
    tenantId: request.tenantId,
    grantId: request.grantId,
    staffAccountId: request.staffAccountId,
    accessorPersonId: request.accessorPersonId,
    subjectPersonId: request.subjectPersonId,
    scope: [...request.scope],
    reasonCode: request.reasonCode,
    justificationRef: request.justificationRef,
    severity,
    initiatedBy: request.initiatedBy,
    effectiveAt: request.effectiveAt,
    expiresAt,
    reviewDueAt,
    synthetic: true,
  };

  const auditInput: BreakGlassAuditInput = {
    auditId: `bg-grant-${request.grantId}`,
    tenantId: request.tenantId,
    stream: 'break-glass',
    action: 'break-glass-grant',
    actorRef: request.initiatedBy,
    occurredAt: request.effectiveAt,
    subjectRef: `person:${request.subjectPersonId}`,
    reason: 'break-glass-emergency',
    ...(partitionTags.length > 0 ? { partitionTags: [...partitionTags] } : {}),
    detail: { config_ref: `break-glass-grant:${request.grantId}` },
    synthetic: true,
  };

  // The genetic-touching elevation reviews at CRITICAL risk so it never blends
  // into general break-glass volume (REQ-ID-019 AC-8 severity carried forward).
  const reviewWorkItem: AuthorityReviewWorkItem = {
    workItemId: `bg-review-${request.grantId}`,
    origin: 'authority-review',
    subjectRef: `break-glass-grant:${request.grantId}`,
    purpose: 'break-glass-review',
    risk: severity === 'elevated-genetic' ? 'critical' : 'elevated',
    serviceTier: request.reviewServiceTier ?? 'compliance-review',
    slaPolicyId: request.reviewSlaPolicyId ?? null,
    policyVersion: request.reviewPolicyVersion ?? null,
    responseDueAt: reviewDueAt,
    poolId: 'compliance-privacy-officer',
    openedAt: request.effectiveAt,
  };

  return {
    grant,
    auditInput,
    reviewWorkItem,
    obligations: [breakGlassIndependentReviewObligation],
  };
}

export type BreakGlassStatus = 'active' | 'expired';

/** Auto-expiry (ADR-006 Decision 3): a grant authorizes nothing once now ≥ expiresAt. */
export function breakGlassStatus(grant: BreakGlassGrant, nowIso: string): BreakGlassStatus {
  return instantBefore(nowIso, grant.expiresAt) ? 'active' : 'expired';
}

/**
 * Whether the grant itself widens READ to a segment as-of now — active AND the
 * segment is in scope. This is only the grant-level widening; the actual data
 * decision still runs through the WP-015 PDP with purpose
 * `break-glass-emergency`, which keeps consent / partition / deceased guards
 * live. A grant never authorizes an edit/export (its scope has no action).
 */
export function breakGlassWidensRead(
  grant: BreakGlassGrant,
  segment: DataSegment,
  nowIso: string,
): boolean {
  return breakGlassStatus(grant, nowIso) === 'active' && grant.scope.includes(segment);
}

export const breakGlassReviewOutcomes = [
  'access-appropriate',
  'access-inappropriate-escalate',
] as const;
export type BreakGlassReviewOutcome = (typeof breakGlassReviewOutcomes)[number];

export const breakGlassReviewerRoles = ['compliance-privacy-officer', 'it-security-admin'] as const;
export type BreakGlassReviewerRole = (typeof breakGlassReviewerRoles)[number];

export interface BreakGlassReviewRequest {
  readonly reviewId: string;
  readonly reviewerPersonId: PersonId;
  readonly reviewerRole: BreakGlassReviewerRole;
  readonly outcome: BreakGlassReviewOutcome;
  readonly evidenceRef: string;
  readonly occurredAt: string;
}

export interface BreakGlassReview {
  readonly tenantId: TenantId;
  readonly reviewId: string;
  readonly grantId: string;
  readonly subjectPersonId: PersonId;
  readonly accessorPersonId: PersonId;
  readonly reviewerPersonId: PersonId;
  readonly reviewerRole: BreakGlassReviewerRole;
  readonly outcome: BreakGlassReviewOutcome;
  readonly evidenceRef: string;
  readonly reviewedAt: string;
  readonly synthetic: true;
}

export interface BreakGlassReviewOutcomeResult {
  readonly review: BreakGlassReview;
  readonly auditInput: BreakGlassAuditInput;
  /** An inappropriate access spawns a containment follow-up (WP-022 descriptor). */
  readonly escalation: AuthorityReviewWorkItem | null;
}

/**
 * Complete the mandatory after-the-fact review (REQ-ID-001 / R6-REQ-003). The
 * reviewer is INDEPENDENT: the review fails closed if the reviewer is the
 * accessor (separation of duties, mirrored by a DB CHECK), and evidence is
 * mandatory. An `access-inappropriate-escalate` outcome opens a containment
 * follow-up WorkItem.
 */
export function completeBreakGlassReview(
  grant: BreakGlassGrant,
  request: BreakGlassReviewRequest,
): BreakGlassReviewOutcomeResult {
  assertId(request.reviewId, 'reviewId');
  assertRef(request.evidenceRef, 'evidenceRef');
  assertInstant(request.occurredAt, 'occurredAt');
  if (request.reviewerPersonId === grant.accessorPersonId) {
    throw new ElevationError(
      `break-glass review ${request.reviewId} must be independent: the reviewer cannot be the ` +
        'accessor who used the elevation (separation of duties)',
    );
  }
  const review: BreakGlassReview = {
    tenantId: grant.tenantId,
    reviewId: request.reviewId,
    grantId: grant.grantId,
    subjectPersonId: grant.subjectPersonId,
    accessorPersonId: grant.accessorPersonId,
    reviewerPersonId: request.reviewerPersonId,
    reviewerRole: request.reviewerRole,
    outcome: request.outcome,
    evidenceRef: request.evidenceRef,
    reviewedAt: request.occurredAt,
    synthetic: true,
  };
  const auditInput: BreakGlassAuditInput = {
    auditId: `bg-review-${request.reviewId}`,
    tenantId: grant.tenantId,
    stream: 'break-glass',
    action: 'break-glass-review',
    actorRef: `person:${request.reviewerPersonId}`,
    occurredAt: request.occurredAt,
    subjectRef: `person:${grant.subjectPersonId}`,
    reason: 'investigation',
    detail: { config_ref: `break-glass-review:${request.reviewId}` },
    synthetic: true,
  };
  const escalation: AuthorityReviewWorkItem | null =
    request.outcome === 'access-inappropriate-escalate'
      ? {
          workItemId: `bg-escalation-${request.reviewId}`,
          origin: 'authority-review',
          subjectRef: `break-glass-grant:${grant.grantId}`,
          purpose: 'break-glass-inappropriate-access-containment',
          risk: grant.severity === 'elevated-genetic' ? 'critical' : 'urgent',
          serviceTier: 'security-investigation',
          slaPolicyId: null,
          policyVersion: null,
          responseDueAt: null,
          poolId: 'it-security-admin',
          openedAt: request.occurredAt,
        }
      : null;
  return { review, auditInput, escalation };
}
