import { describe, expect, it } from 'vitest';

import { MembershipJournal } from './journal.js';
import { Wp031EntitlementDoubleV1 } from './testing/wp031-entitlement-double-v1.js';
import { MembershipError } from './types.js';

const northwind = 'northwind-synthetic';
const riverbend = 'riverbend-synthetic';

const openBase = {
  tenantId: northwind,
  accountId: 'acct-1',
  memberRef: 'person-opaque-1',
  vintageId: 'vin-1',
  offerRef: 'offer-concierge-v1',
  priceMinor: 19900,
  currency: 'USD',
  componentRefs: ['care-home', 'messaging'],
  authorityJournalId: 'journal-1',
  eventId: 'evt-open-1',
  idempotencyKey: 'open-1',
  occurredAt: '2026-01-15T12:00:00.000Z',
} as const;

const make = (): { journal: MembershipJournal; entitlements: Wp031EntitlementDoubleV1 } => {
  const entitlements = new Wp031EntitlementDoubleV1();
  return { journal: new MembershipJournal(entitlements), entitlements };
};

describe('MembershipJournal', () => {
  it('opens an account with an immutable vintage price snapshot and grants entitlements', () => {
    const { journal, entitlements } = make();
    expect(journal.open(openBase)).toEqual(journal.open(openBase));
    expect(journal.account(northwind, 'acct-1').status).toBe('active');
    expect(journal.vintages(northwind, 'acct-1')).toEqual([
      {
        tenantId: northwind,
        vintageId: 'vin-1',
        accountId: 'acct-1',
        offerRef: 'offer-concierge-v1',
        priceMinor: 19900,
        currency: 'USD',
        openedAt: openBase.occurredAt,
        closedAt: null,
      },
    ]);
    expect(entitlements.snapshot()).toEqual([
      {
        tenantId: northwind,
        memberRef: 'person-opaque-1',
        vintageId: 'vin-1',
        componentRefs: ['care-home', 'messaging'],
        authorityJournalId: 'journal-1',
        reversed: false,
      },
    ]);
  });

  it('pauses and resumes without reversing entitlements (REQ-MEM-037 core; payment recovery stays forwarded)', () => {
    const { journal, entitlements } = make();
    journal.open(openBase);
    journal.pause({
      tenantId: northwind,
      accountId: 'acct-1',
      eventId: 'evt-pause-1',
      idempotencyKey: 'pause-1',
      occurredAt: '2026-02-01T12:00:00.000Z',
      authorityJournalId: 'journal-1',
    });
    expect(journal.account(northwind, 'acct-1').status).toBe('paused');
    expect(entitlements.snapshot()[0]?.reversed).toBe(false);
    journal.resume({
      tenantId: northwind,
      accountId: 'acct-1',
      eventId: 'evt-resume-1',
      idempotencyKey: 'resume-1',
      occurredAt: '2026-02-10T12:00:00.000Z',
      authorityJournalId: 'journal-1',
    });
    expect(journal.account(northwind, 'acct-1').status).toBe('active');
    expect(journal.vintages(northwind, 'acct-1')[0]?.priceMinor).toBe(19900);
    expect(entitlements.snapshot()[0]?.reversed).toBe(false);
  });

  it('cancels by closing the vintage and reversing entitlements', () => {
    const { journal, entitlements } = make();
    journal.open(openBase);
    journal.cancel({
      tenantId: northwind,
      accountId: 'acct-1',
      eventId: 'evt-cancel-1',
      idempotencyKey: 'cancel-1',
      occurredAt: '2026-03-01T12:00:00.000Z',
      authorityJournalId: 'journal-r1',
    });
    expect(journal.account(northwind, 'acct-1')).toMatchObject({
      status: 'cancelled',
      currentVintageId: null,
    });
    expect(journal.vintages(northwind, 'acct-1')[0]?.closedAt).toBe('2026-03-01T12:00:00.000Z');
    expect(entitlements.snapshot()[0]?.reversed).toBe(true);
  });

  it('win-back opens a new vintage at the new price without mutating the cancelled vintage (REQ-MEM-041)', () => {
    const { journal, entitlements } = make();
    journal.open(openBase);
    journal.cancel({
      tenantId: northwind,
      accountId: 'acct-1',
      eventId: 'evt-cancel-1',
      idempotencyKey: 'cancel-1',
      occurredAt: '2026-03-01T12:00:00.000Z',
      authorityJournalId: 'journal-r1',
    });
    const after = journal.winBack({
      tenantId: northwind,
      accountId: 'acct-1',
      eventId: 'evt-win-1',
      idempotencyKey: 'win-1',
      occurredAt: '2026-04-01T12:00:00.000Z',
      authorityJournalId: 'journal-2',
      vintageId: 'vin-2',
      offerRef: 'offer-concierge-v2',
      priceMinor: 24900,
      currency: 'USD',
      componentRefs: ['care-home'],
    });
    expect(after.status).toBe('active');
    expect(after.currentVintageId).toBe('vin-2');
    const vintages = journal.vintages(northwind, 'acct-1');
    expect(vintages).toHaveLength(2);
    expect(vintages[0]).toMatchObject({
      vintageId: 'vin-1',
      priceMinor: 19900,
      closedAt: '2026-03-01T12:00:00.000Z',
    });
    expect(vintages[1]).toMatchObject({ vintageId: 'vin-2', priceMinor: 24900, closedAt: null });
    expect(entitlements.snapshot().map((row) => [row.vintageId, row.reversed])).toEqual([
      ['vin-1', true],
      ['vin-2', false],
    ]);
  });

  it('rejects pause unless active, resume unless paused, win-back unless cancelled', () => {
    const { journal } = make();
    journal.open(openBase);
    expect(() =>
      journal.resume({
        tenantId: northwind,
        accountId: 'acct-1',
        eventId: 'evt-bad-resume',
        idempotencyKey: 'bad-resume',
        occurredAt: openBase.occurredAt,
        authorityJournalId: 'journal-1',
      }),
    ).toThrow(MembershipError);
    journal.pause({
      tenantId: northwind,
      accountId: 'acct-1',
      eventId: 'evt-pause-1',
      idempotencyKey: 'pause-1',
      occurredAt: '2026-02-01T12:00:00.000Z',
      authorityJournalId: 'journal-1',
    });
    expect(() =>
      journal.pause({
        tenantId: northwind,
        accountId: 'acct-1',
        eventId: 'evt-pause-2',
        idempotencyKey: 'pause-2',
        occurredAt: '2026-02-02T12:00:00.000Z',
        authorityJournalId: 'journal-1',
      }),
    ).toThrow('PAUSE_REQUIRES_ACTIVE');
    expect(() =>
      journal.winBack({
        tenantId: northwind,
        accountId: 'acct-1',
        eventId: 'evt-win-bad',
        idempotencyKey: 'win-bad',
        occurredAt: '2026-02-03T12:00:00.000Z',
        authorityJournalId: 'journal-2',
        vintageId: 'vin-x',
        offerRef: 'offer-x',
        priceMinor: 1,
        currency: 'USD',
        componentRefs: ['care-home'],
      }),
    ).toThrow('WINBACK_REQUIRES_CANCELLED');
  });

  it('isolates tenants that share account ids', () => {
    const { journal } = make();
    journal.open(openBase);
    journal.open({
      ...openBase,
      tenantId: riverbend,
      eventId: 'evt-rb',
      idempotencyKey: 'open-rb',
    });
    journal.cancel({
      tenantId: northwind,
      accountId: 'acct-1',
      eventId: 'evt-cancel-nw',
      idempotencyKey: 'cancel-nw',
      occurredAt: '2026-03-01T12:00:00.000Z',
      authorityJournalId: 'journal-r1',
    });
    expect(journal.account(northwind, 'acct-1').status).toBe('cancelled');
    expect(journal.account(riverbend, 'acct-1').status).toBe('active');
  });

  it('detects a changed payload on the same open key', () => {
    const { journal } = make();
    journal.open(openBase);
    expect(() => journal.open({ ...openBase, priceMinor: 1 })).toThrow('IDEMPOTENCY_CONFLICT');
  });
});
