import {
  AuthRehearsalError,
  type AuthSession,
  type RehearsalKind,
  type RehearsalResult,
} from './contracts.js';

export function rehearse(kind: RehearsalKind, session: AuthSession): RehearsalResult {
  if (session.synthetic !== true) {
    throw new AuthRehearsalError('NON_SYNTHETIC', session.sessionId);
  }
  if (kind === 'pre-auth') {
    return {
      kind,
      allowed: session.kind === 'elevated',
      lockdown: false,
      stepUpRequired: session.kind === 'pre-auth',
    };
  }
  if (kind === 'step-up') {
    const needs = session.kind !== 'elevated';
    return { kind, allowed: !needs, lockdown: false, stepUpRequired: needs };
  }
  const lock = session.anomaly === true || session.kind === 'locked';
  return { kind: 'ato-lockdown', allowed: !lock, lockdown: lock, stepUpRequired: false };
}
