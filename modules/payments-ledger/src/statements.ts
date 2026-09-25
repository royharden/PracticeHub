import {
  capabilityRegistryV1,
  capabilityStateSatisfies,
  resolveCapabilityGrant,
  selectEffectiveVersion,
  type CapabilityGrant,
  type EffectiveDatedVersion,
} from '@practicehub/platform-core';

import { LedgerError, type BalancedLedger, type LedgerReceipt } from './ledger.js';
import { assertSafeInteger } from './money.js';

/**
 * WP-019's closed obligation union does not contain credit-balance yet
 * (FWD-CLOCK-057-REFUND). This placeholder is the type, the fixture, and the
 * package that later registration must replace. The clock is still registered
 * here.
 */
export const wp019CreditBalanceClockPlaceholder = {
  packageId: 'WP-019',
  standsFor: 'FWD-CLOCK-057-REFUND',
  obligationType: 'credit-balance',
  fixtureId: 'credit-balance-medicare-60',
} as const;

export const creditBalanceDurationDays = 60;
export const creditBalanceEscalationLeadDays = 14;

export class StatementError extends Error {
  public constructor(
    public readonly code:
      'ENTITLEMENT_EVIDENCE_ABSENT' | 'NO_GUARANTOR' | 'DUNNING_STOPPED' | 'INVALID',
  ) {
    super(code);
    this.name = 'StatementError';
  }
}

export interface DunningAccount {
  readonly tenantId: string;
  readonly accountRef: string;
  readonly deceased: boolean;
  readonly dunning: 'active' | 'stopped';
  readonly stoppedReason?: 'deceased';
}

export interface GuarantorTerm extends EffectiveDatedVersion {
  readonly guarantorRef: string;
}

export interface CreditBalanceClock {
  readonly clockId: string;
  readonly tenantId: string;
  readonly accountRef: string;
  readonly obligationType: typeof wp019CreditBalanceClockPlaceholder.obligationType;
  readonly placeholder: typeof wp019CreditBalanceClockPlaceholder;
  readonly triggeredAt: string;
  readonly dueAt: string;
  readonly escalateAt: string;
  readonly durationDays: typeof creditBalanceDurationDays;
  readonly amountMinor: number;
  readonly currency: string;
  readonly registered: true;
}

export interface PatientStatement {
  readonly tenantId: string;
  readonly accountRef: string;
  readonly statementId: string;
  readonly issueOn: string;
  readonly guarantorRef: string;
  readonly guarantorVersion: number;
}

/** One operation records the deceased flag and stops dunning. No intermediate state is returned. */
export function recordDeceasedStatus(account: DunningAccount): DunningAccount {
  if (account.tenantId.trim() === '' || account.accountRef.trim() === '') {
    throw new StatementError('INVALID');
  }
  return {
    tenantId: account.tenantId,
    accountRef: account.accountRef,
    deceased: true,
    dunning: 'stopped',
    stoppedReason: 'deceased',
  };
}

export function issueDunningNotice(account: DunningAccount, noticeRef: string): string {
  if (account.deceased || account.dunning === 'stopped') {
    throw new StatementError('DUNNING_STOPPED');
  }
  if (noticeRef.trim() === '') throw new StatementError('INVALID');
  return noticeRef;
}

/** A repeated call with the same idempotency key returns the original reversal and posts nothing new. */
export function postRefund(
  ledger: BalancedLedger,
  input: {
    readonly tenantId: string;
    readonly originalJournalId: string;
    readonly refundJournalId: string;
    readonly correlationId: string;
    readonly idempotencyKey: string;
  },
): LedgerReceipt {
  const original = ledger.journal(input.tenantId, input.originalJournalId);
  if (original === undefined) throw new LedgerError('ORIGINAL_NOT_FOUND');
  const rail = original.rail ?? 'cash';
  return ledger.postBalancedSet({
    tenantId: input.tenantId,
    journalId: input.refundJournalId,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    rail,
    ...(original.payoutRef === undefined ? {} : { payoutRef: original.payoutRef }),
    reversalOfJournalId: original.journalId,
    lines: original.lines.map((line) => ({
      ...line,
      side: line.side === 'debit' ? ('credit' as const) : ('debit' as const),
    })),
  });
}

function addUtcDays(isoTimestamp: string, days: number): string {
  const parsed = Date.parse(isoTimestamp);
  if (Number.isNaN(parsed)) throw new StatementError('INVALID');
  return new Date(parsed + days * 86_400_000).toISOString();
}

export function registerCreditBalanceClock(input: {
  readonly clockId: string;
  readonly tenantId: string;
  readonly accountRef: string;
  readonly triggeredAt: string;
  readonly amountMinor: number;
  readonly currency: string;
}): CreditBalanceClock {
  if (
    input.clockId.trim() === '' ||
    input.tenantId.trim() === '' ||
    input.accountRef.trim() === '' ||
    !/^[A-Z]{3}$/.test(input.currency)
  ) {
    throw new StatementError('INVALID');
  }
  try {
    assertSafeInteger(input.amountMinor, 'credit balance');
  } catch {
    throw new StatementError('INVALID');
  }
  const dueAt = addUtcDays(input.triggeredAt, creditBalanceDurationDays);
  return {
    clockId: input.clockId,
    tenantId: input.tenantId,
    accountRef: input.accountRef,
    obligationType: wp019CreditBalanceClockPlaceholder.obligationType,
    placeholder: wp019CreditBalanceClockPlaceholder,
    triggeredAt: input.triggeredAt,
    dueAt,
    escalateAt: addUtcDays(dueAt, -creditBalanceEscalationLeadDays),
    durationDays: creditBalanceDurationDays,
    amountMinor: input.amountMinor,
    currency: input.currency,
    registered: true,
  };
}

function entitlementEvidencePresent(grants: readonly CapabilityGrant[], tenantId: string): boolean {
  const grant = resolveCapabilityGrant(
    capabilityRegistryV1,
    grants,
    { tenantId, scope: {} },
    'membership.entitlement-ledger',
  );
  return (
    grant !== undefined &&
    capabilityStateSatisfies(grant.state, 'simulated') &&
    grant.evidenceRefs.length > 0
  );
}

export function issueStatement(input: {
  readonly grants: readonly CapabilityGrant[];
  readonly tenantId: string;
  readonly accountRef: string;
  readonly statementId: string;
  readonly issueOn: string;
  readonly guarantors: readonly GuarantorTerm[];
}): PatientStatement {
  if (!entitlementEvidencePresent(input.grants, input.tenantId)) {
    throw new StatementError('ENTITLEMENT_EVIDENCE_ABSENT');
  }
  if (input.statementId.trim() === '' || input.accountRef.trim() === '') {
    throw new StatementError('INVALID');
  }
  const guarantor = selectEffectiveVersion(input.guarantors, input.issueOn);
  if (guarantor === undefined) throw new StatementError('NO_GUARANTOR');
  return {
    tenantId: input.tenantId,
    accountRef: input.accountRef,
    statementId: input.statementId,
    issueOn: input.issueOn,
    guarantorRef: guarantor.guarantorRef,
    guarantorVersion: guarantor.version,
  };
}
