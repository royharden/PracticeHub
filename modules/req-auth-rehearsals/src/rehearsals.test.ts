import { describe, expect, it } from 'vitest';

import { AuthRehearsalError, type AuthSession } from './contracts.js';
import { rehearse } from './rehearsals.js';

describe('WP-136 auth rehearsals', () => {
  it('requires step-up for a non-elevated sensitive view', () => {
    const session: AuthSession = { sessionId: 's1', kind: 'pre-auth', anomaly: false, synthetic: true };
    const result = rehearse('step-up', session);
    expect(result.stepUpRequired).toBe(true);
    expect(result.allowed).toBe(false);
  });

  it('locks down after anomaly', () => {
    const session: AuthSession = { sessionId: 's2', kind: 'elevated', anomaly: true, synthetic: true };
    const result = rehearse('ato-lockdown', session);
    expect(result.lockdown).toBe(true);
    expect(result.allowed).toBe(false);
  });

  it('denies protected surface to pre-auth', () => {
    const session: AuthSession = { sessionId: 's3', kind: 'pre-auth', anomaly: false, synthetic: true };
    expect(rehearse('pre-auth', session).allowed).toBe(false);
  });

  it('rejects non-synthetic sessions', () => {
    expect(() =>
      rehearse('step-up', { sessionId: 's4', kind: 'elevated', anomaly: false } as AuthSession),
    ).toThrow(AuthRehearsalError);
  });
});
