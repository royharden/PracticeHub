import { LedgerError, type LedgerRail, type LedgerSide } from './ledger.js';
import { assertSafeInteger } from './money.js';

export interface PayoutLedgerLine {
  readonly rail: LedgerRail;
  readonly currency: string;
  readonly side: LedgerSide;
  readonly amountMinor: number;
  readonly accountRef: string;
}

export interface PayoutDriftWorkItem {
  readonly origin: 'payments-ledger';
  readonly purpose: 'payout-reconciliation-drift';
  readonly tenantId: string;
  readonly payoutRef: string;
  readonly currency: string;
  readonly ledgerMinor: number;
  readonly payoutMinor: number;
  readonly driftMinor: number;
}

export interface PayoutReconciliation {
  readonly matched: boolean;
  readonly tenantId: string;
  readonly payoutRef: string;
  readonly currency: string;
  readonly ledgerMinor: number;
  readonly payoutMinor: number;
  readonly driftMinor: number;
  readonly workItem: PayoutDriftWorkItem | null;
}

/** Cash-account minor units on the cash rail. Other rails and accounts are excluded, never adjusted. */
export function ledgerCashMinor(lines: readonly PayoutLedgerLine[], currency: string): number {
  let net = 0;
  for (const line of lines) {
    if (line.rail !== 'cash' || line.currency !== currency || line.accountRef !== 'cash') continue;
    try {
      assertSafeInteger(line.amountMinor, 'payout line');
    } catch {
      throw new LedgerError('INVALID_LINE');
    }
    const signed = line.side === 'debit' ? line.amountMinor : -line.amountMinor;
    const next = net + signed;
    if (!Number.isSafeInteger(next)) throw new LedgerError('INVALID_LINE');
    net = next;
  }
  return net;
}

/**
 * Compare one processor payout to the ledger cash it should equal.
 * Any nonzero minor-unit difference opens a work item and does not change the lines.
 */
export function reconcilePayoutToThePenny(input: {
  readonly tenantId: string;
  readonly payoutRef: string;
  readonly currency: string;
  readonly payoutAmountMinor: number;
  readonly lines: readonly PayoutLedgerLine[];
}): PayoutReconciliation {
  if (input.tenantId.trim() === '' || input.payoutRef.trim() === '') {
    throw new LedgerError('INVALID_LINE');
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new LedgerError('INVALID_LINE');
  try {
    assertSafeInteger(input.payoutAmountMinor, 'payout', true);
  } catch {
    throw new LedgerError('INVALID_LINE');
  }
  const ledgerMinor = ledgerCashMinor(input.lines, input.currency);
  const driftMinor = input.payoutAmountMinor - ledgerMinor;
  if (!Number.isSafeInteger(driftMinor)) throw new LedgerError('INVALID_LINE');
  const matched = driftMinor === 0;
  const workItem: PayoutDriftWorkItem | null = matched
    ? null
    : {
        origin: 'payments-ledger',
        purpose: 'payout-reconciliation-drift',
        tenantId: input.tenantId,
        payoutRef: input.payoutRef,
        currency: input.currency,
        ledgerMinor,
        payoutMinor: input.payoutAmountMinor,
        driftMinor,
      };
  return {
    matched,
    tenantId: input.tenantId,
    payoutRef: input.payoutRef,
    currency: input.currency,
    ledgerMinor,
    payoutMinor: input.payoutAmountMinor,
    driftMinor,
    workItem,
  };
}
