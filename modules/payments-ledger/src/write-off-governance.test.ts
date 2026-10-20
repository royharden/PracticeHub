import { describe, expect, it } from 'vitest';

import { BalancedLedger } from './ledger.js';
import {
  approveWriteOff,
  postApprovedWriteOff,
  simulatedWriteOffAuthority,
  WriteOffError,
  writeOffRecords,
  type WriteOffRequest,
} from './write-off.js';

const tenant = 'northwind-synthetic';

const authority = simulatedWriteOffAuthority([
  { tenantId: tenant, actorId: 'synthetic-clerk-1', role: 'billing-clerk' },
  { tenantId: tenant, actorId: 'synthetic-supervisor-1', role: 'billing-supervisor' },
  { tenantId: tenant, actorId: 'synthetic-lead-1', role: 'rcm-lead' },
  { tenantId: 'riverbend-synthetic', actorId: 'synthetic-lead-2', role: 'rcm-lead' },
]);

const request = (overrides: Partial<WriteOffRequest> = {}): WriteOffRequest => ({
  tenantId: tenant,
  writeOffId: 'wo-gov-1',
  targetRef: 'ar-item-100',
  amountMinor: 900,
  currency: 'USD',
  reason: 'small-balance',
  rail: 'cash',
  requesterActorId: 'synthetic-clerk-1',
  approverActorId: 'synthetic-supervisor-1',
  ...overrides,
});

/**
 * H-21: a write-off is capped at the open receivable, so the ledger first
 * carries the 900 charge on ar-item-100 that these write-offs settle.
 */
const ledgerWithReceivable = (): BalancedLedger => {
  const ledger = new BalancedLedger();
  ledger.postBalancedSet({
    tenantId: tenant,
    journalId: 'ar-charge-100',
    correlationId: 'ar-corr-100',
    idempotencyKey: 'ar-key-100',
    lines: [
      {
        accountRef: 'accounts-receivable',
        side: 'debit',
        amountMinor: 900,
        currency: 'USD',
        sourceRef: 'ar-item-100',
      },
      {
        accountRef: 'service-revenue',
        side: 'credit',
        amountMinor: 900,
        currency: 'USD',
        sourceRef: 'ar-item-100',
      },
    ],
  });
  return ledger;
};

const posting = (suffix: string) => ({
  journalId: `wo-journal-${suffix}`,
  correlationId: `wo-corr-${suffix}`,
  idempotencyKey: `wo-key-${suffix}`,
});

describe('governed write-off: approver role comes from the authority', () => {
  it('refuses a self-declared rcm-lead charity write-off (review P1b)', () => {
    const ledger = new BalancedLedger();
    const clerkRequest = request({
      reason: 'charity',
      amountMinor: 5_000_000,
      approverActorId: 'synthetic-supervisor-1',
    });
    expect(() => approveWriteOff(authority, clerkRequest)).toThrowError(
      new WriteOffError('UNDER_AUTHORIZED'),
    );
    const legit = approveWriteOff(authority, request({ approverActorId: 'synthetic-lead-1' }));
    const forged = {
      ...legit,
      reason: 'charity' as const,
      amountMinor: 5_000_000,
      approverActorId: 'synthetic-supervisor-1',
    };
    expect(() => postApprovedWriteOff(ledger, authority, forged, posting('forged'))).toThrowError(
      new WriteOffError('UNDER_AUTHORIZED'),
    );
    const relabelled = { ...approveWriteOff(authority, request()), role: 'rcm-lead' as const };
    expect(() =>
      postApprovedWriteOff(ledger, authority, relabelled, posting('relabelled')),
    ).toThrowError(new WriteOffError('APPROVAL_MISMATCH'));
    expect(ledger.journals()).toHaveLength(0);
  });

  it('separates requester and approver and refuses unknown or cross-tenant approvers', () => {
    expect(() =>
      approveWriteOff(authority, request({ approverActorId: 'synthetic-clerk-1' })),
    ).toThrowError(new WriteOffError('SELF_APPROVAL'));
    expect(() =>
      approveWriteOff(authority, request({ approverActorId: 'synthetic-nobody' })),
    ).toThrowError(new WriteOffError('UNKNOWN_APPROVER'));
    expect(() =>
      approveWriteOff(authority, request({ approverActorId: 'synthetic-lead-2' })),
    ).toThrowError(new WriteOffError('UNKNOWN_APPROVER'));
  });
});

describe('governed write-off: bound, recorded and single-use', () => {
  it('posts once, carries the approval on the journal and records the approver', () => {
    const ledger = ledgerWithReceivable();
    const approval = approveWriteOff(authority, request());
    postApprovedWriteOff(ledger, authority, approval, posting('a'));

    const journal = ledger.journal(tenant, 'wo-journal-a');
    expect(journal?.writeOff).toEqual({
      writeOffId: 'wo-gov-1',
      reason: 'small-balance',
      approvalHash: approval.approvalHash,
      approverActorId: 'synthetic-supervisor-1',
    });
    expect(journal?.lines.every((line) => line.sourceRef === 'ar-item-100')).toBe(true);
    expect(writeOffRecords(ledger, tenant)).toEqual([
      {
        tenantId: tenant,
        writeOffId: 'wo-gov-1',
        journalId: 'wo-journal-a',
        targetRef: 'ar-item-100',
        reason: 'small-balance',
        role: 'billing-supervisor',
        amountMinor: 900,
        currency: 'USD',
        approvalHash: approval.approvalHash,
        approverActorId: 'synthetic-supervisor-1',
        requesterActorId: 'synthetic-clerk-1',
      },
    ]);
  });

  it('rejects the same approval under a new journal or key, and an identical retry is idempotent', () => {
    const ledger = ledgerWithReceivable();
    const approval = approveWriteOff(authority, request());
    const first = postApprovedWriteOff(ledger, authority, approval, posting('a'));
    expect(postApprovedWriteOff(ledger, authority, approval, posting('a'))).toEqual(first);
    expect(() => postApprovedWriteOff(ledger, authority, approval, posting('b'))).toThrowError(
      new WriteOffError('APPROVAL_CONSUMED'),
    );
    expect(() =>
      postApprovedWriteOff(ledger, authority, approval, { ...posting('a'), idempotencyKey: 'x' }),
    ).toThrowError(new WriteOffError('APPROVAL_CONSUMED'));
    expect(ledger.journals()).toHaveLength(2); // the seeded charge plus one write-off
    expect(writeOffRecords(ledger, tenant)).toHaveLength(1);
  });

  it('rejects a reused write-off id and an approval moved to another receivable', () => {
    const ledger = ledgerWithReceivable();
    postApprovedWriteOff(ledger, authority, approveWriteOff(authority, request()), posting('a'));
    const sameId = approveWriteOff(authority, request({ targetRef: 'ar-item-200' }));
    expect(() => postApprovedWriteOff(ledger, authority, sameId, posting('b'))).toThrowError(
      new WriteOffError('APPROVAL_CONSUMED'),
    );
    const other = approveWriteOff(authority, request({ writeOffId: 'wo-gov-2' }));
    const moved = { ...other, targetRef: 'ar-item-300' };
    expect(() => postApprovedWriteOff(ledger, authority, moved, posting('c'))).toThrowError(
      new WriteOffError('APPROVAL_MISMATCH'),
    );
    expect(ledger.journals()).toHaveLength(2); // the seeded charge plus one write-off
  });
});
