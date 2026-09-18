export const REHEARSAL_IDENTITY = 'WP-136/REQ-AUTH';

export class AuthRehearsalError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthRehearsalError';
  }
}

export type RehearsalKind = 'step-up' | 'ato-lockdown' | 'pre-auth';

export type SessionKind = 'pre-auth' | 'elevated' | 'locked';

export interface AuthSession {
  readonly sessionId: string;
  readonly kind: SessionKind;
  readonly anomaly: boolean;
  readonly synthetic: true;
}

export interface RehearsalResult {
  readonly kind: RehearsalKind;
  readonly allowed: boolean;
  readonly lockdown: boolean;
  readonly stepUpRequired: boolean;
}
