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

  it('keeps a posted set balanced across three rails and restores balances only by reversal', () => {
    const ledger = new BalancedLedger();
    for (const rail of ['insurance', 'membership', 'cash'] as const) {
      ledger.postBalancedSet({
        tenantId: 'northwind-synthetic',
        journalId: `journal-${rail}`,
        correlationId: `corr-${rail}`,
        idempotencyKey: `key-${rail}`,
        rail,
        ...(rail === 'cash' ? { payoutRef: 'po-1' } : {}),
        lines: lines(rail === 'cash' ? 2500 : 100),
      });
    }
    const before = ledger.accountBalances('northwind-synthetic');
    expect(before.every((balance) => balance.debitMinor === balance.creditMinor)).toBe(false);
    const byCurrency = new Map<string, { debit: number; credit: number }>();
    for (const balance of before) {
      const total = byCurrency.get(balance.currency) ?? { debit: 0, credit: 0 };
      total.debit += balance.debitMinor;
      total.credit += balance.creditMinor;
      byCurrency.set(balance.currency, total);
    }
    expect([...byCurrency.values()].every((total) => total.debit === total.credit)).toBe(true);
    expect(() =>
      ledger.postBalancedSet({
        tenantId: 'northwind-synthetic',
        journalId: 'journal-cash',
        correlationId: 'corr-edit',
        idempotencyKey: 'key-edit',
        rail: 'cash',
        lines: lines(2499),
      }),
    ).toThrowError(new LedgerError('IDEMPOTENCY_CONFLICT'));
    expect(ledger.journal('northwind-synthetic', 'journal-cash')?.lines[0]?.amountMinor).toBe(2500);
    ledger.postBalancedSet({
      tenantId: 'northwind-synthetic',
      journalId: 'journal-cash-reversal',
      correlationId: 'corr-cash-r',
      idempotencyKey: 'key-cash-r',
      rail: 'cash',
      payoutRef: 'po-1',
      reversalOfJournalId: 'journal-cash',
      lines: lines(2500).map((line) => ({
        ...line,
        side: line.side === 'debit' ? ('credit' as const) : ('debit' as const),
      })),
    });
    expect(ledger.cashPayoutMinor('northwind-synthetic', 'po-1', 'USD')).toBe(0);
    const after = ledger.accountBalances('northwind-synthetic');
    const afterCurrency = new Map<string, { debit: number; credit: number }>();
    for (const balance of after) {
      const total = afterCurrency.get(balance.currency) ?? { debit: 0, credit: 0 };
      total.debit += balance.debitMinor;
      total.credit += balance.creditMinor;
      afterCurrency.set(balance.currency, total);
    }
    expect([...afterCurrency.values()].every((total) => total.debit === total.credit)).toBe(true);
  });
});
