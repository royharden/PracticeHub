/**
 * WP-059 rework 1 regressions (review D46-WP-059-a1-review-1). This file uses
 * only the landed export API (journals simply gain an `occurredAt` field), so it
 * can be run against the landed bytes to show the period finding failing there.
 */
import { describe, expect, it } from 'vitest';

import { buildAccountingExport } from './accounting-export.js';
import {
  BalancedLedger,
  type LedgerLine,
  type LedgerPostInput,
  type LedgerRail,
} from './ledger.js';

const tenant = 'northwind-synthetic';

const pair = (amount: number, sourceRef: string): LedgerLine[] => [
  { accountRef: 'cash', side: 'debit', amountMinor: amount, currency: 'USD', sourceRef },
  {
    accountRef: 'service-liability',
    side: 'credit',
    amountMinor: amount,
    currency: 'USD',
    sourceRef,
  },
];

function populated(): BalancedLedger {
  const ledger = new BalancedLedger();
  const post = (id: string, rail: LedgerRail, amount: number, occurredAt: string) =>
    ledger.postBalancedSet({
      tenantId: tenant,
      journalId: id,
      correlationId: `c-${id}`,
      idempotencyKey: `k-${id}`,
      rail,
      occurredAt,
      lines: pair(amount, id),
    } as LedgerPostInput);
  post('dec', 'cash', 100, '2025-12-31T23:59:59.000Z');
  post('jan-start', 'cash', 2500, '2026-01-01T00:00:00.000Z');
  post('jan-mid', 'membership', 700, '2026-01-15T10:00:00.000Z');
  post('jan-end', 'insurance', 40, '2026-01-31T23:59:59.000Z');
  post('feb', 'cash', 9000, '2026-02-01T00:00:00.000Z');
  ledger.postBalancedSet({
    tenantId: tenant,
    journalId: 'jan-start-reversal',
    correlationId: 'c-rev',
    idempotencyKey: 'k-rev',
    rail: 'cash',
    occurredAt: '2026-01-20T09:00:00.000Z',
    reversalOfJournalId: 'jan-start',
    lines: pair(2500, 'jan-start').map((line) => ({
      ...line,
      side: line.side === 'debit' ? ('credit' as const) : ('debit' as const),
    })),
  } as LedgerPostInput);
  ledger.postBalancedSet({
    tenantId: 'riverbend-synthetic',
    journalId: 'other-tenant',
    correlationId: 'c-o',
    idempotencyKey: 'k-o',
    rail: 'cash',
    occurredAt: '2026-01-10T00:00:00.000Z',
    lines: pair(55_555, 'other'),
  } as LedgerPostInput);
  return ledger;
}

const january = {
  tenantId: tenant,
  periodStart: '2026-01-01',
  periodEnd: '2026-01-31',
  currency: 'USD',
};

describe('[high] the export counts only journals dated inside its period (review P2)', () => {
  it('totals January only, boundaries included, across rails and a reversal', () => {
    const ledger = populated();
    // jan-start 2500 + jan-mid 700 + jan-end 40 + reversal 2500 (both sides each).
    expect(buildAccountingExport(ledger, january)).toMatchObject({
      debitMinor: 5740,
      creditMinor: 5740,
    });
    expect(buildAccountingExport(ledger, { ...january, rail: 'cash' })).toMatchObject({
      debitMinor: 5000,
      creditMinor: 5000,
    });
    expect(buildAccountingExport(ledger, { ...january, rail: 'insurance' })).toMatchObject({
      debitMinor: 40,
    });
  });

  it('puts nothing from 2026 into a 1999 export', () => {
    expect(
      buildAccountingExport(populated(), {
        ...january,
        periodStart: '1999-01-01',
        periodEnd: '1999-01-31',
      }),
    ).toMatchObject({ debitMinor: 0, creditMinor: 0 });
  });
});

describe('[low] a populated export carries no general-ledger detail', () => {
  it('renders no journal, account, source or line keys with a reversal and several rails present', () => {
    for (const rail of ['all', 'cash', 'membership', 'insurance'] as const) {
      const rendered = JSON.stringify(buildAccountingExport(populated(), { ...january, rail }));
      for (const detail of [
        'accountRef',
        'journalId',
        'sourceRef',
        'lines',
        'jan-start',
        'service-liability',
      ]) {
        expect(rendered).not.toContain(detail);
      }
    }
  });
});
