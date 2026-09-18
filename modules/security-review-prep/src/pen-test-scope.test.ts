import { describe, expect, it } from 'vitest';

import { PenTestScope, PenTestScopeError } from './pen-test-scope.js';

describe('pen-test scope', () => {
  it('splits in-scope auth/export/AI from out-of-scope vendor networks', () => {
    const scope = new PenTestScope();
    scope.add({
      id: 'PT-AUTH',
      class: 'in-scope',
      name: 'session issuance and MFA',
      reason: 'R6-REQ-004 / EW-SEC-01 pen-test gate',
    });
    scope.add({
      id: 'PT-CARD',
      class: 'out-of-scope',
      name: 'card network',
      reason: 'D5 integrate, never build',
    });
    expect(scope.inScope()).toHaveLength(1);
    expect(scope.outOfScope()).toHaveLength(1);
  });

  it('fails closed on an empty pack', () => {
    expect(() => new PenTestScope().inScope()).toThrowError(new PenTestScopeError('EMPTY_SCOPE'));
  });
});
