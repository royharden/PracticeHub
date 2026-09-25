import { type BalancedLedger, type LedgerRail } from './ledger.js';

/** Closed summary shape. General-ledger line fields are not members of this type. */
export const accountingExportFields = [
  'tenantId',
  'periodStart',
  'periodEnd',
  'currency',
  'rail',
  'debitMinor',
  'creditMinor',
] as const;

export type AccountingExportField = (typeof accountingExportFields)[number];

export interface AccountingExportSummary {
  readonly tenantId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: string;
  readonly rail: LedgerRail | 'all';
  readonly debitMinor: number;
  readonly creditMinor: number;
}

export class AccountingExportError extends Error {
  public constructor(public readonly code: 'GL_DETAIL' | 'INVALID') {
    super(code);
    this.name = 'AccountingExportError';
  }
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Totals only. Journal ids, account refs, source refs, and line arrays are
 * read in order to sum, then dropped. The returned object has no other keys.
 */
export function buildAccountingExport(
  ledger: BalancedLedger,
  input: {
    readonly tenantId: string;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly currency: string;
    readonly rail?: LedgerRail | 'all';
  },
): AccountingExportSummary {
  if (
    input.tenantId.trim() === '' ||
    !datePattern.test(input.periodStart) ||
    !datePattern.test(input.periodEnd) ||
    input.periodEnd < input.periodStart ||
    !/^[A-Z]{3}$/.test(input.currency)
  ) {
    throw new AccountingExportError('INVALID');
  }
  const rail = input.rail ?? 'all';
  let debitMinor = 0;
  let creditMinor = 0;
  for (const journal of ledger.journals()) {
    if (journal.tenantId !== input.tenantId) continue;
    if (rail !== 'all' && (journal.rail ?? 'cash') !== rail) continue;
    for (const line of journal.lines) {
      if (line.currency !== input.currency) continue;
      if (line.side === 'debit') debitMinor += line.amountMinor;
      else creditMinor += line.amountMinor;
    }
  }
  if (!Number.isSafeInteger(debitMinor) || !Number.isSafeInteger(creditMinor)) {
    throw new AccountingExportError('INVALID');
  }
  return {
    tenantId: input.tenantId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    currency: input.currency,
    rail,
    debitMinor,
    creditMinor,
  };
}

/** Reject a value that carries any key outside the bounded summary, including line detail. */
export function assertBoundedAccountingExport(value: object): AccountingExportSummary {
  const keys = Object.keys(value);
  const allowed = new Set<string>(accountingExportFields);
  if (keys.some((key) => !allowed.has(key)) || keys.length !== accountingExportFields.length) {
    throw new AccountingExportError('GL_DETAIL');
  }
  return value as AccountingExportSummary;
}
