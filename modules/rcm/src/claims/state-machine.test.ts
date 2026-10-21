import { describe, expect, it } from 'vitest';

import { assertTransition, CLAIM_TRANSITIONS, isTerminal } from './state-machine.js';

describe('WP-086 frozen claim state machine', () => {
  it('cannot be modified at runtime', () => {
    expect(Object.isFrozen(CLAIM_TRANSITIONS)).toBe(true);
    expect(Object.isFrozen(CLAIM_TRANSITIONS.submitting)).toBe(true);
  });

  it('routes every submission through submitting and a crash through unknown', () => {
    expect(CLAIM_TRANSITIONS.validated).toEqual(['submitting']);
    expect(CLAIM_TRANSITIONS.submitting).toEqual(['submitted', 'unknown']);
    expect(() => assertTransition('validated', 'submitted')).toThrow(/cannot move/);
    expect(() => assertTransition('unknown', 'ack-accepted')).toThrow(/cannot move/);
    expect(() => assertTransition('submitting', 'ack-accepted')).toThrow(/cannot move/);
  });

  it('marks outcome states terminal', () => {
    for (const state of [
      'invalid',
      'ack-rejected',
      'payer-rejected',
      'finalized',
      'exception',
    ] as const) {
      expect(isTerminal(state)).toBe(true);
    }
    expect(isTerminal('unknown')).toBe(false);
  });
});
