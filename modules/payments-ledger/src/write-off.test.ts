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

  it('posts an authorized write-off as a new balanced set', () => {
    const ledger = new BalancedLedger();
    const approval = authorizeWriteOff({
      tenantId: 'northwind-synthetic',
      amountMinor: 1000,
      currency: 'USD',
      reason: 'small-balance',
      role: 'billing-clerk',
      rail: 'cash',
    });
    postWriteOff(ledger, approval, {
      journalId: 'wo-1',
      correlationId: 'corr-wo-1',
      idempotencyKey: 'wo-key-1',
      sourceRef: 'wo-src-1',
    });
    const balances = ledger.accountBalances('northwind-synthetic');
    expect(balances).toEqual([
      { accountRef: 'accounts-receivable', currency: 'USD', debitMinor: 0, creditMinor: 1000 },
      { accountRef: 'write-off-expense', currency: 'USD', debitMinor: 1000, creditMinor: 0 },
    ]);
    expect(() =>
      postWriteOff(
        ledger,
        { ...approval, amountMinor: 500 },
        {
          journalId: 'wo-2',
          correlationId: 'corr-wo-2',
          idempotencyKey: 'wo-key-2',
          sourceRef: 'wo-src-2',
        },
      ),
    ).toThrowError(new WriteOffError('APPROVAL_MISMATCH'));
    expect(ledger.journals()).toHaveLength(1);
  });
});
