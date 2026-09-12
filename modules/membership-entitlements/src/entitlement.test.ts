import { describe, expect, it } from 'vitest';

import { EntitlementJournal } from './entitlement.js';

const authority = {
  journal(_tenantId: string, journalId: string) {
    if (journalId === 'journal-1') return {};
    if (journalId === 'journal-r-wrong') return { reversalOfJournalId: 'journal-other' };
    if (journalId.startsWith('journal-r')) return { reversalOfJournalId: 'journal-1' };
    return undefined;
  },
};

const makeJournal = (): EntitlementJournal => new EntitlementJournal(authority);

const grant = {
  tenantId: 'northwind-synthetic',
  eventId: 'ent-1',
  memberRef: 'person-opaque-1',
  componentRef: 'component-1',
  entitlementKind: 'single-service',
  authorityJournalId: 'journal-1',
  idempotencyKey: 'ent-key-1',
} as const;

describe('EntitlementJournal', () => {
  it('grants and reverses from app-owned journal authority idempotently', () => {
    const journal = makeJournal();
    expect(journal.grant(grant)).toEqual(journal.grant(grant));
    expect(journal.check(grant.tenantId, grant.memberRef, grant.componentRef)).toBe(true);
    const reverse = {
      ...grant,
      eventId: 'ent-r1',
      idempotencyKey: 'ent-rkey-1',
      reversalOfEventId: 'ent-1',
      authorityJournalId: 'journal-r1',
    };
    expect(journal.reverse(reverse)).toEqual(journal.reverse(reverse));
    expect(journal.check(grant.tenantId, grant.memberRef, grant.componentRef)).toBe(false);
  });

  it('fails closed while consume concurrency is deferred to WP-053', () => {
    expect(makeJournal().consume()).toEqual({
      supported: false,
      code: 'CONSUME_DEFERRED_WP053',
    });
  });

  it('rejects a reversal whose authority tuple does not match the original grant', () => {
    const journal = makeJournal();
    journal.grant(grant);
    expect(() =>
      journal.reverse({
        ...grant,
        eventId: 'ent-r-bad',
        memberRef: 'other-member',
        idempotencyKey: 'bad-reverse',
        reversalOfEventId: grant.eventId,
        authorityJournalId: 'journal-r1',
      }),
    ).toThrow('ORIGINAL_NOT_FOUND');
  });

  it('detects a changed payload on the same reversal key', () => {
    const journal = makeJournal();
    journal.grant(grant);
    const reverse = {
      ...grant,
      eventId: 'ent-r1',
      idempotencyKey: 'reverse-key',
      reversalOfEventId: grant.eventId,
      authorityJournalId: 'journal-r1',
    };
    journal.reverse(reverse);
    expect(() => journal.reverse({ ...reverse, eventId: 'ent-r2' })).toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
  });

  it('scopes reversal uniqueness by tenant even when event ids match', () => {
    const journal = makeJournal();
    journal.grant(grant);
    journal.grant({
      ...grant,
      tenantId: 'riverbend-synthetic',
      idempotencyKey: 'ent-key-riverbend',
    });
    journal.reverse({
      ...grant,
      eventId: 'ent-r-a',
      idempotencyKey: 'reverse-a',
      reversalOfEventId: grant.eventId,
      authorityJournalId: 'journal-r-a',
    });
    expect(() =>
      journal.reverse({
        ...grant,
        tenantId: 'riverbend-synthetic',
        eventId: 'ent-r-b',
        idempotencyKey: 'reverse-b',
        reversalOfEventId: grant.eventId,
        authorityJournalId: 'journal-r-b',
      }),
    ).not.toThrow();
  });

  it('requires real journal authority and unique tenant/event identity', () => {
    const journal = makeJournal();
    expect(() => journal.grant({ ...grant, authorityJournalId: 'missing' })).toThrow(
      'AUTHORITY_NOT_FOUND',
    );
    journal.grant(grant);
    expect(() =>
      journal.grant({ ...grant, idempotencyKey: 'different-key', memberRef: 'different-member' }),
    ).toThrow('EVENT_ID_CONFLICT');
    expect(() =>
      journal.reverse({
        ...grant,
        eventId: 'bad-authority-reversal',
        idempotencyKey: 'bad-authority-key',
        reversalOfEventId: grant.eventId,
        authorityJournalId: 'journal-r-wrong',
      }),
    ).toThrow('AUTHORITY_MISMATCH');
  });
});
