/**
 * Portal account-takeover machinery (WP-014, REQ-ID-029). Contract:
 * docs/contracts/session-api.md (FROZEN).
 *
 * Detection HEURISTICS are WP-017 scope (REQ-ID-002; FWD-AUTH-017-ANOMALY) —
 * this module is what fires when a signal arrives: lockdown (sessions
 * revoked, high-risk actions frozen), verified-channel notification with the
 * compromised-channel fallback, proportional restoration, cohort-wide
 * protections, and a tuning surface that can never disable protection. The
 * drill chain over this machinery is WP-099 (FWD-AUTH-099-ATO-DRILLS).
 */

import type { PersonId, TenantId } from '@practicehub/contracts';

import { revokeDevice, AuthnInvariantError, type AuthSession } from './authn.js';
import type { EndpointAssociation } from './endpoints.js';

export type AtoSignalKind =
  | 'impossible-travel'
  | 'mass-failed-logins'
  | 'new-device-burst'
  | 'credential-stuffing'
  | 'device-reported-lost';

export interface AtoSignal {
  readonly kind: AtoSignalKind;
  readonly detail: string;
  readonly observedAt: string;
}

export type AtoRiskLevel = 'moderate' | 'high';

export type RestorationRequirement = 'step-up' | 're-identity-proofing';

/**
 * Restoration is proportional to the risk signal (REQ-ID-029 AC-2): moderate
 * risk re-enters through step-up; high risk requires re-identity-proofing
 * through the WP-013 `IdentityProofingPort`.
 */
export function restorationRequirement(risk: AtoRiskLevel): RestorationRequirement {
  return risk === 'high' ? 're-identity-proofing' : 'step-up';
}

const highRiskSignals: readonly AtoSignalKind[] = ['credential-stuffing', 'impossible-travel'];

/** Risk classification of a signal set: any high-risk signal raises the whole case. */
export function classifyAtoRisk(signals: readonly AtoSignal[]): AtoRiskLevel {
  return signals.some((signal) => highRiskSignals.includes(signal.kind)) ? 'high' : 'moderate';
}

export type LockdownTrigger = 'failed-attempts' | 'ato-suspicion' | 'device-lost' | 'admin';

export interface AccountLockdown {
  readonly lockdownId: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly trigger: LockdownTrigger;
  /** The triggering signals verbatim — the forensic record (AC-3). */
  readonly signals: readonly AtoSignal[];
  readonly highRiskActionsFrozen: true;
  readonly releaseRequirement: RestorationRequirement | 'supervised-manual';
  readonly status: 'active' | 'released';
  readonly releasedBy?: string;
  readonly releasedEvidenceRef?: string;
  readonly synthetic: boolean;
}

export interface AtoNotificationDirective {
  readonly personId: PersonId;
  readonly endpointId: string;
  readonly channelBasis: 'verified' | 'prior-verified-fallback';
  /** Exception 1: a contact change inside the incident is evidence, not a channel. */
  readonly contactChangeTreatedAsIncident: boolean;
}

/**
 * Choose the notification channel (REQ-ID-029 AC-1 + exception 1): a VERIFIED
 * association of this person, skipping any endpoint whose association arrived
 * inside the incident window (`recentlyChangedEndpointIds`) — if the attacker
 * changed the email/phone, notification falls back to a prior-verified channel
 * and the change itself becomes part of the incident. No verified channel at
 * all fails closed.
 */
export function selectNotificationChannel(
  associations: readonly EndpointAssociation[],
  personId: PersonId,
  recentlyChangedEndpointIds: readonly string[],
): AtoNotificationDirective {
  const verified = associations.filter(
    (association) => association.personId === personId && association.verification === 'verified',
  );
  if (verified.length === 0) {
    throw new AuthnInvariantError(
      `person ${personId} has no verified channel; ATO notification fails closed — ` +
        'route to the supervised manual path',
    );
  }
  const trusted = verified.filter(
    (association) => !recentlyChangedEndpointIds.includes(association.endpointId),
  );
  if (trusted.length === 0) {
    throw new AuthnInvariantError(
      `person ${personId} has only incident-window channels; ATO notification fails closed — ` +
        'route to the supervised manual path',
    );
  }
  const suspicious = trusted.length < verified.length;
  const channel = trusted[0];
  if (channel === undefined) {
    throw new AuthnInvariantError('unreachable: trusted channel list is non-empty');
  }
  return {
    personId,
    endpointId: channel.endpointId,
    channelBasis: suspicious ? 'prior-verified-fallback' : 'verified',
    contactChangeTreatedAsIncident: suspicious,
  };
}

export interface AtoLockdownResult {
  readonly lockdown: AccountLockdown;
  readonly sessions: readonly AuthSession[];
  readonly notification: AtoNotificationDirective;
}

/**
 * Fire the lockdown (REQ-ID-029 AC-1/AC-3): every active session for the
 * person revokes, high-risk actions freeze, the triggering signals are
 * recorded verbatim on the case, and the member is notified over a verified
 * channel with the exception-1 fallback.
 */
export function raiseAtoLockdown(
  lockdownId: string,
  tenantId: TenantId,
  personId: PersonId,
  signals: readonly AtoSignal[],
  sessions: readonly AuthSession[],
  associations: readonly EndpointAssociation[],
  recentlyChangedEndpointIds: readonly string[],
  synthetic: boolean,
): AtoLockdownResult {
  if (signals.length === 0) {
    throw new AuthnInvariantError(
      `lockdown ${lockdownId} requires the triggering signals — the forensic record fails closed`,
    );
  }
  const revoked = sessions.map((session) =>
    session.personId === personId && session.status === 'active'
      ? { ...session, status: 'revoked' as const, revokedReason: `ato-lockdown:${lockdownId}` }
      : session,
  );
  return {
    lockdown: {
      lockdownId,
      tenantId,
      personId,
      trigger: 'ato-suspicion',
      signals,
      highRiskActionsFrozen: true,
      releaseRequirement: restorationRequirement(classifyAtoRisk(signals)),
      status: 'active',
      synthetic,
    },
    sessions: revoked,
    notification: selectNotificationChannel(associations, personId, recentlyChangedEndpointIds),
  };
}

export interface LockdownRelease {
  readonly requirementMet: RestorationRequirement | 'supervised-manual';
  readonly evidenceRef: string;
  readonly releasedBy: string;
}

/**
 * Release a lockdown (REQ-ID-029 AC-2 + exception 2): the met requirement
 * must match the case (supervised-manual is always an acceptable stand-in so
 * a member who cannot complete step-up is never permanently locked out), and
 * evidence + attribution fail closed.
 */
export function releaseLockdown(
  lockdown: AccountLockdown,
  release: LockdownRelease,
): AccountLockdown {
  if (lockdown.status !== 'active') {
    throw new AuthnInvariantError(`lockdown ${lockdown.lockdownId} is not active`);
  }
  if (!release.evidenceRef || !release.releasedBy) {
    throw new AuthnInvariantError(
      `lockdown ${lockdown.lockdownId} release requires evidence and an attributed releaser`,
    );
  }
  if (
    release.requirementMet !== lockdown.releaseRequirement &&
    release.requirementMet !== 'supervised-manual'
  ) {
    throw new AuthnInvariantError(
      `lockdown ${lockdown.lockdownId} requires ${lockdown.releaseRequirement}; ` +
        `${release.requirementMet} does not satisfy it`,
    );
  }
  return {
    ...lockdown,
    status: 'released',
    releasedBy: release.releasedBy,
    releasedEvidenceRef: release.evidenceRef,
  };
}

export interface CohortProtectionDirective {
  readonly invokedBy: string;
  readonly rateLimit: true;
  readonly forcedCredentialResetPersonIds: readonly PersonId[];
}

/**
 * Wave-level protections (REQ-ID-029 AC-4): an admin invokes platform-wide
 * rate limiting and a forced credential reset for the at-risk cohort.
 */
export function invokeCohortProtection(
  atRiskPersonIds: readonly PersonId[],
  invokedBy: string,
): CohortProtectionDirective {
  if (!invokedBy) {
    throw new AuthnInvariantError('cohort protection must name the invoking admin');
  }
  return {
    invokedBy,
    rateLimit: true,
    forcedCredentialResetPersonIds: [...atRiskPersonIds],
  };
}

export interface AtoThresholds {
  /** Failed-login count per account that raises `mass-failed-logins`. */
  readonly failedLoginSignalThreshold: number;
  /** New-device count per account that raises `new-device-burst`. */
  readonly newDeviceSignalThreshold: number;
  readonly detectionEnabled: true;
}

/** The protection floor: tuning may relax, never cross this (exception 3). */
export const atoThresholdFloor = {
  failedLoginSignalThreshold: 20,
  newDeviceSignalThreshold: 10,
} as const;

export interface AtoTuningRecord {
  readonly thresholds: AtoThresholds;
  readonly tunedBy: string;
  readonly relaxations: readonly string[];
  readonly logged: true;
}

/**
 * Tune detection thresholds (REQ-ID-029 exception 3): every relaxation is
 * named in the returned log record, and the floor is structural — a value
 * past the floor (or any attempt to represent detection-off) throws. The
 * `detectionEnabled: true` literal type makes "silently disabled" a type
 * error before it is a runtime error.
 */
export function tuneAtoThresholds(
  current: AtoThresholds,
  next: AtoThresholds,
  tunedBy: string,
): AtoTuningRecord {
  if (!tunedBy) {
    throw new AuthnInvariantError('threshold tuning must name the tuning admin');
  }
  for (const [label, value, floor] of [
    [
      'failedLoginSignalThreshold',
      next.failedLoginSignalThreshold,
      atoThresholdFloor.failedLoginSignalThreshold,
    ],
    [
      'newDeviceSignalThreshold',
      next.newDeviceSignalThreshold,
      atoThresholdFloor.newDeviceSignalThreshold,
    ],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > floor) {
      throw new AuthnInvariantError(
        `${label}=${value} crosses the ATO protection floor (${floor}); ` +
          'detection can be tuned, never disabled',
      );
    }
  }
  const relaxations: string[] = [];
  if (next.failedLoginSignalThreshold > current.failedLoginSignalThreshold) {
    relaxations.push(
      `failedLoginSignalThreshold ${current.failedLoginSignalThreshold} -> ${next.failedLoginSignalThreshold}`,
    );
  }
  if (next.newDeviceSignalThreshold > current.newDeviceSignalThreshold) {
    relaxations.push(
      `newDeviceSignalThreshold ${current.newDeviceSignalThreshold} -> ${next.newDeviceSignalThreshold}`,
    );
  }
  return { thresholds: next, tunedBy, relaxations, logged: true };
}

/**
 * Device-lost revocation wrapped as the lockdown trigger it is (REQ-ID-024
 * AC-4 executes through the same protective, non-gated path).
 */
export function deviceLostLockdown(
  lockdownId: string,
  tenantId: TenantId,
  personId: PersonId,
  deviceId: string,
  sessions: readonly AuthSession[],
  reportedBy: string,
  atIso: string,
  synthetic: boolean,
): { lockdown: AccountLockdown; sessions: readonly AuthSession[] } {
  return {
    lockdown: {
      lockdownId,
      tenantId,
      personId,
      trigger: 'device-lost',
      signals: [{ kind: 'device-reported-lost', detail: `device:${deviceId}`, observedAt: atIso }],
      highRiskActionsFrozen: true,
      releaseRequirement: 'step-up',
      status: 'active',
      synthetic,
    },
    sessions: revokeDevice(sessions, deviceId, reportedBy),
  };
}
