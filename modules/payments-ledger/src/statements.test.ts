import type { CapabilityGrant, CapabilityId, CapabilityState } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { BalancedLedger, LedgerError } from './ledger.js';
import {
  issueDunningNotice,
  issueStatement,
  postRefund,
  recordDeceasedStatus,
  registerCreditBalanceClock,
  StatementError,
  wp019CreditBalanceClockPlaceholder,
  type DunningAccount,
  type GuarantorTerm,
} from './statements.js';

const grant = (
  capabilityId: CapabilityId,
  state: CapabilityState,
  evidenceRefs: readonly string[],
): CapabilityGrant => ({
  capabilityId,
  tenantId: 'northwind-synthetic',
  scope: {},
  state,
  sinceEventId: null,
  evidenceRefs,
  rollbackRef: 'rollback-synthetic',
  synthetic: true,
});

const guarantors: readonly GuarantorTerm[] = [
  { version: 1, effectiveOn: '2026-01-01', guarantorRef: 'guarantor-alex' },
  { version: 2, effectiveOn: '2026-06-01', guarantorRef: 'guarantor-bailey' },
];

const evidenced = [
  grant('membership.entitlement-ledger', 'simulated', ['synthetic-entitlement-evidence-0001']),
];

describe('WP-057 statements, dunning, refunds, and clocks', () => {
  it('stops dunning in the same operation that records deceased status', () => {
    const account: DunningAccount = {
      tenantId: 'northwind-synthetic',
      accountRef: 'acct-1',
      deceased: false,
      dunning: 'active',
    };
    expect(issueDunningNotice(account, 'notice-1')).toBe('notice-1');
    const stopped = recordDeceasedStatus(account);
    expect(stopped).toEqual({
      tenantId: 'northwind-synthetic',
      accountRef: 'acct-1',
      deceased: true,
      dunning: 'stopped',
      stoppedReason: 'deceased',
    });
    expect(() => issueDunningNotice(stopped, 'notice-2')).toThrowError(
      new StatementError('DUNNING_STOPPED'),
    );
  });

  it('does not post a second balanced set when the same refund is repeated', () => {
    const ledger = new BalancedLedger();
    ledger.postBalancedSet({
      tenantId: 'northwind-synthetic',
      journalId: 'journal-pay',
      correlationId: 'corr-pay',
      idempotencyKey: 'pay-key',
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
    const refund = {
      tenantId: 'northwind-synthetic',
      originalJournalId: 'journal-pay',
      refundJournalId: 'journal-refund',
      correlationId: 'corr-refund',
      idempotencyKey: 'refund-key',
    };
    const first = postRefund(ledger, refund);
    const second = postRefund(ledger, refund);
    expect(second).toEqual(first);
    expect(ledger.journals()).toHaveLength(2);
    expect(() =>
      postRefund(ledger, {
        ...refund,
        refundJournalId: 'journal-refund-2',
        idempotencyKey: 'refund-key-2',
      }),
    ).toThrowError(new LedgerError('ALREADY_REVERSED'));
    expect(ledger.journals()).toHaveLength(2);
  });

  it('registers a 60-day credit-balance clock and names the guarantor effective at issue', () => {
    const clock = registerCreditBalanceClock({
      clockId: 'clock-credit-1',
      tenantId: 'northwind-synthetic',
      accountRef: 'acct-1',
      triggeredAt: '2026-01-01T00:00:00.000Z',
      amountMinor: 2500,
      currency: 'USD',
    });
    expect(clock.registered).toBe(true);
    expect(clock.durationDays).toBe(60);
    expect(clock.dueAt).toBe('2026-03-02T00:00:00.000Z');
    expect(clock.placeholder).toEqual(wp019CreditBalanceClockPlaceholder);
    const before = issueStatement({
      grants: evidenced,
      tenantId: 'northwind-synthetic',
      accountRef: 'acct-1',
      statementId: 'stmt-1',
      issueOn: '2026-05-01',
      guarantors,
    });
    expect(before.guarantorRef).toBe('guarantor-alex');
    expect(before.guarantorVersion).toBe(1);
    const onBoundary = issueStatement({
      grants: evidenced,
      tenantId: 'northwind-synthetic',
      accountRef: 'acct-1',
      statementId: 'stmt-2',
      issueOn: '2026-06-01',
      guarantors,
    });
    expect(onBoundary.guarantorRef).toBe('guarantor-bailey');
  });

  it('denies a statement when entitlement-ledger evidence is absent', () => {
    expect(() =>
      issueStatement({
        grants: [grant('membership.entitlement-ledger', 'simulated', [])],
        tenantId: 'northwind-synthetic',
        accountRef: 'acct-1',
        statementId: 'stmt-denied',
        issueOn: '2026-05-01',
        guarantors,
      }),
    ).toThrowError(new StatementError('ENTITLEMENT_EVIDENCE_ABSENT'));
    expect(() =>
      issueStatement({
        grants: [],
        tenantId: 'northwind-synthetic',
        accountRef: 'acct-1',
        statementId: 'stmt-denied-2',
        issueOn: '2026-05-01',
        guarantors,
      }),
    ).toThrowError(new StatementError('ENTITLEMENT_EVIDENCE_ABSENT'));
  });
});
