import { describe, expect, it } from 'vitest';

import {
  accountingExportFields,
  assertBoundedAccountingExport,
  buildAccountingExport,
  AccountingExportError,
} from './accounting-export.js';
import { BalancedLedger } from './ledger.js';

describe('WP-059 bounded accounting export', () => {
  it('emits only the named summary fields', () => {
    const ledger = new BalancedLedger();
    ledger.postBalancedSet({
      tenantId: 'northwind-synthetic',
      journalId: 'journal-1',
      correlationId: 'corr-1',
      idempotencyKey: 'key-1',
      rail: 'cash',
      lines: [
        {
          accountRef: 'cash',
          side: 'debit',
          amountMinor: 2500,
          currency: 'USD',
          sourceRef: 'pay-1',
        },
        {
          accountRef: 'service-liability',
          side: 'credit',
          amountMinor: 2500,
          currency: 'USD',
          sourceRef: 'pay-1',
        },
      ],
    });
    const summary = buildAccountingExport(ledger, {
      tenantId: 'northwind-synthetic',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      currency: 'USD',
      rail: 'cash',
    });
    expect(Object.keys(summary).sort()).toEqual([...accountingExportFields].sort());
    expect(summary).toEqual({
      tenantId: 'northwind-synthetic',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      currency: 'USD',
      rail: 'cash',
      debitMinor: 2500,
      creditMinor: 2500,
    });
    expect(assertBoundedAccountingExport(summary)).toEqual(summary);
  });

  it('rejects an export that carries general-ledger line detail', () => {
    const withLines = {
      tenantId: 'northwind-synthetic',
      periodStart: '2026-01-01',
      periodEnd: '2026-01-31',
      currency: 'USD',
      rail: 'cash',
      debitMinor: 2500,
      creditMinor: 2500,
      lines: [
        {
          journalId: 'journal-1',
          accountRef: 'cash',
          sourceRef: 'pay-1',
          amountMinor: 2500,
        },
      ],
    };
    expect(() => assertBoundedAccountingExport(withLines)).toThrowError(
      new AccountingExportError('GL_DETAIL'),
    );
    const rendered = JSON.stringify(
      buildAccountingExport(new BalancedLedger(), {
        tenantId: 'northwind-synthetic',
        periodStart: '2026-01-01',
        periodEnd: '2026-01-31',
        currency: 'USD',
      }),
    );
    expect(rendered).not.toContain('accountRef');
    expect(rendered).not.toContain('journalId');
    expect(rendered).not.toContain('sourceRef');
    expect(rendered).not.toContain('lines');
  });
});
