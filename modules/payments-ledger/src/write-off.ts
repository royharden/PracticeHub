import { createHash } from 'node:crypto';

import { LedgerError, type BalancedLedger, type LedgerRail, type LedgerReceipt } from './ledger.js';
import { assertSafeInteger } from './money.js';

export const writeOffReasons = [
  'contractual-adjustment',
  'small-balance',
  'uncollectible',
  'charity',
] as const;
export type WriteOffReason = (typeof writeOffReasons)[number];

export const writeOffRoles = ['billing-clerk', 'billing-supervisor', 'rcm-lead'] as const;
export type WriteOffRole = (typeof writeOffRoles)[number];

const roleRank: Readonly<Record<WriteOffRole, number>> = {
  'billing-clerk': 0,
  'billing-supervisor': 1,
  'rcm-lead': 2,
};

/** Amount ceilings are minor units. small-balance cannot be stretched by a higher role. */
const reasonCeiling: Readonly<Record<WriteOffReason, number>> = {
  'small-balance': 1_000,
  'contractual-adjustment': Number.MAX_SAFE_INTEGER,
  uncollectible: Number.MAX_SAFE_INTEGER,
  charity: Number.MAX_SAFE_INTEGER,
};

const minimumRoleFor = (reason: WriteOffReason, amountMinor: number): WriteOffRole => {
  if (reason === 'charity') return 'rcm-lead';
  if (reason === 'uncollectible') return amountMinor <= 10_000 ? 'billing-supervisor' : 'rcm-lead';
  if (amountMinor <= 1_000) return 'billing-clerk';
  if (amountMinor <= 10_000) return 'billing-supervisor';
  return 'rcm-lead';
};

export class WriteOffError extends Error {
  public constructor(
    public readonly code: 'UNDER_AUTHORIZED' | 'TIER_EXCEEDED' | 'APPROVAL_MISMATCH',
  ) {
    super(code);
    this.name = 'WriteOffError';
  }
}

export interface WriteOffApproval {
  readonly tenantId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason: WriteOffReason;
  readonly role: WriteOffRole;
  readonly rail: LedgerRail;
  readonly approvalHash: string;
}

export function authorizeWriteOff(input: {
  readonly tenantId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason: WriteOffReason;
  readonly role: WriteOffRole;
  readonly rail: LedgerRail;
}): WriteOffApproval {
  if (input.tenantId.trim() === '' || !/^[A-Z]{3}$/.test(input.currency)) {
    throw new LedgerError('INVALID_LINE');
  }
  if (!writeOffReasons.includes(input.reason) || !writeOffRoles.includes(input.role)) {
    throw new LedgerError('INVALID_LINE');
  }
  try {
    assertSafeInteger(input.amountMinor, 'write-off');
  } catch {
    throw new LedgerError('INVALID_LINE');
  }
  if (input.amountMinor > reasonCeiling[input.reason]) throw new WriteOffError('TIER_EXCEEDED');
  if (roleRank[input.role] < roleRank[minimumRoleFor(input.reason, input.amountMinor)]) {
    throw new WriteOffError('UNDER_AUTHORIZED');
  }
  const approvalHash = createHash('sha256')
    .update(
      JSON.stringify([
        input.tenantId,
        input.amountMinor,
        input.currency,
        input.reason,
        input.role,
        input.rail,
      ]),
    )
    .digest('hex');
  return { ...input, approvalHash };
}

/** Post a new balanced write-off. The approval cannot edit a journal that already exists. */
export function postWriteOff(
  ledger: BalancedLedger,
  approval: WriteOffApproval,
  input: {
    readonly journalId: string;
    readonly correlationId: string;
    readonly idempotencyKey: string;
    readonly sourceRef: string;
  },
): LedgerReceipt {
  const expected = authorizeWriteOff(approval);
  if (expected.approvalHash !== approval.approvalHash) throw new WriteOffError('APPROVAL_MISMATCH');
  return ledger.postBalancedSet({
    tenantId: approval.tenantId,
    journalId: input.journalId,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    rail: approval.rail,
    lines: [
      {
        accountRef: 'write-off-expense',
        side: 'debit',
        amountMinor: approval.amountMinor,
        currency: approval.currency,
        sourceRef: input.sourceRef,
      },
      {
        accountRef: 'accounts-receivable',
        side: 'credit',
        amountMinor: approval.amountMinor,
        currency: approval.currency,
        sourceRef: input.sourceRef,
      },
    ],
  });
}
