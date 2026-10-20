import { type BalancedLedger, type LedgerPostInput, type LedgerRail } from './ledger.js';

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
  public constructor(public readonly code: 'GL_DETAIL' | 'INVALID' | 'UNDATED_JOURNAL') {
    super(code);
    this.name = 'AccountingExportError';
  }
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

interface ExportInput {
  readonly tenantId: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currency: string;
  readonly rail?: LedgerRail | 'all';
}

function assertExportInput(input: ExportInput): void {
  if (
    input.tenantId.trim() === '' ||
    !datePattern.test(input.periodStart) ||
    !datePattern.test(input.periodEnd) ||
    Number.isNaN(Date.parse(`${input.periodStart}T00:00:00Z`)) ||
    Number.isNaN(Date.parse(`${input.periodEnd}T00:00:00Z`)) ||
    input.periodEnd < input.periodStart ||
    !/^[A-Z]{3}$/.test(input.currency)
  ) {
    throw new AccountingExportError('INVALID');
  }
}

/**
 * The in-scope journals for one export: this tenant and rail, dated inside
 * `[periodStart, periodEnd]` by their UTC accounting date. A journal in scope
 * by tenant and rail that carries no date cannot be placed in any period, so
 * the export refuses with `UNDATED_JOURNAL` rather than guess.
 */
function journalsInPeriod(ledger: BalancedLedger, input: ExportInput): readonly LedgerPostInput[] {
  const rail = input.rail ?? 'all';
  const selected: LedgerPostInput[] = [];
  for (const journal of ledger.journals()) {
    if (journal.tenantId !== input.tenantId) continue;
    if (rail !== 'all' && (journal.rail ?? 'cash') !== rail) continue;
    if (!journal.lines.some((line) => line.currency === input.currency)) continue;
    if (journal.occurredAt === undefined) throw new AccountingExportError('UNDATED_JOURNAL');
    const accountingDate = new Date(journal.occurredAt).toISOString().slice(0, 10);
    if (accountingDate < input.periodStart || accountingDate > input.periodEnd) continue;
    selected.push(journal);
  }
  return selected;
}

/**
 * Totals only. Journal ids, account refs, source refs, and line arrays are
 * read in order to sum, then dropped. The returned object has no other keys.
 * Only journals dated inside the period are counted.
 */
export function buildAccountingExport(
  ledger: BalancedLedger,
  input: ExportInput,
): AccountingExportSummary {
  assertExportInput(input);
  const rail = input.rail ?? 'all';
  let debitMinor = 0;
  let creditMinor = 0;
  for (const journal of journalsInPeriod(ledger, input)) {
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

/**
 * Account classes for the per-class summary. A class is a bounded grouping,
 * never an account ref: the export still carries no general-ledger detail.
 */
export const accountClasses = ['asset', 'liability', 'revenue', 'expense', 'other'] as const;
export type AccountClass = (typeof accountClasses)[number];

/** Map an account ref to its class by the module's account naming. Unknown refs are `other`. */
export function accountClassOf(accountRef: string): AccountClass {
  if (accountRef === 'cash' || accountRef.startsWith('cash-')) return 'asset';
  if (accountRef === 'accounts-receivable' || accountRef.startsWith('patient-ar:')) return 'asset';
  if (accountRef.endsWith('liability') || accountRef.startsWith('liability')) return 'liability';
  if (accountRef.endsWith('revenue') || accountRef.startsWith('revenue')) return 'revenue';
  if (accountRef.endsWith('expense') || accountRef.startsWith('expense')) return 'expense';
  return 'other';
}

export const accountingClassExportFields = [...accountingExportFields, 'accountClass'] as const;

export interface AccountingClassSummary extends AccountingExportSummary {
  readonly accountClass: AccountClass;
}

/**
 * Per-class totals for the same period and scope: one row per account class
 * that has in-period activity, in `accountClasses` order. Each row carries only
 * `accountingClassExportFields`.
 */
export function buildAccountingClassExport(
  ledger: BalancedLedger,
  input: ExportInput,
): readonly AccountingClassSummary[] {
  assertExportInput(input);
  const rail = input.rail ?? 'all';
  const totals = new Map<AccountClass, { debitMinor: number; creditMinor: number }>();
  for (const journal of journalsInPeriod(ledger, input)) {
    for (const line of journal.lines) {
      if (line.currency !== input.currency) continue;
      const accountClass = accountClassOf(line.accountRef);
      const total = totals.get(accountClass) ?? { debitMinor: 0, creditMinor: 0 };
      if (line.side === 'debit') total.debitMinor += line.amountMinor;
      else total.creditMinor += line.amountMinor;
      if (!Number.isSafeInteger(total.debitMinor) || !Number.isSafeInteger(total.creditMinor)) {
        throw new AccountingExportError('INVALID');
      }
      totals.set(accountClass, total);
    }
  }
  return accountClasses
    .filter((accountClass) => totals.has(accountClass))
    .map((accountClass) => {
      const total = totals.get(accountClass) ?? { debitMinor: 0, creditMinor: 0 };
      return {
        tenantId: input.tenantId,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        currency: input.currency,
        rail,
        debitMinor: total.debitMinor,
        creditMinor: total.creditMinor,
        accountClass,
      };
    });
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
