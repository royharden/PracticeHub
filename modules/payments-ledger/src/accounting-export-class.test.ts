import { describe, expect, it } from 'vitest';

import {
  accountClassOf,
  accountingClassExportFields,
  AccountingExportError,
  buildAccountingClassExport,
  buildAccountingExport,
} from './accounting-export.js';
import { BalancedLedger } from './ledger.js';

const tenant = 'northwind-synthetic';
const january = {
  tenantId: tenant,
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  currency: 'USD',
};

describe('accounting export dating', () => {
  it('refuses to place an undated in-scope journal in any period', () => {
    const ledger = new BalancedLedger();
    ledger.postBalancedSet({
      tenantId: tenant,
      journalId: 'undated',
      correlationId: 'c',
      idempotencyKey: 'k',
      lines: [
        { accountRef: 'cash', side: 'debit', amountMinor: 1, currency: 'USD', sourceRef: 's' },
        { accountRef: 'revenue', side: 'credit', amountMinor: 1, currency: 'USD', sourceRef: 's' },
      ],
    });
    expect(() => buildAccountingExport(ledger, january)).toThrowError(
      new AccountingExportError('UNDATED_JOURNAL'),
    );
    expect(buildAccountingExport(ledger, { ...january, currency: 'EUR' }).debitMinor).toBe(0);
  });

  it('rejects an impossible period date and a malformed journal date', () => {
    expect(() =>
      buildAccountingExport(new BalancedLedger(), { ...january, periodEnd: '2026-13-40' }),
    ).toThrowError(new AccountingExportError('INVALID'));
    expect(() =>
      new BalancedLedger().postBalancedSet({
        tenantId: tenant,
        journalId: 'bad-date',
        correlationId: 'c',
        idempotencyKey: 'k',
        occurredAt: '2026-01-15',
        lines: [
          { accountRef: 'cash', side: 'debit', amountMinor: 1, currency: 'USD', sourceRef: 's' },
          {
            accountRef: 'revenue',
            side: 'credit',
            amountMinor: 1,
            currency: 'USD',
            sourceRef: 's',
          },
        ],
      }),
    ).toThrowError('INVALID_LINE');
  });
});

describe('per-account-class summary', () => {
  it('reports bounded class totals for the period and nothing finer', () => {
    const ledger = new BalancedLedger();
    ledger.postBalancedSet({
      tenantId: tenant,
      journalId: 'charge',
      correlationId: 'c1',
      idempotencyKey: 'k1',
      occurredAt: '2026-01-05T00:00:00.000Z',
      lines: [
        {
          accountRef: 'patient-ar:acct-1',
          side: 'debit',
          amountMinor: 2500,
          currency: 'USD',
          sourceRef: 's1',
        },
        {
          accountRef: 'service-revenue',
          side: 'credit',
          amountMinor: 2500,
          currency: 'USD',
          sourceRef: 's1',
        },
      ],
    });
    ledger.postBalancedSet({
      tenantId: tenant,
      journalId: 'write-off',
      correlationId: 'c2',
      idempotencyKey: 'k2',
      occurredAt: '2026-01-06T00:00:00.000Z',
      lines: [
        {
          accountRef: 'write-off-expense',
          side: 'debit',
          amountMinor: 300,
          currency: 'USD',
          sourceRef: 's2',
        },
        {
          accountRef: 'accounts-receivable',
          side: 'credit',
          amountMinor: 300,
          currency: 'USD',
          sourceRef: 's2',
        },
      ],
    });
    ledger.postBalancedSet({
      tenantId: tenant,
      journalId: 'later',
      correlationId: 'c3',
      idempotencyKey: 'k3',
      occurredAt: '2026-02-06T00:00:00.000Z',
      lines: [
        { accountRef: 'cash', side: 'debit', amountMinor: 9999, currency: 'USD', sourceRef: 's3' },
        {
          accountRef: 'deferred-liability',
          side: 'credit',
          amountMinor: 9999,
          currency: 'USD',
          sourceRef: 's3',
        },
      ],
    });
    const rows = buildAccountingClassExport(ledger, january);
    expect(rows.map((row) => [row.accountClass, row.debitMinor, row.creditMinor])).toEqual([
      ['asset', 2500, 300],
      ['revenue', 0, 2500],
      ['expense', 300, 0],
    ]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([...accountingClassExportFields].sort());
      expect(JSON.stringify(row)).not.toMatch(
        /patient-ar|acct-1|service-revenue|journalId|sourceRef/,
      );
    }
    expect(accountClassOf('mystery-account')).toBe('other');
  });
});
