/**
 * WP-056 rework 1 regressions (review D46-WP-056-a1-review-1). This file
 * imports only symbols that existed in the landed commit (2390dd1), so the
 * same tests can be run against the landed bytes to show each one failing
 * there and passing on the rework.
 */
import { describe, expect, it } from 'vitest';

import { BalancedLedger, LedgerError, type LedgerLine } from './ledger.js';
import { reconcilePayoutToThePenny, type PayoutLedgerLine } from './payout-reconciliation.js';
import { authorizeWriteOff, postWriteOff, WriteOffError } from './write-off.js';

const tenant = 'northwind-synthetic';

const pair = (amount: number, sourceRef = 'pay-1'): readonly LedgerLine[] => [
  { accountRef: 'cash', side: 'debit', amountMinor: amount, currency: 'USD', sourceRef },
  {
    accountRef: 'service-liability',
    side: 'credit',
    amountMinor: amount,
    currency: 'USD',
    sourceRef,
  },
];

describe('[high] write-off approval is single-use (review P1)', () => {
  // H-21 retired the tier-only postWriteOff path (it trusted a caller-declared role),
  // so a tier-only approval can no longer post at all, let alone twice. Single use on
  // the governed path is covered in write-off-governance.test.ts.
  it('a tier-only approval posts no journal, first time or again', () => {
    const ledger = new BalancedLedger();
    const approval = authorizeWriteOff({
      tenantId: tenant,
      amountMinor: 900,
      currency: 'USD',
      reason: 'small-balance',
      role: 'billing-clerk',
      rail: 'cash',
    });
    for (const suffix of ['a', 'b']) {
      expect(() =>
        postWriteOff(ledger, approval, {
          journalId: `wo-p1-${suffix}`,
          correlationId: `corr-p1-${suffix}`,
          idempotencyKey: `key-p1-${suffix}`,
          sourceRef: 'ar-item-1',
        }),
      ).toThrowError(new WriteOffError('DEPRECATED_PATH_REFUSED'));
    }
    expect(ledger.journals()).toHaveLength(0);
  });
});

describe('[low] idempotency hash is canonical (review P5)', () => {
  it('treats an omitted rail and an explicit cash rail in another key order as the same retry', () => {
    const ledger = new BalancedLedger();
    const first = ledger.postBalancedSet({
      tenantId: tenant,
      journalId: 'j-p5',
      correlationId: 'c-p5',
      idempotencyKey: 'k-p5',
      lines: pair(2500),
    });
    const retry = ledger.postBalancedSet({
      rail: 'cash',
      lines: pair(2500),
      idempotencyKey: 'k-p5',
      correlationId: 'c-p5',
      journalId: 'j-p5',
      tenantId: tenant,
    });
    expect(retry).toEqual(first);
    expect(ledger.journals()).toHaveLength(1);
    expect(() =>
      ledger.postBalancedSet({
        tenantId: tenant,
        journalId: 'j-p5',
        correlationId: 'c-p5',
        idempotencyKey: 'k-p5',
        rail: 'membership',
        lines: pair(2500),
      }),
    ).toThrowError(new LedgerError('IDEMPOTENCY_CONFLICT'));
  });
});

describe('[low] account balances never merge tenants (review P6)', () => {
  it('keys every row by tenant when no tenantId is passed', () => {
    const ledger = new BalancedLedger();
    for (const tenantId of ['northwind-synthetic', 'riverbend-synthetic']) {
      ledger.postBalancedSet({
        tenantId,
        journalId: 'j-p6',
        correlationId: 'c-p6',
        idempotencyKey: 'k-p6',
        lines: pair(tenantId === 'northwind-synthetic' ? 100 : 700),
      });
    }
    // Read through a loose shape so the landed AccountBalance (no tenantId) still compiles.
    const rows = ledger.accountBalances() as unknown as readonly (Record<string, unknown> & {
      accountRef: string;
    })[];
    const cash = rows.filter((row) => row.accountRef === 'cash');
    expect(cash).toHaveLength(2);
    expect(cash.map((row) => [row['tenantId'], row['debitMinor']])).toEqual([
      ['northwind-synthetic', 100],
      ['riverbend-synthetic', 700],
    ]);
  });
});

describe('[low] payout lines must belong to the reconciled tenant and payout', () => {
  it('rejects a line from another tenant or payout', () => {
    const own: PayoutLedgerLine = {
      rail: 'cash',
      accountRef: 'cash',
      side: 'debit',
      amountMinor: 2500,
      currency: 'USD',
    };
    const foreign = [
      { ...own, tenantId: 'riverbend-synthetic' },
      { ...own, payoutRef: 'po_other' },
    ];
    for (const line of foreign) {
      expect(() =>
        reconcilePayoutToThePenny({
          tenantId: tenant,
          payoutRef: 'po_synthetic_1',
          currency: 'USD',
          payoutAmountMinor: 5000,
          lines: [own, line as PayoutLedgerLine],
        }),
      ).toThrowError(new LedgerError('INVALID_LINE'));
    }
  });
});
