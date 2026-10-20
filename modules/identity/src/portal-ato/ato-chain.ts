/**
 * Portal-side ATO chain (WP-099, REQ-ID-029; FWD-AUTH-099-ATO-DRILLS): portal login attempts
 * become signals, signals become lockdowns through the WP-014 ato.ts machinery (read-only here),
 * a stuffing wave invokes cohort protection, and restoration is proportional to risk through the
 * WP-013 identity-proofing port.
 */

import type { PersonId } from '@practicehub/contracts';

import {
  classifyAtoRisk,
  invokeCohortProtection,
  raiseAtoLockdownCommitted,
  releaseLockdown,
  type AccountLockdown,
  type AtoSignal,
} from '../ato.js';
import { AuthnInvariantError, type AuthSession } from '../authn.js';
import { detectSessionAnomalies, type SessionSighting } from '../credential-anomaly.js';
import type { IdentityProofingPort, IdentityProofingResult } from '../idproof-port.js';
import {
  PortalAtoError,
  type AccountAtoOutcome,
  type PortalAtoChainInput,
  type PortalAtoChainResult,
  type PortalLoginAttempt,
  type RestorationAttempt,
  type RestorationOutcome,
  type StuffingWave,
  type StuffingWaveThresholds,
} from './types.js';

export const stuffingWaveThresholdsV1: StuffingWaveThresholds = {
  distinctAccountsPerSource: 5,
  windowMinutes: 10,
};

function instant(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new PortalAtoError(`${label} is not an ISO-8601 instant: ${value}`);
  }
  return parsed;
}

function assertAttempts(attempts: readonly PortalLoginAttempt[]): void {
  for (const attempt of attempts) {
    if (attempt.synthetic !== true) {
      throw new PortalAtoError(`login attempt ${attempt.attemptId} is not synthetic`);
    }
    instant(attempt.observedAt, `attempt ${attempt.attemptId} observedAt`);
  }
}

function byTime(a: PortalLoginAttempt, b: PortalLoginAttempt): number {
  return (
    Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.attemptId.localeCompare(b.attemptId)
  );
}

/**
 * Credential stuffing seen from the portal: one source failing against many distinct accounts
 * inside a short window. Every account the source touched is at risk; an account it then logged
 * into successfully is treated as compromised.
 */
export function detectStuffingWaves(
  attempts: readonly PortalLoginAttempt[],
  thresholds: StuffingWaveThresholds = stuffingWaveThresholdsV1,
): readonly StuffingWave[] {
  assertAttempts(attempts);
  const bySource = new Map<string, PortalLoginAttempt[]>();
  for (const attempt of attempts) {
    const list = bySource.get(attempt.sourceRef) ?? [];
    list.push(attempt);
    bySource.set(attempt.sourceRef, list);
  }
  const windowMs = thresholds.windowMinutes * 60_000;
  const waves: StuffingWave[] = [];
  for (const [sourceRef, list] of [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...list].sort(byTime);
    const failures = sorted.filter((attempt) => attempt.outcome === 'failed');
    const isWave = failures.some((start) => {
      const from = Date.parse(start.observedAt);
      const accounts = new Set(
        failures
          .filter((attempt) => {
            const at = Date.parse(attempt.observedAt);
            return at >= from && at - from <= windowMs;
          })
          .map((attempt) => attempt.personId),
      );
      return accounts.size >= thresholds.distinctAccountsPerSource;
    });
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if (!isWave || first === undefined || last === undefined) continue;
    waves.push({
      sourceRef,
      targetedPersonIds: [...new Set(sorted.map((attempt) => attempt.personId))].sort(),
      compromisedPersonIds: [
        ...new Set(
          sorted.filter((attempt) => attempt.outcome === 'succeeded').map((a) => a.personId),
        ),
      ].sort(),
      firstSeenAt: first.observedAt,
      lastSeenAt: last.observedAt,
    });
  }
  return waves;
}

/** Signals for one account: wave compromise, mass failures, and the WP-017 session heuristics. */
export function accountSignals(
  personId: PersonId,
  attempts: readonly PortalLoginAttempt[],
  waves: readonly StuffingWave[],
  failedLoginSignalThreshold: number,
): readonly AtoSignal[] {
  const own = attempts.filter((attempt) => attempt.personId === personId).sort(byTime);
  const signals: AtoSignal[] = [];
  for (const wave of waves) {
    if (!wave.compromisedPersonIds.includes(personId)) continue;
    const success = own.find(
      (attempt) => attempt.sourceRef === wave.sourceRef && attempt.outcome === 'succeeded',
    );
    signals.push({
      kind: 'credential-stuffing',
      detail: `stuffing-wave:${wave.sourceRef}:login-succeeded`,
      observedAt: success?.observedAt ?? wave.lastSeenAt,
    });
  }
  const failures = own.filter((attempt) => attempt.outcome === 'failed');
  const lastFailure = failures[failures.length - 1];
  if (failures.length >= failedLoginSignalThreshold && lastFailure !== undefined) {
    signals.push({
      kind: 'mass-failed-logins',
      detail: `failed-logins:${failures.length}`,
      observedAt: lastFailure.observedAt,
    });
  }
  const sightings: SessionSighting[] = own
    .filter((attempt) => attempt.outcome === 'succeeded')
    .map((attempt) => ({
      sessionId: attempt.attemptId,
      deviceId: attempt.deviceId,
      locationRef: attempt.locationRef,
      observedAt: attempt.observedAt,
    }));
  signals.push(...detectSessionAnomalies(sightings));
  return signals;
}

/**
 * Lock one account through ato.ts's committed-result API (H-07). Containment (the lockdown and the
 * revocation of this person's sessions in THIS tenant) is committed by ato.ts before notification
 * is decided, so a missing trusted channel never loses it. Only the notification outcome
 * 'follow-up-required' becomes the chain's fail-closed notice; any other invariant error is a
 * real failure and propagates. The chain never revokes sessions itself.
 */
function lockAccount(
  input: PortalAtoChainInput,
  personId: PersonId,
  signals: readonly AtoSignal[],
  lockdownId: string,
  sessions: readonly AuthSession[],
): { readonly outcome: AccountAtoOutcome; readonly sessions: readonly AuthSession[] } {
  const risk = classifyAtoRisk(signals);
  const committed = raiseAtoLockdownCommitted(
    lockdownId,
    input.tenantId,
    personId,
    signals,
    sessions,
    input.associations,
    input.recentlyChangedEndpointIds[personId] ?? [],
    true,
  );
  const notification: AccountAtoOutcome['notification'] =
    committed.notification.status === 'sent'
      ? { status: 'sent', directive: committed.notification.directive }
      : {
          status: 'fail-closed',
          route: 'supervised-manual',
          reason: committed.notification.followUp.reason,
          followUp: committed.notification.followUp,
        };
  return {
    outcome: { personId, signals, risk, lockdown: committed.lockdown, notification },
    sessions: committed.sessions,
  };
}

/** Detect, lock, notify and protect the cohort for one batch of portal login attempts. */
export function runPortalAtoChain(
  input: PortalAtoChainInput,
  thresholds: StuffingWaveThresholds = stuffingWaveThresholdsV1,
): PortalAtoChainResult {
  if (input.synthetic !== true) throw new PortalAtoError('the portal ATO chain is synthetic-only');
  const waves = detectStuffingWaves(input.attempts, thresholds);
  const people = [...new Set(input.attempts.map((attempt) => attempt.personId))].sort();
  let sessions = input.sessions;
  const accounts: AccountAtoOutcome[] = [];
  for (const personId of people) {
    const signals = accountSignals(
      personId,
      input.attempts,
      waves,
      input.failedLoginSignalThreshold,
    );
    if (signals.length === 0) continue;
    const locked = lockAccount(
      input,
      personId,
      signals,
      `${input.lockdownIdPrefix}-${accounts.length + 1}`,
      sessions,
    );
    sessions = locked.sessions;
    accounts.push(locked.outcome);
  }
  const atRisk = [...new Set(waves.flatMap((wave) => wave.targetedPersonIds))].sort();
  return {
    waves,
    accounts,
    cohortProtection:
      atRisk.length === 0 ? null : invokeCohortProtection(atRisk, input.cohortProtectionInvokedBy),
    sessions,
  };
}

/**
 * Restore a locked portal account (REQ-ID-029 AC2 + EX2). Step-up cannot release a high-risk
 * lockdown; re-identity-proofing goes through the WP-013 port and any failure or outage of that
 * port keeps the account locked and offers the supervised manual path, so lockout is never
 * permanent and never silently lifted.
 */
export function restorePortalAccess(
  lockdown: AccountLockdown,
  attempt: RestorationAttempt,
  identityProofing: IdentityProofingPort,
): RestorationOutcome {
  if (lockdown.status !== 'active') {
    throw new PortalAtoError(`lockdown ${lockdown.lockdownId} is not active`);
  }
  const refuse = (reason: string, offered: 'retry' | 'supervised-manual'): RestorationOutcome => ({
    status: 'still-locked',
    lockdown,
    reason,
    offered,
  });
  const release = (
    requirementMet: 'step-up' | 're-identity-proofing' | 'supervised-manual',
    evidenceRef: string,
    releasedBy: string,
  ): RestorationOutcome => {
    try {
      return {
        status: 'released',
        lockdown: releaseLockdown(lockdown, { requirementMet, evidenceRef, releasedBy }),
      };
    } catch (error) {
      if (!(error instanceof AuthnInvariantError)) throw error;
      return refuse(error.message, 'retry');
    }
  };
  switch (attempt.kind) {
    case 'step-up':
      return release('step-up', attempt.evidenceRef, attempt.releasedBy);
    case 'supervised-manual':
      return release('supervised-manual', attempt.evidenceRef, attempt.verifierId);
    case 're-identity-proofing': {
      let result: IdentityProofingResult;
      try {
        result = identityProofing.prove({
          tenantId: lockdown.tenantId,
          personId: lockdown.personId,
          method: attempt.method,
          synthetic: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown';
        return refuse(`identity proofing unavailable: ${message}`, 'supervised-manual');
      }
      if (!result.verified || !result.evidenceRef) {
        return refuse(
          `identity proofing did not verify: ${result.failureReason ?? 'no evidence'}`,
          'supervised-manual',
        );
      }
      return release('re-identity-proofing', result.evidenceRef, attempt.releasedBy);
    }
  }
}
