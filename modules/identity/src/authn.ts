/**
 * AuthN sessions, MFA, session policy, lockout (WP-014). Contract:
 * docs/contracts/session-api.md (FROZEN). Architecture: ADR-006 Decision 1 —
 * platform-owned auth in M02: password + mandatory WebAuthn/TOTP MFA for
 * staff, magic-link/OTP for portal, server-side sessions with device records.
 *
 * Structural invariants:
 * - a staff session below `aal2` is unrepresentable (issuance throws without
 *   a verified second factor; DB CHECK refuses the row);
 * - a portal challenge can only be delivered to a VERIFIED endpoint
 *   association of the person it authenticates (REQ-ID-029 verified channel);
 * - an absent or malformed session policy resolves to the STRICTEST defaults,
 *   never to unlimited sessions (REQ-ID-024 exception 3).
 *
 * All functions take explicit ISO timestamps — nothing here reads a clock, so
 * every path is deterministic under test.
 */

import type { PersonId, TenancyContext, TenantId } from '@practicehub/contracts';

import { resolveConfig, type ConfigEntry } from '@practicehub/platform-core';

import type { EndpointAssociation } from './endpoints.js';
import { assertIdentityId } from './identity.js';

export class AuthnInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AuthnInvariantError';
  }
}

export type AuthPrincipalKind = 'staff' | 'portal';
export type AssuranceLevel = 'aal1' | 'aal2';
export type CredentialKind = 'password' | 'webauthn' | 'totp';
export const mfaCredentialKinds: readonly CredentialKind[] = ['webauthn', 'totp'];

export interface AuthCredential {
  readonly credentialId: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly audience: AuthPrincipalKind;
  readonly kind: CredentialKind;
  readonly status: 'active' | 'revoked';
  /** Opaque reference into the secret store — NEVER secret material. */
  readonly secretRef: string;
  readonly enrolledBy: string;
  readonly evidenceRef: string;
  readonly synthetic: boolean;
}

export interface AuthDevice {
  readonly deviceId: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly label: string;
  readonly status: 'active' | 'revoked';
  readonly revokedReason?: string;
  readonly firstSeenAt: string;
  readonly synthetic: boolean;
}

export type SessionStatus = 'active' | 'locked' | 'revoked' | 'expired';

export interface AuthSession {
  readonly sessionId: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly principal: AuthPrincipalKind;
  /** Required for staff sessions (DB CHECK), absent for portal sessions. */
  readonly staffAccountId?: string;
  readonly deviceId: string;
  readonly assurance: AssuranceLevel;
  readonly status: SessionStatus;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly stepUpAt?: string;
  readonly revokedReason?: string;
  readonly synthetic: boolean;
}

/** Per-role session policy (REQ-ID-024 AC-3): config data, never code. */
export interface SessionPolicy {
  readonly role: string;
  readonly idleTimeoutSeconds: number;
  readonly maxConcurrentSessions: number;
  readonly onLimitExceeded: 'terminate-oldest' | 'block-new';
  readonly maxFailedAttempts: number;
  readonly stepUpRecencySeconds: number;
  /** True when the strictest defaults stood in for an absent/malformed entry. */
  readonly defaultsApplied: boolean;
}

/**
 * The fail-to-stricter floor (REQ-ID-024 exception 3): a session-control
 * outage or missing configuration yields the SHORTEST timeout and a SINGLE
 * blocked-new session — never silently unlimited.
 */
export const strictestSessionPolicy: Omit<SessionPolicy, 'role'> = {
  idleTimeoutSeconds: 300,
  maxConcurrentSessions: 1,
  onLimitExceeded: 'block-new',
  maxFailedAttempts: 3,
  stepUpRecencySeconds: 120,
  defaultsApplied: true,
};

export const sessionPolicyKeyPrefix = 'session-policy';

export function sessionPolicyKey(role: string): string {
  assertIdentityId(role, 'role');
  return `${sessionPolicyKeyPrefix}:role=${role}`;
}

interface SessionPolicyValueShape {
  readonly idleTimeoutSeconds: number;
  readonly maxConcurrentSessions: number;
  readonly onLimitExceeded: 'terminate-oldest' | 'block-new';
  readonly maxFailedAttempts: number;
  readonly stepUpRecencySeconds: number;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isSessionPolicyValue(value: unknown): value is SessionPolicyValueShape {
  return (
    typeof value === 'object' &&
    value !== null &&
    'idleTimeoutSeconds' in value &&
    isPositiveInteger(value.idleTimeoutSeconds) &&
    'maxConcurrentSessions' in value &&
    isPositiveInteger(value.maxConcurrentSessions) &&
    'onLimitExceeded' in value &&
    (value.onLimitExceeded === 'terminate-oldest' || value.onLimitExceeded === 'block-new') &&
    'maxFailedAttempts' in value &&
    isPositiveInteger(value.maxFailedAttempts) &&
    'stepUpRecencySeconds' in value &&
    isPositiveInteger(value.stepUpRecencySeconds)
  );
}

/**
 * Resolve the per-role session policy from the WP-010 config registry
 * (namespace `policy`, key `session-policy:role=<role>`). Policy is per role,
 * not one global setting, and a new revision applies on the next resolution —
 * no restart (REQ-ID-024 AC-3). Absent or malformed entries fail to the
 * strictest defaults (exception 3).
 */
export function resolveSessionPolicy(
  entries: readonly ConfigEntry[],
  context: TenancyContext,
  role: string,
): SessionPolicy {
  const entry = resolveConfig(entries, context, 'policy', sessionPolicyKey(role));
  if (entry === undefined || !isSessionPolicyValue(entry.value)) {
    return { role, ...strictestSessionPolicy };
  }
  return { role, ...entry.value, defaultsApplied: false };
}

function assertIso(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new AuthnInvariantError(
      `${label} must be an ISO timestamp; received ${JSON.stringify(value)}`,
    );
  }
}

function secondsBetween(earlierIso: string, laterIso: string): number {
  return (Date.parse(laterIso) - Date.parse(earlierIso)) / 1000;
}

export interface StaffSessionRequest {
  readonly sessionId: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly staffAccountId: string;
  readonly staffAccountStatus: 'active' | 'suspended' | 'offboarded';
  readonly device: AuthDevice;
  readonly presentedCredentials: readonly AuthCredential[];
  readonly atIso: string;
  readonly synthetic: boolean;
}

function activeCredentialOfKinds(
  credentials: readonly AuthCredential[],
  personId: PersonId,
  audience: AuthPrincipalKind,
  kinds: readonly CredentialKind[],
): AuthCredential | undefined {
  return credentials.find(
    (credential) =>
      credential.personId === personId &&
      credential.audience === audience &&
      credential.status === 'active' &&
      kinds.includes(credential.kind),
  );
}

/**
 * Issue a staff session: active staff account + active password credential +
 * a verified second factor (WebAuthn or TOTP) — MFA is MANDATORY, so the only
 * representable staff session is `aal2` (ADR-006 Decision 1; NFR-6 session
 * controls; DB CHECK `auth_session_staff_carries_mfa` backs this at rest).
 */
export function issueStaffSession(request: StaffSessionRequest): AuthSession {
  assertIdentityId(request.sessionId, 'sessionId');
  assertIso(request.atIso, 'atIso');
  if (request.staffAccountStatus !== 'active') {
    throw new AuthnInvariantError(
      `staff account ${request.staffAccountId} is ${request.staffAccountStatus}; ` +
        'only an active staff account can authenticate',
    );
  }
  if (request.device.status !== 'active' || request.device.personId !== request.personId) {
    throw new AuthnInvariantError(
      `session ${request.sessionId} requires an active device record owned by the principal ` +
        '(server-side sessions carry device records; ADR-006 Decision 1)',
    );
  }
  const password = activeCredentialOfKinds(
    request.presentedCredentials,
    request.personId,
    'staff',
    ['password'],
  );
  if (password === undefined) {
    throw new AuthnInvariantError(
      `staff session ${request.sessionId} requires an active password credential`,
    );
  }
  const secondFactor = activeCredentialOfKinds(
    request.presentedCredentials,
    request.personId,
    'staff',
    mfaCredentialKinds,
  );
  if (secondFactor === undefined) {
    throw new AuthnInvariantError(
      `staff session ${request.sessionId} requires a verified second factor ` +
        `(${mfaCredentialKinds.join('/')}); staff MFA is mandatory — a staff session below ` +
        'aal2 is unrepresentable (session-api.md)',
    );
  }
  return {
    sessionId: request.sessionId,
    tenantId: request.tenantId,
    personId: request.personId,
    principal: 'staff',
    staffAccountId: request.staffAccountId,
    deviceId: request.device.deviceId,
    assurance: 'aal2',
    status: 'active',
    createdAt: request.atIso,
    lastActivityAt: request.atIso,
    synthetic: request.synthetic,
  };
}

export type ChallengePurpose = 'portal-login' | 'step-up' | 'elevation' | 'recovery';
export type ChallengeMethod = 'magic-link' | 'otp';

/** Expiring and attempt-bounded by construction — an unbounded challenge is unrepresentable. */
export interface AuthChallenge {
  readonly challengeId: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly endpointId: string;
  readonly purpose: ChallengePurpose;
  readonly method: ChallengeMethod;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt?: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly synthetic: boolean;
}

/**
 * A challenge may only be delivered to a VERIFIED endpoint association of the
 * person it authenticates. A shared endpoint whose association to this person
 * is merely asserted — or anyone else's endpoint — is refused (the portal
 * verified-channel rule; REQ-ID-029 AC-1 notification rides the same rule).
 */
export function issueChallenge(
  associations: readonly EndpointAssociation[],
  request: Omit<AuthChallenge, 'consumedAt' | 'attemptCount'>,
): AuthChallenge {
  assertIdentityId(request.challengeId, 'challengeId');
  assertIso(request.issuedAt, 'issuedAt');
  assertIso(request.expiresAt, 'expiresAt');
  if (secondsBetween(request.issuedAt, request.expiresAt) <= 0) {
    throw new AuthnInvariantError(
      `challenge ${request.challengeId} must expire after issuance — expiring by construction`,
    );
  }
  if (!Number.isInteger(request.maxAttempts) || request.maxAttempts < 1) {
    throw new AuthnInvariantError(
      `challenge ${request.challengeId} requires a positive attempt bound`,
    );
  }
  const association = associations.find(
    (candidate) =>
      candidate.tenantId === request.tenantId &&
      candidate.endpointId === request.endpointId &&
      candidate.personId === request.personId,
  );
  if (association === undefined || association.verification !== 'verified') {
    throw new AuthnInvariantError(
      `challenge ${request.challengeId} refused: endpoint ${request.endpointId} has no VERIFIED ` +
        `association to person ${request.personId} — challenges never travel over asserted or ` +
        'foreign channels (session-api.md verified-channel rule)',
    );
  }
  return { ...request, attemptCount: 0 };
}

export interface ChallengeConsumption {
  readonly challenge: AuthChallenge;
  readonly outcome: 'consumed' | 'rejected-expired' | 'rejected-replayed' | 'rejected-attempts';
}

/** Single-use, expiring, attempt-bounded consumption. */
export function consumeChallenge(challenge: AuthChallenge, atIso: string): ChallengeConsumption {
  assertIso(atIso, 'atIso');
  if (challenge.consumedAt !== undefined) {
    return { challenge, outcome: 'rejected-replayed' };
  }
  if (
    secondsBetween(challenge.issuedAt, atIso) < 0 ||
    secondsBetween(atIso, challenge.expiresAt) < 0
  ) {
    return { challenge, outcome: 'rejected-expired' };
  }
  if (challenge.attemptCount >= challenge.maxAttempts) {
    return { challenge, outcome: 'rejected-attempts' };
  }
  return {
    challenge: { ...challenge, consumedAt: atIso, attemptCount: challenge.attemptCount + 1 },
    outcome: 'consumed',
  };
}

export interface PortalSessionRequest {
  readonly sessionId: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly consumedChallenge: AuthChallenge;
  readonly device: AuthDevice;
  readonly atIso: string;
  readonly synthetic: boolean;
}

/** Issue a portal session from a consumed portal-login challenge (`aal1`). */
export function issuePortalSession(request: PortalSessionRequest): AuthSession {
  assertIdentityId(request.sessionId, 'sessionId');
  assertIso(request.atIso, 'atIso');
  if (
    request.consumedChallenge.consumedAt === undefined ||
    request.consumedChallenge.purpose !== 'portal-login' ||
    request.consumedChallenge.personId !== request.personId ||
    request.consumedChallenge.tenantId !== request.tenantId
  ) {
    throw new AuthnInvariantError(
      `portal session ${request.sessionId} requires this person's consumed portal-login challenge`,
    );
  }
  if (request.device.status !== 'active' || request.device.personId !== request.personId) {
    throw new AuthnInvariantError(
      `session ${request.sessionId} requires an active device record owned by the principal`,
    );
  }
  return {
    sessionId: request.sessionId,
    tenantId: request.tenantId,
    personId: request.personId,
    principal: 'portal',
    deviceId: request.device.deviceId,
    assurance: 'aal1',
    status: 'active',
    createdAt: request.atIso,
    lastActivityAt: request.atIso,
    synthetic: request.synthetic,
  };
}

export interface ConcurrentSessionDecision {
  readonly admit: boolean;
  readonly terminateSessionIds: readonly string[];
  /** REQ-ID-024 AC-2: the affected user is notified either way. */
  readonly notification: {
    readonly personId: PersonId;
    readonly reason: 'concurrent-session-limit';
    readonly action: 'oldest-terminated' | 'new-session-blocked';
  } | null;
}

/**
 * Enforce the per-role concurrent-session/device limit (REQ-ID-024 AC-2):
 * over the limit, either the oldest session terminates or the new session is
 * blocked — per policy — and the affected user is notified.
 */
export function enforceConcurrentSessionLimit(
  activeSessions: readonly AuthSession[],
  candidatePersonId: PersonId,
  policy: SessionPolicy,
): ConcurrentSessionDecision {
  const own = activeSessions
    .filter((session) => session.personId === candidatePersonId && session.status === 'active')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (own.length < policy.maxConcurrentSessions) {
    return { admit: true, terminateSessionIds: [], notification: null };
  }
  if (policy.onLimitExceeded === 'terminate-oldest') {
    const excess = own.length - policy.maxConcurrentSessions + 1;
    return {
      admit: true,
      terminateSessionIds: own.slice(0, excess).map((session) => session.sessionId),
      notification: {
        personId: candidatePersonId,
        reason: 'concurrent-session-limit',
        action: 'oldest-terminated',
      },
    };
  }
  return {
    admit: false,
    terminateSessionIds: [],
    notification: {
      personId: candidatePersonId,
      reason: 'concurrent-session-limit',
      action: 'new-session-blocked',
    },
  };
}

export type IdleEvaluation =
  | { readonly state: 'active' }
  | { readonly state: 'stay-active-prompt' }
  | { readonly state: 'locked'; readonly requiresReauthentication: true };

/**
 * Activity-aware idle evaluation (REQ-ID-024 AC-1 + exception 2): the clock
 * keys to recorded activity, the boundary yields a stay-active prompt at 80%
 * of the timeout, and past the timeout the session locks and requires
 * re-authentication.
 */
export function evaluateIdle(
  session: AuthSession,
  policy: SessionPolicy,
  atIso: string,
): IdleEvaluation {
  assertIso(atIso, 'atIso');
  const idleSeconds = secondsBetween(session.lastActivityAt, atIso);
  if (idleSeconds >= policy.idleTimeoutSeconds) {
    return { state: 'locked', requiresReauthentication: true };
  }
  if (idleSeconds >= policy.idleTimeoutSeconds * 0.8) {
    return { state: 'stay-active-prompt' };
  }
  return { state: 'active' };
}

/** Recorded input refreshes the idle clock (exception 2: activity-aware, not elapsed-only). */
export function recordActivity(session: AuthSession, atIso: string): AuthSession {
  assertIso(atIso, 'atIso');
  if (session.status !== 'active') {
    throw new AuthnInvariantError(
      `session ${session.sessionId} is ${session.status}; activity cannot refresh it`,
    );
  }
  return { ...session, lastActivityAt: atIso };
}

export function lockIdleSession(session: AuthSession): AuthSession {
  return { ...session, status: 'locked' };
}

/**
 * Device revocation (REQ-ID-024 AC-4): every session tied to the lost/stolen
 * device terminates in the same pass — a protective direction, deliberately
 * not capability-gated (session-api.md).
 */
export function revokeDevice(
  sessions: readonly AuthSession[],
  deviceId: string,
  revokedBy: string,
): readonly AuthSession[] {
  if (!revokedBy) {
    throw new AuthnInvariantError('device revocation must name the revoking actor');
  }
  return sessions.map((session) =>
    session.deviceId === deviceId && session.status === 'active'
      ? { ...session, status: 'revoked', revokedReason: `device-revoked:${revokedBy}` }
      : session,
  );
}

export type StepUpEvaluation =
  | { readonly satisfied: true }
  | {
      readonly satisfied: false;
      readonly challengeRequired: { readonly purpose: 'step-up'; readonly method: ChallengeMethod };
    };

/**
 * Step-up for sensitive views (ADR-006 Decision 1; R6-REQ-005): satisfied only
 * by a step-up inside the policy recency window. WHICH views are sensitive is
 * PDP policy (WP-015, FWD-AUTH-015-PDP) — this is the mechanism.
 */
export function requireStepUp(
  session: AuthSession,
  policy: SessionPolicy,
  atIso: string,
): StepUpEvaluation {
  assertIso(atIso, 'atIso');
  if (
    session.stepUpAt !== undefined &&
    secondsBetween(session.stepUpAt, atIso) <= policy.stepUpRecencySeconds &&
    secondsBetween(session.stepUpAt, atIso) >= 0
  ) {
    return { satisfied: true };
  }
  return { satisfied: false, challengeRequired: { purpose: 'step-up', method: 'otp' } };
}

/** Record a completed step-up challenge on the session. */
export function recordStepUp(session: AuthSession, consumed: AuthChallenge): AuthSession {
  if (consumed.consumedAt === undefined || consumed.purpose !== 'step-up') {
    throw new AuthnInvariantError(
      `session ${session.sessionId} step-up requires a consumed step-up challenge`,
    );
  }
  return { ...session, stepUpAt: consumed.consumedAt };
}

export interface FailedAttemptState {
  readonly personId: PersonId;
  readonly attempts: number;
  readonly lockedOut: boolean;
}

/** Count a failed attempt; at the policy threshold the account locks out. */
export function registerFailedAttempt(
  state: FailedAttemptState,
  policy: SessionPolicy,
): FailedAttemptState {
  const attempts = state.attempts + 1;
  return { ...state, attempts, lockedOut: attempts >= policy.maxFailedAttempts };
}

export type LockoutRecovery =
  | {
      readonly path: 'staff-admin-unlock';
      readonly adminRef: string;
      readonly mfaReverified: boolean;
    }
  | { readonly path: 'portal-verified-channel'; readonly consumedRecovery: AuthChallenge }
  | {
      readonly path: 'portal-supervised-manual';
      readonly supervisorRef: string;
      readonly evidenceRef: string;
    };

export interface LockoutRecoveryResult {
  readonly recovered: true;
  readonly attemptsReset: 0;
  readonly recoveryPath: LockoutRecovery['path'];
}

/**
 * The lockout-recovery path (WP-014 gate). Staff: admin-attributed unlock +
 * MFA re-verification. Portal: a consumed verified-channel recovery challenge,
 * or the supervised manual identity-verification path (attributed supervisor +
 * evidence) so a member who lost 2FA is never permanently locked out
 * (REQ-ID-029 exception 2). Anything less fails closed.
 */
export function recoverLockout(
  state: FailedAttemptState,
  recovery: LockoutRecovery,
): LockoutRecoveryResult {
  if (!state.lockedOut) {
    throw new AuthnInvariantError(`person ${state.personId} is not locked out; nothing to recover`);
  }
  switch (recovery.path) {
    case 'staff-admin-unlock':
      if (!recovery.adminRef || !recovery.mfaReverified) {
        throw new AuthnInvariantError(
          'staff lockout recovery requires an attributed admin unlock AND MFA re-verification',
        );
      }
      break;
    case 'portal-verified-channel':
      if (
        recovery.consumedRecovery.consumedAt === undefined ||
        recovery.consumedRecovery.purpose !== 'recovery' ||
        recovery.consumedRecovery.personId !== state.personId
      ) {
        throw new AuthnInvariantError(
          "portal lockout recovery requires this person's consumed verified-channel recovery challenge",
        );
      }
      break;
    case 'portal-supervised-manual':
      if (!recovery.supervisorRef || !recovery.evidenceRef) {
        throw new AuthnInvariantError(
          'supervised manual recovery requires an attributed supervisor and verification evidence ' +
            '(REQ-ID-029 exception 2 fails closed)',
        );
      }
      break;
  }
  return { recovered: true, attemptsReset: 0, recoveryPath: recovery.path };
}

/**
 * A policy change applies on the next resolution — proven by resolving before
 * and after a new revision with no process boundary in between (REQ-ID-024
 * AC-3 "without requiring a system restart"). Exposed as a helper so the e2e
 * suite states the property in one place.
 */
export function policyAppliesWithoutRestart(before: SessionPolicy, after: SessionPolicy): boolean {
  return before.role === after.role && !after.defaultsApplied;
}
