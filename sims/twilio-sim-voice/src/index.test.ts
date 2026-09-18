import { describe, expect, it } from 'vitest';

import { TwilioSimVoice } from './index.js';

describe('TwilioSimVoice', () => {
  it('stores a synthetic dial once under the idempotency key', () => {
    const sim = new TwilioSimVoice();
    const effect = {
      tenantId: 't1',
      callId: 'c1',
      operation: 'dial' as const,
      idempotencyKey: 'k1',
      synthetic: true as const,
    };
    expect(sim.dispatch(effect)).toEqual(effect);
    expect(sim.dispatch(effect)).toEqual(effect);
  });

  it('refuses a changed payload under the same key', () => {
    const sim = new TwilioSimVoice();
    sim.dispatch({
      tenantId: 't1',
      callId: 'c1',
      operation: 'dial',
      idempotencyKey: 'k1',
      synthetic: true,
    });
    expect(() =>
      sim.dispatch({
        tenantId: 't1',
        callId: 'c2',
        operation: 'dial',
        idempotencyKey: 'k1',
        synthetic: true,
      }),
    ).toThrow('idempotency key reused with a different payload');
  });
});
