import { describe, expect, it } from 'vitest';

import { reconcilePayoutToThePenny, type PayoutLedgerLine } from './payout-reconciliation.js';

const lines = (cashMinor: number): readonly PayoutLedgerLine[] => [
  {
    rail: 'cash',
    accountRef: 'cash',
    side: 'debit',
    amountMinor: cashMinor,
    currency: 'USD',
  },
  {
    rail: 'cash',
    accountRef: 'service-liability',
    side: 'credit',
    amountMinor: cashMinor,
    currency: 'USD',
  },
  {
    rail: 'membership',
    accountRef: 'cash',
    side: 'debit',
    amountMinor: 1,
    currency: 'USD',
  },
];

describe('payout reconciliation to the penny', () => {
  it('matches an equal minor-unit total and opens no work item', () => {
    const result = reconcilePayoutToThePenny({
      tenantId: 'northwind-synthetic',
      payoutRef: 'po_synthetic_1',
      currency: 'USD',
      payoutAmountMinor: 2500,
      lines: lines(2500),
    });
    expect(result.matched).toBe(true);
    expect(result.driftMinor).toBe(0);
    expect(result.workItem).toBeNull();
    expect(result.ledgerMinor).toBe(2500);
  });

  it('opens a work item when the payout is off by one cent and leaves the lines unchanged', () => {
    const posted = lines(2500);
    const before = JSON.stringify(posted);
    const result = reconcilePayoutToThePenny({
      tenantId: 'northwind-synthetic',
      payoutRef: 'po_synthetic_1',
      currency: 'USD',
      payoutAmountMinor: 2499,
      lines: posted,
    });
    expect(JSON.stringify(posted)).toBe(before);
    expect(result.matched).toBe(false);
    expect(result.driftMinor).toBe(-1);
    expect(result.workItem).toEqual({
      origin: 'payments-ledger',
      purpose: 'payout-reconciliation-drift',
      tenantId: 'northwind-synthetic',
      payoutRef: 'po_synthetic_1',
      currency: 'USD',
      ledgerMinor: 2500,
      payoutMinor: 2499,
      driftMinor: -1,
    });
  });
});
