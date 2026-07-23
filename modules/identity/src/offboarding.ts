/**
 * Staff offboarding atomicity (WP-017, M02). Contract:
 * docs/contracts/elevation-api.md (FROZEN). Requirements: REQ-ID-025 (unified
 * staff offboarding — accounts, threads, on-call, panels), REQ-ID-028 (abrupt
 * provider departure — emergency credential, session, and EPCS-token
 * revocation).
 *
 * ADR-006 Decision 5: ONE command revokes sessions/tokens/grants, reassigns
 * owned work items + on-call slots via context packages, and records evidence.
 * The atomicity is FAIL-CLOSED: every owned work item must have a reassignment
 * target carrying a context package, or the whole offboarding throws — an
 * offboarding that leaves orphaned work (or an abrupt departure that leaves an
 * EPCS token live) is unrepresentable. Offboarding is authority-REDUCING and
 * is deliberately NOT capability-gated (WP-012 lesson: protective/safety
 * directions are never gate-blocked).
 */

import type { PersonId, TenantId } from '@practicehub/contracts';

import type { AuthSession } from './authn.js';
import {
  ElevationError,
  assertId,
  assertInstant,
  assertRef,
  configChangeAuditInput,
  type ElevationConfigAuditInput,
} from './elevation-shared.js';

export const offboardingKinds = ['planned', 'abrupt-departure'] as const;
export type OffboardingKind = (typeof offboardingKinds)[number];

/** What an offboarding revokes. `epcs-token` is the EPCS 2FA prescribing token (REQ-ID-028). */
export const revocableScopes = [
  'sessions',
  'credentials',
  'role-grants',
  'epcs-token',
  'device-tokens',
  'on-call-slots',
] as const;
export type RevocableScope = (typeof revocableScopes)[number];

/** The mandatory revocations per kind (structural floor, mirrored by a DB CHECK). */
const abruptDepartureFloor: readonly RevocableScope[] = ['sessions', 'credentials', 'epcs-token'];
const plannedFloor: readonly RevocableScope[] = ['sessions', 'role-grants'];

export const ownedWorkKinds = ['thread', 'on-call-slot', 'panel', 'task'] as const;
export type OwnedWorkKind = (typeof ownedWorkKinds)[number];

/** An owned work item the departing member is accountable for (must be reassigned). */
export interface OwnedWorkRef {
  readonly ownedRef: string;
  readonly ownedKind: OwnedWorkKind;
}

/** A reassignment target for an owned item — carries a context package (REQ-TASK-029). */
export interface ReassignmentTarget {
  readonly ownedRef: string;
  readonly toOwnerRef: string;
  readonly contextPackageRef: string;
}

export interface OffboardingRequest {
  readonly tenantId: TenantId;
  readonly offboardingId: string;
  readonly staffAccountId: string;
  readonly staffPersonId: PersonId;
  readonly kind: OffboardingKind;
  readonly reasonRef: string;
  readonly executedBy: string;
  readonly occurredAt: string;
  /** Whether the departing member held an EPCS prescribing token. */
  readonly hasEpcsToken: boolean;
  /** All active sessions across the tenant; the person's are revoked. */
  readonly activeSessions: readonly AuthSession[];
  /** Every owned work item the member is accountable for. */
  readonly ownedWork: readonly OwnedWorkRef[];
  /** One target per owned item; a missing/contextless target fails the offboarding. */
  readonly reassignmentTargets: readonly ReassignmentTarget[];
}

export interface OffboardingReassignment {
  readonly tenantId: TenantId;
  readonly offboardingId: string;
  readonly reassignmentId: string;
  readonly ownedRef: string;
  readonly ownedKind: OwnedWorkKind;
  readonly toOwnerRef: string;
  readonly contextPackageRef: string;
  readonly synthetic: true;
}

export interface OffboardingCase {
  readonly tenantId: TenantId;
  readonly offboardingId: string;
  readonly staffAccountId: string;
  readonly staffPersonId: PersonId;
  readonly kind: OffboardingKind;
  readonly reasonRef: string;
  readonly revokedScopes: readonly RevocableScope[];
  readonly executedBy: string;
  readonly executedAt: string;
  readonly synthetic: true;
}

export interface OffboardingResult {
  readonly case: OffboardingCase;
  /** The person's active sessions, all revoked (authority-reducing). */
  readonly revokedSessions: readonly AuthSession[];
  /** One reassignment per owned item — zero orphaned work by construction. */
  readonly reassignments: readonly OffboardingReassignment[];
  readonly auditInput: ElevationConfigAuditInput;
}

function requiredScopesFor(
  kind: OffboardingKind,
  hasEpcsToken: boolean,
): readonly RevocableScope[] {
  if (kind !== 'abrupt-departure') {
    return plannedFloor;
  }
  // An abrupt departure always revokes sessions + credentials; the EPCS token
  // is revoked only if the member held one (REQ-ID-028) — but if they did, its
  // revocation is mandatory (never left live).
  return hasEpcsToken ? abruptDepartureFloor : ['sessions', 'credentials'];
}

/**
 * Execute an atomic offboarding (REQ-ID-025 / REQ-ID-028). Revokes every active
 * session of the departing member, records the revoked scopes (with the
 * per-kind mandatory floor), and reassigns EVERY owned work item to a target
 * carrying a context package. Fails closed — before producing anything — if an
 * owned item has no reassignment target, a target has no context package, a
 * target references an unknown owned item, or the mandatory scope floor is not
 * met. "Zero orphaned grants/work" is therefore a construction property, not a
 * runtime hope.
 */
export function executeOffboarding(request: OffboardingRequest): OffboardingResult {
  assertId(request.offboardingId, 'offboardingId');
  assertRef(request.staffAccountId, 'staffAccountId');
  assertRef(request.reasonRef, 'reasonRef');
  assertRef(request.executedBy, 'executedBy');
  assertInstant(request.occurredAt, 'occurredAt');

  const ownedRefs = new Set(request.ownedWork.map((item) => item.ownedRef));
  if (ownedRefs.size !== request.ownedWork.length) {
    throw new ElevationError(
      `offboarding ${request.offboardingId} lists a duplicate owned work ref`,
    );
  }
  const targetsByRef = new Map<string, ReassignmentTarget>();
  for (const target of request.reassignmentTargets) {
    if (!ownedRefs.has(target.ownedRef)) {
      throw new ElevationError(
        `offboarding ${request.offboardingId} target references unknown owned item ` +
          JSON.stringify(target.ownedRef),
      );
    }
    if (targetsByRef.has(target.ownedRef)) {
      throw new ElevationError(
        `offboarding ${request.offboardingId} has two targets for ${JSON.stringify(target.ownedRef)}`,
      );
    }
    if (!target.toOwnerRef || !target.contextPackageRef) {
      throw new ElevationError(
        `offboarding ${request.offboardingId} reassignment of ${JSON.stringify(target.ownedRef)} ` +
          'must name a new owner AND carry a context package',
      );
    }
    assertRef(target.toOwnerRef, 'toOwnerRef');
    assertRef(target.contextPackageRef, 'contextPackageRef');
    targetsByRef.set(target.ownedRef, target);
  }

  const reassignments: OffboardingReassignment[] = request.ownedWork.map((item, index) => {
    const target = targetsByRef.get(item.ownedRef);
    if (target === undefined) {
      throw new ElevationError(
        `offboarding ${request.offboardingId} leaves orphaned work: ${JSON.stringify(item.ownedRef)} ` +
          'has no reassignment target (zero-orphaned invariant)',
      );
    }
    return {
      tenantId: request.tenantId,
      offboardingId: request.offboardingId,
      reassignmentId: `${request.offboardingId}-ra-${index}`,
      ownedRef: item.ownedRef,
      ownedKind: item.ownedKind,
      toOwnerRef: target.toOwnerRef,
      contextPackageRef: target.contextPackageRef,
      synthetic: true,
    };
  });

  const revokedSessions = request.activeSessions
    .filter((session) => session.personId === request.staffPersonId && session.status === 'active')
    .map((session) => ({
      ...session,
      status: 'revoked' as const,
      revokedReason: `offboarding:${request.offboardingId}`,
    }));

  const required = requiredScopesFor(request.kind, request.hasEpcsToken);
  const revokedScopeSet = new Set<RevocableScope>(required);
  // On-call and panel reassignments imply an on-call-slots revocation was part
  // of the atomic act (REQ-ID-025 covers on-call + panels).
  if (request.ownedWork.some((item) => item.ownedKind === 'on-call-slot')) {
    revokedScopeSet.add('on-call-slots');
  }
  revokedScopeSet.add('device-tokens');
  const revokedScopes = [...revokableOrder(revokedScopeSet)];

  const offboardingCase: OffboardingCase = {
    tenantId: request.tenantId,
    offboardingId: request.offboardingId,
    staffAccountId: request.staffAccountId,
    staffPersonId: request.staffPersonId,
    kind: request.kind,
    reasonRef: request.reasonRef,
    revokedScopes,
    executedBy: request.executedBy,
    executedAt: request.occurredAt,
    synthetic: true,
  };

  const auditInput = configChangeAuditInput({
    auditId: `offboarding-${request.offboardingId}`,
    tenantId: request.tenantId,
    action: 'staff-offboarding',
    actorRef: request.executedBy,
    occurredAt: request.occurredAt,
    configRef: `offboarding:${request.offboardingId}`,
    subjectRef: `staff-account:${request.staffAccountId}`,
  });

  return { case: offboardingCase, revokedSessions, reassignments, auditInput };
}

/** Deterministic scope order (declaration order) for a stable evidence record. */
function revokableOrder(scopes: ReadonlySet<RevocableScope>): readonly RevocableScope[] {
  return revocableScopes.filter((scope) => scopes.has(scope));
}
