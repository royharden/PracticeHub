import { LedgerError, type BalancedLedger, type LedgerRail, type LedgerSide } from './ledger.js';
import { assertSafeInteger } from './money.js';

export interface PayoutLedgerLine {
  readonly rail: LedgerRail;
  readonly currency: string;
  readonly side: LedgerSide;
  readonly amountMinor: number;
  readonly accountRef: string;
  /** When present, must equal the reconciled tenant; a mismatch is `INVALID_LINE`. */
  readonly tenantId?: string;
  /** When present, must equal the reconciled payout; a mismatch is `INVALID_LINE`. */
  readonly payoutRef?: string;
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
  /** Present when the run was named; each drifting run opens its own item (0068 key). */
  readonly reconciliationId?: string;
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
  readonly reconciliationId?: string;
}): PayoutReconciliation {
  assertPayoutInput(input);
  for (const line of input.lines) {
    if (
      (line.tenantId !== undefined && line.tenantId !== input.tenantId) ||
      (line.payoutRef !== undefined && line.payoutRef !== input.payoutRef)
    ) {
      throw new LedgerError('INVALID_LINE');
    }
  }
  return reconcileMinor(input, ledgerCashMinor(input.lines, input.currency));
}

/**
 * Reconcile one payout against the ledger itself: the cash side comes from
 * `ledger.cashPayoutMinor`, which already filters by tenant, cash rail and
 * payout, so no caller-supplied line can leak into the total.
 */
export function reconcilePayoutFromLedger(
  ledger: BalancedLedger,
  input: {
    readonly tenantId: string;
    readonly payoutRef: string;
    readonly currency: string;
    readonly payoutAmountMinor: number;
    readonly reconciliationId?: string;
  },
): PayoutReconciliation {
  assertPayoutInput(input);
  return reconcileMinor(
    input,
    ledger.cashPayoutMinor(input.tenantId, input.payoutRef, input.currency),
  );
}

function assertPayoutInput(input: {
  readonly tenantId: string;
  readonly payoutRef: string;
  readonly currency: string;
  readonly payoutAmountMinor: number;
  readonly reconciliationId?: string;
}): void {
  if (input.tenantId.trim() === '' || input.payoutRef.trim() === '') {
    throw new LedgerError('INVALID_LINE');
  }
  if (input.reconciliationId !== undefined && input.reconciliationId.trim() === '') {
    throw new LedgerError('INVALID_LINE');
  }
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new LedgerError('INVALID_LINE');
  try {
    assertSafeInteger(input.payoutAmountMinor, 'payout', true);
  } catch {
    throw new LedgerError('INVALID_LINE');
  }
}

function reconcileMinor(
  input: {
    readonly tenantId: string;
    readonly payoutRef: string;
    readonly currency: string;
    readonly payoutAmountMinor: number;
    readonly reconciliationId?: string;
  },
  ledgerMinor: number,
): PayoutReconciliation {
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
        ...(input.reconciliationId === undefined
          ? {}
          : { reconciliationId: input.reconciliationId }),
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
