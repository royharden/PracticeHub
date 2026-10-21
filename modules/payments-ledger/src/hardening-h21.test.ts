/**
 * WP-057 hardening H-21: idempotent statement issue (NR-141), write-offs
 * capped at the open receivable, and the deprecated tier-only write-off path
 * refused (review D46-WP-056-a2-review-2).
 */
import type { CapabilityGrant, CapabilityId, CapabilityState } from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { BalancedLedger } from './ledger.js';
import {
  inMemoryIssuedStatementRegistry,
  issueStatement,
  issueStatementOnce,
  StatementError,
  type GuarantorTerm,
} from './statements.js';
import {
  approveWriteOff,
  authorizeWriteOff,
  openReceivableMinor,
  postApprovedWriteOff,
  postWriteOff,
  simulatedWriteOffAuthority,
  WriteOffError,
  type WriteOffRequest,
} from './write-off.js';

const tenant = 'northwind-synthetic';

const grant = (
  capabilityId: CapabilityId,
  state: CapabilityState,
  evidenceRef: string,
): CapabilityGrant => ({
  capabilityId,
  tenantId: tenant,
  scope: {},
  state,
  sinceEventId: null,
  evidenceRefs: [evidenceRef],
  rollbackRef: 'rollback-synthetic',
  synthetic: true,
});
const grants = [
  grant('membership.entitlement-ledger', 'simulated', 'synthetic-entitlement-evidence-0001'),
  grant('finance.billing-authority', 'simulated', 'synthetic-billing-evidence-0001'),
];
const guarantors: readonly GuarantorTerm[] = [
  { version: 1, effectiveOn: '2026-01-01', guarantorRef: 'guarantor-alex' },
  { version: 2, effectiveOn: '2026-06-01', guarantorRef: 'guarantor-bailey' },
];
const input = {
  grants,
  tenantId: tenant,
  accountRef: 'acct-1',
  statementId: 'stmt-h21',
  issueOn: '2026-05-01',
  guarantors,
};

describe('NR-141: statement issue is idempotent by statement id', () => {
  it('a replay returns the statement first issued under that id, flagged as a replay', () => {
    const issued = inMemoryIssuedStatementRegistry();
    const first = issueStatementOnce({ ...input, issued });
    expect(first.replay).toBe(false);
    // The guarantor changed since the first issue; the replay still returns the original statement.
    const later: readonly GuarantorTerm[] = [
      { version: 3, effectiveOn: '2026-01-01', guarantorRef: 'guarantor-casey' },
    ];
    const again = issueStatementOnce({ ...input, guarantors: later, issued });
    expect(again.replay).toBe(true);
    expect(again.statement).toEqual(first.statement);
    expect(issued.get(tenant, 'stmt-h21')?.guarantorRef).toBe('guarantor-alex');
  });

  it('the same id for another account or date is a conflict, not a second statement', () => {
    const issued = inMemoryIssuedStatementRegistry();
    issueStatement({ ...input, issued });
    expect(() => issueStatement({ ...input, accountRef: 'acct-2', issued })).toThrowError(
      new StatementError('STATEMENT_ID_CONFLICT'),
    );
    expect(() => issueStatement({ ...input, issueOn: '2026-05-02', issued })).toThrowError(
      new StatementError('STATEMENT_ID_CONFLICT'),
    );
  });

  it('authority is still checked on a replay', () => {
    const issued = inMemoryIssuedStatementRegistry();
    issueStatement({ ...input, issued });
    expect(() =>
      issueStatement({ ...input, grants: [grants[0] as CapabilityGrant], issued }),
    ).toThrowError(new StatementError('BILLING_AUTHORITY_DENIED'));
  });
});

const authority = simulatedWriteOffAuthority([
  { tenantId: tenant, actorId: 'synthetic-clerk-1', role: 'billing-clerk' },
  { tenantId: tenant, actorId: 'synthetic-supervisor-1', role: 'billing-supervisor' },
]);
const request = (overrides: Partial<WriteOffRequest> = {}): WriteOffRequest => ({
  tenantId: tenant,
  writeOffId: 'wo-h21-1',
  targetRef: 'ar-1',
  amountMinor: 900,
  currency: 'USD',
  reason: 'small-balance',
  rail: 'cash',
  requesterActorId: 'synthetic-clerk-1',
  approverActorId: 'synthetic-supervisor-1',
  ...overrides,
});
const posting = (id: string) => ({
  journalId: id,
  correlationId: `c-${id}`,
  idempotencyKey: `k-${id}`,
});
function chargedLedger(amountMinor = 900): BalancedLedger {
  const ledger = new BalancedLedger();
  ledger.postBalancedSet({
    tenantId: tenant,
    journalId: 'ar-charge-1',
    correlationId: 'ar-c-1',
    idempotencyKey: 'ar-k-1',
    lines: [
      {
        accountRef: 'accounts-receivable',
        side: 'debit',
        amountMinor,
        currency: 'USD',
        sourceRef: 'ar-1',
      },
      {
        accountRef: 'service-revenue',
        side: 'credit',
        amountMinor,
        currency: 'USD',
        sourceRef: 'ar-1',
      },
    ],
  });
  return ledger;
}

describe('write-offs are capped at the open receivable', () => {
  it('two approvals with different write-off ids cannot write off the same 900 receivable twice (review probe)', () => {
    const ledger = chargedLedger();
    postApprovedWriteOff(ledger, authority, approveWriteOff(authority, request()), posting('wo-a'));
    expect(() =>
      postApprovedWriteOff(
        ledger,
        authority,
        approveWriteOff(authority, request({ writeOffId: 'wo-h21-2' })),
        posting('wo-b'),
      ),
    ).toThrowError(new WriteOffError('EXCEEDS_OPEN_RECEIVABLE'));
    const ar = ledger
      .accountBalances(tenant)
      .find((row) => row.accountRef === 'accounts-receivable');
    expect(ar).toMatchObject({ debitMinor: 900, creditMinor: 900 });
    expect(openReceivableMinor(ledger, tenant, 'ar-1', 'USD')).toBe(0);
  });

  it('partial write-offs add up to the open balance and no further, and a receivable never charged cannot be written off', () => {
    const ledger = chargedLedger();
    postApprovedWriteOff(
      ledger,
      authority,
      approveWriteOff(authority, request({ amountMinor: 600 })),
      posting('wo-a'),
    );
    expect(() =>
      postApprovedWriteOff(
        ledger,
        authority,
        approveWriteOff(authority, request({ writeOffId: 'wo-h21-2', amountMinor: 301 })),
        posting('wo-b'),
      ),
    ).toThrowError(new WriteOffError('EXCEEDS_OPEN_RECEIVABLE'));
    postApprovedWriteOff(
      ledger,
      authority,
      approveWriteOff(authority, request({ writeOffId: 'wo-h21-3', amountMinor: 300 })),
      posting('wo-c'),
    );
    expect(openReceivableMinor(ledger, tenant, 'ar-1', 'USD')).toBe(0);
    expect(() =>
      postApprovedWriteOff(
        new BalancedLedger(),
        authority,
        approveWriteOff(authority, request({ targetRef: 'ar-never' })),
        posting('wo-x'),
      ),
    ).toThrowError(new WriteOffError('EXCEEDS_OPEN_RECEIVABLE'));
  });

  it('an identical retry of a posted write-off is still idempotent after the receivable is settled', () => {
    const ledger = chargedLedger();
    const approval = approveWriteOff(authority, request());
    const first = postApprovedWriteOff(ledger, authority, approval, posting('wo-a'));
    expect(postApprovedWriteOff(ledger, authority, approval, posting('wo-a'))).toEqual(first);
  });
});

describe('the deprecated postWriteOff no longer trusts a caller role', () => {
  it('a self-declared rcm-lead charity write-off is refused (review probe P1b)', () => {
    const ledger = chargedLedger(5_000_000);
    const approval = authorizeWriteOff({
      tenantId: tenant,
      amountMinor: 5_000_000,
      currency: 'USD',
      reason: 'charity',
      role: 'rcm-lead',
      rail: 'cash',
    });
    expect(() =>
      postWriteOff(ledger, approval, { ...posting('wo-legacy'), sourceRef: 'ar-1' }),
    ).toThrowError(new WriteOffError('DEPRECATED_PATH_REFUSED'));
    expect(ledger.journals()).toHaveLength(1);
  });

  it('with an authority and a bound approval it routes through the governed path', () => {
    const ledger = chargedLedger();
    const approval = approveWriteOff(authority, request());
    postWriteOff(ledger, approval, { ...posting('wo-routed'), sourceRef: 'ar-1' }, authority);
    expect(ledger.journal(tenant, 'wo-routed')?.writeOff?.approverActorId).toBe(
      'synthetic-supervisor-1',
    );
    expect(() =>
      postWriteOff(ledger, approval, { ...posting('wo-moved'), sourceRef: 'ar-other' }, authority),
    ).toThrowError(new WriteOffError('APPROVAL_MISMATCH'));
  });
});
