import {
  capabilityRegistryV1,
  capabilityStateSatisfies,
  resolveCapabilityGrant,
  selectEffectiveVersion,
  type CapabilityGrant,
  type EffectiveDatedVersion,
} from '@practicehub/platform-core';

import { assertBillingAuthoritySimulated, BillingAuthorityError } from './billing-authority.js';
import { LedgerError, type BalancedLedger, type LedgerReceipt } from './ledger.js';
import { assertSafeInteger } from './money.js';

/**
 * WP-019's closed obligation union does not contain credit-balance yet
 * (FWD-CLOCK-057-REFUND). This placeholder is the type, the fixture, and the
 * package that later registration must replace. A clock counts as registered
 * only once a `CreditBalanceClockRegistry` accepts it; the in-memory registry
 * below stands for the WP-019 clock engine and the credit_balance_clock table.
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
      | 'ENTITLEMENT_EVIDENCE_ABSENT'
      | 'BILLING_AUTHORITY_DENIED'
      | 'NO_GUARANTOR'
      | 'DUNNING_STOPPED'
      | 'UNKNOWN_ACCOUNT'
      | 'STATEMENT_ID_CONFLICT'
      | 'INVALID',
  ) {
    super(code);
    this.name = 'StatementError';
  }
}

/**
 * Issued-statement record (NR-141). Mirrors `payments_ledger.statement`, whose
 * primary key (tenant_id, statement_id) is the durable half of the same rule:
 * a statement id is issued once, and a replay returns the original statement.
 */
export interface IssuedStatementRegistry {
  get(tenantId: string, statementId: string): PatientStatement | undefined;
  record(statement: PatientStatement): void;
}

export function inMemoryIssuedStatementRegistry(): IssuedStatementRegistry {
  const issued = new Map<string, PatientStatement>();
  return {
    get: (tenantId, statementId) => issued.get(JSON.stringify([tenantId, statementId])),
    record: (statement) => {
      issued.set(
        JSON.stringify([statement.tenantId, statement.statementId]),
        Object.freeze({ ...statement }),
      );
    },
  };
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

/**
 * Dunning state for existing accounts. `recordDeceased` moves an account that
 * already exists to deceased + stopped in one step and can never be undone;
 * `issueNotice` reads the current state, so a notice after the stop is
 * refused. This mirrors the 0069 `payments_ledger.record_deceased_stop`
 * function and its irreversibility trigger.
 */
export class DunningRegister {
  readonly #accounts = new Map<string, DunningAccount>();
  readonly #history: DunningAccount[] = [];

  #key(tenantId: string, accountRef: string): string {
    return JSON.stringify([tenantId, accountRef]);
  }

  public open(tenantId: string, accountRef: string): DunningAccount {
    if (tenantId.trim() === '' || accountRef.trim() === '') throw new StatementError('INVALID');
    const key = this.#key(tenantId, accountRef);
    const existing = this.#accounts.get(key);
    if (existing !== undefined) return existing;
    const account: DunningAccount = { tenantId, accountRef, deceased: false, dunning: 'active' };
    this.#accounts.set(key, account);
    this.#history.push(account);
    return account;
  }

  public current(tenantId: string, accountRef: string): DunningAccount {
    const account = this.#accounts.get(this.#key(tenantId, accountRef));
    if (account === undefined) throw new StatementError('UNKNOWN_ACCOUNT');
    return account;
  }

  public recordDeceased(tenantId: string, accountRef: string): DunningAccount {
    const stopped = recordDeceasedStatus(this.current(tenantId, accountRef));
    this.#accounts.set(this.#key(tenantId, accountRef), stopped);
    this.#history.push(stopped);
    return stopped;
  }

  public issueNotice(tenantId: string, accountRef: string, noticeRef: string): string {
    return issueDunningNotice(this.current(tenantId, accountRef), noticeRef);
  }

  /** Every state an account has held, oldest first. */
  public history(tenantId: string, accountRef: string): readonly DunningAccount[] {
    return this.#history.filter(
      (entry) => entry.tenantId === tenantId && entry.accountRef === accountRef,
    );
  }
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
    /** The refund's own accounting instant; accounting exports place it by this date. */
    readonly occurredAt?: string;
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
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
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

/**
 * The registration seam for credit-balance clocks. The WP-019 clock engine
 * (and the credit_balance_clock table) replace the in-memory registry; the
 * contract is the same: one open clock per tenant, account and currency.
 */
export interface CreditBalanceClockRegistry {
  register(clock: CreditBalanceClock): {
    readonly clock: CreditBalanceClock;
    readonly created: boolean;
  };
  clocks(tenantId: string): readonly CreditBalanceClock[];
}

export function inMemoryCreditBalanceClockRegistry(): CreditBalanceClockRegistry {
  const open = new Map<string, CreditBalanceClock>();
  return {
    register(clock: CreditBalanceClock) {
      const key = JSON.stringify([clock.tenantId, clock.accountRef, clock.currency]);
      const existing = open.get(key);
      if (existing !== undefined) return { clock: existing, created: false };
      open.set(key, clock);
      return { clock, created: true };
    },
    clocks(tenantId: string): readonly CreditBalanceClock[] {
      return [...open.values()].filter((clock) => clock.tenantId === tenantId);
    },
  };
}

/**
 * Detect a credit balance on one patient receivable account and register its
 * clock. The balance is read from the ledger itself: when credits to
 * `receivableAccountRef` exceed debits in that currency, exactly one
 * 60-day clock opens for the account; running this again registers nothing new.
 */
export function registerCreditBalanceFromLedger(
  ledger: BalancedLedger,
  registry: CreditBalanceClockRegistry,
  input: {
    readonly tenantId: string;
    readonly accountRef: string;
    readonly receivableAccountRef: string;
    readonly currency: string;
    readonly at: string;
    readonly clockId: string;
  },
): { readonly clock: CreditBalanceClock; readonly created: boolean } | null {
  const row = ledger
    .accountBalances(input.tenantId)
    .find(
      (balance) =>
        balance.accountRef === input.receivableAccountRef && balance.currency === input.currency,
    );
  const creditMinor = row === undefined ? 0 : row.creditMinor - row.debitMinor;
  if (creditMinor <= 0) return null;
  return registry.register(
    registerCreditBalanceClock({
      clockId: input.clockId,
      tenantId: input.tenantId,
      accountRef: input.accountRef,
      triggeredAt: input.at,
      amountMinor: creditMinor,
      currency: input.currency,
    }),
  );
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

/**
 * Issue a statement. With `issued` (the issued-statement record) the call is
 * idempotent by (tenant, statementId): a replay returns the statement first
 * issued under that id, and the same id for another account or date is
 * `STATEMENT_ID_CONFLICT`. Authority is checked on every call, replay included.
 */
export function issueStatement(input: {
  readonly grants: readonly CapabilityGrant[];
  readonly tenantId: string;
  readonly accountRef: string;
  readonly statementId: string;
  readonly issueOn: string;
  readonly guarantors: readonly GuarantorTerm[];
  readonly issued?: IssuedStatementRegistry;
}): PatientStatement {
  return issueStatementOnce(input).statement;
}

/** `issueStatement` that also reports whether the call was a replay of an issued id. */
export function issueStatementOnce(input: {
  readonly grants: readonly CapabilityGrant[];
  readonly tenantId: string;
  readonly accountRef: string;
  readonly statementId: string;
  readonly issueOn: string;
  readonly guarantors: readonly GuarantorTerm[];
  readonly issued?: IssuedStatementRegistry;
}): { readonly statement: PatientStatement; readonly replay: boolean } {
  const statement = composeStatement(input);
  if (input.issued === undefined) {
    return { statement, replay: false };
  }
  const prior = input.issued.get(input.tenantId, input.statementId);
  if (prior !== undefined) {
    if (prior.accountRef !== input.accountRef || prior.issueOn !== input.issueOn) {
      throw new StatementError('STATEMENT_ID_CONFLICT');
    }
    return { statement: prior, replay: true };
  }
  input.issued.record(statement);
  return { statement, replay: false };
}

function composeStatement(input: {
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
  // IC-3 applies to every statement authority path (WP-057 contracts column).
  try {
    assertBillingAuthoritySimulated(input.grants, input.tenantId);
  } catch (error) {
    if (error instanceof BillingAuthorityError) {
      throw new StatementError('BILLING_AUTHORITY_DENIED');
    }
    throw error;
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
