import { describe, expect, it } from 'vitest';

import { BalancedLedger } from './ledger.js';
import { authorizeWriteOff, postWriteOff, WriteOffError } from './write-off.js';

describe('write-off approval tiers', () => {
  it('rejects a clerk write-off above the clerk ceiling', () => {
    expect(() =>
      authorizeWriteOff({
        tenantId: 'northwind-synthetic',
        amountMinor: 1001,
        currency: 'USD',
        reason: 'contractual-adjustment',
        role: 'billing-clerk',
        rail: 'insurance',
      }),
    ).toThrowError(new WriteOffError('UNDER_AUTHORIZED'));
  });

  it('rejects a charity write-off from anyone except the rcm lead', () => {
    expect(() =>
      authorizeWriteOff({
        tenantId: 'northwind-synthetic',
        amountMinor: 500,
        currency: 'USD',
        reason: 'charity',
        role: 'billing-supervisor',
        rail: 'cash',
      }),
    ).toThrowError(new WriteOffError('UNDER_AUTHORIZED'));
  });

  it('the deprecated tier-only path no longer posts on a caller-declared role (H-21)', () => {
    // It used to post this write-off on the caller's word that it was a billing clerk.
    // Governed write-offs now go through approveWriteOff + postApprovedWriteOff.
    const ledger = new BalancedLedger();
    const approval = authorizeWriteOff({
      tenantId: 'northwind-synthetic',
      amountMinor: 1000,
      currency: 'USD',
      reason: 'small-balance',
      role: 'billing-clerk',
      rail: 'cash',
    });
    expect(() =>
      postWriteOff(ledger, approval, {
        journalId: 'wo-1',
        correlationId: 'corr-wo-1',
        idempotencyKey: 'wo-key-1',
        sourceRef: 'wo-src-1',
      }),
    ).toThrowError(new WriteOffError('DEPRECATED_PATH_REFUSED'));
    expect(ledger.journals()).toHaveLength(0);
  });
});
