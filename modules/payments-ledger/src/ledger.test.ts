import { describe, expect, it } from 'vitest';

import { BalancedLedger, LedgerError, type LedgerLine } from './ledger.js';

const lines = (amount = 2500): readonly LedgerLine[] => [
  { accountRef: 'cash', side: 'debit', amountMinor: amount, currency: 'USD', sourceRef: 'pay-1' },
  {
    accountRef: 'service-liability',
    side: 'credit',
    amountMinor: amount,
    currency: 'USD',
    sourceRef: 'pay-1',
  },
];

const post = (ledger: BalancedLedger) =>
  ledger.postBalancedSet({
    tenantId: 'northwind-synthetic',
    journalId: 'journal-1',
    correlationId: 'corr-1',
    idempotencyKey: 'ledger-key-1',
    lines: lines(),
  });

describe('BalancedLedger', () => {
  it('posts one balanced journal and returns the original receipt on an identical retry', () => {
    const ledger = new BalancedLedger();
    expect(post(ledger)).toEqual(post(ledger));
    expect(ledger.journals()).toHaveLength(1);
  });

  it('rejects imbalance and safe-integer overflow', () => {
    const ledger = new BalancedLedger();
    const unbalanced: readonly LedgerLine[] = [
      { accountRef: 'cash', side: 'debit', amountMinor: 2500, currency: 'USD', sourceRef: 'pay-1' },
      {
        accountRef: 'service-liability',
        side: 'credit',
        amountMinor: 2499,
        currency: 'USD',
        sourceRef: 'pay-1',
      },
    ];
    expect(() =>
      ledger.postBalancedSet({
        tenantId: 'northwind-synthetic',
        journalId: 'bad',
        correlationId: 'c',
        idempotencyKey: 'k',
        lines: unbalanced,
      }),
    ).toThrowError(new LedgerError('UNBALANCED'));
    const overflow: readonly LedgerLine[] = [
      {
        accountRef: 'cash',
        side: 'debit',
        amountMinor: Number.MAX_SAFE_INTEGER,
        currency: 'USD',
        sourceRef: 'pay-1',
      },
      {
        accountRef: 'service-liability',
        side: 'credit',
        amountMinor: Number.MAX_SAFE_INTEGER,
        currency: 'USD',
        sourceRef: 'pay-1',
      },
      { accountRef: 'cash', side: 'debit', amountMinor: 1, currency: 'USD', sourceRef: 'pay-2' },
      {
        accountRef: 'service-liability',
        side: 'credit',
        amountMinor: 1,
        currency: 'USD',
        sourceRef: 'pay-2',
      },
    ];
    expect(() =>
      ledger.postBalancedSet({
        tenantId: 'northwind-synthetic',
        journalId: 'overflow',
        correlationId: 'c',
        idempotencyKey: 'o',
        lines: overflow,
      }),
    ).toThrowError(new LedgerError('INVALID_LINE'));
  });

  it('requires an exact one-time reversal', () => {
    const ledger = new BalancedLedger();
    post(ledger);
    const reversal = {
      tenantId: 'northwind-synthetic',
      journalId: 'journal-r1',
      correlationId: 'corr-r1',
      idempotencyKey: 'ledger-reverse-1',
      reversalOfJournalId: 'journal-1',
      lines: lines().map((line) => ({
        ...line,
        side: line.side === 'debit' ? ('credit' as const) : ('debit' as const),
      })),
    };
    ledger.postBalancedSet(reversal);
    expect(() =>
      ledger.postBalancedSet({
        ...reversal,
        journalId: 'journal-r2',
        idempotencyKey: 'ledger-reverse-2',
      }),
    ).toThrowError(new LedgerError('ALREADY_REVERSED'));
  });

  it('keeps delimiter-bearing tenant and idempotency tuples distinct', () => {
    const ledger = new BalancedLedger();
    ledger.postBalancedSet({
      tenantId: 'tenant:a',
      journalId: 'journal-a',
      correlationId: 'corr-a',
      idempotencyKey: 'b',
      lines: lines(),
    });
    ledger.postBalancedSet({
      tenantId: 'tenant',
      journalId: 'journal-b',
      correlationId: 'corr-b',
      idempotencyKey: 'a:b',
      lines: lines(),
    });
    expect(ledger.journals()).toHaveLength(2);
  });
});
