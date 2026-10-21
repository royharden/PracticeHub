import { describe, expect, it } from 'vitest';

import { PatientBalanceBook, type BalanceEvent } from './balance-book.js';
import { EraRegistry, type EraCutover } from './era-registry.js';
import { Wp057StatementIssuerDouble } from './statement-port.js';

const TENANT = 'tenant-synth';

const cutovers: EraCutover[] = [
  { tenantId: TENANT, payerId: 'payer-1', cutoverOn: '2026-07-01', legacySystem: 'athena' },
  { tenantId: TENANT, payerId: 'payer-2', cutoverOn: '2026-10-01', legacySystem: 'athena' },
];

let sequence = 0;
function event(overrides: Partial<BalanceEvent>): BalanceEvent {
  sequence += 1;
  return {
    eventId: `ev-${String(sequence)}`,
    tenantId: TENANT,
    payerId: 'payer-1',
    serviceDate: '2026-08-01',
    arrivedVia: 'native',
    accountRef: 'acct-1',
    episodeId: 'ep-1',
    kind: 'patient-responsibility',
    amountMinor: 3_000,
    ...overrides,
  };
}

function harness(afterIssue?: (statementId: string) => void, idempotent = false) {
  const registry = new EraRegistry(cutovers);
  const issuer = new Wp057StatementIssuerDouble({ idempotent });
  const book = new PatientBalanceBook({ registry, issuer, ...(afterIssue ? { afterIssue } : {}) });
  return { registry, issuer, book };
}

describe('WP-090 frozen era registry', () => {
  it('is frozen and allows one cutover per payer', () => {
    const { registry } = harness();
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.cutover(TENANT, 'payer-1'))).toBe(true);
    const repeat: EraCutover = {
      tenantId: TENANT,
      payerId: 'payer-1',
      cutoverOn: '2026-08-01',
      legacySystem: 'athena',
    };
    expect(() => new EraRegistry([...cutovers, repeat])).toThrow(
      expect.objectContaining({ code: 'ERA_DUPLICATE' }),
    );
  });

  it('fails closed for a payer with no cutover', () => {
    const { registry } = harness();
    expect(() =>
      registry.route({
        tenantId: TENANT,
        payerId: 'payer-x',
        serviceDate: '2026-08-01',
        arrivedVia: 'native',
      }),
    ).toThrow(expect.objectContaining({ code: 'ERA_UNREGISTERED' }));
  });
});

describe('WP-090 cross-era routing', () => {
  it('routes a legacy-era takeback that arrives on the native rail to legacy', () => {
    const { registry, book } = harness();
    const takeback = event({
      kind: 'takeback',
      serviceDate: '2026-06-15',
      amountMinor: 2_000,
      episodeId: 'ep-old',
    });
    expect(registry.route(takeback)).toEqual({ owner: 'legacy', crossEra: true });
    expect(book.apply(takeback)).toEqual({ status: 'forwarded', owner: 'legacy', crossEra: true });
    expect(book.balance(TENANT, 'acct-1', 'ep-old')).toBe(0);
    expect(book.forwarded().map((item) => item.event.eventId)).toEqual([takeback.eventId]);
  });

  it('keeps an appeal resolved after payer promotion with the era of its service date', () => {
    const { book } = harness();
    const appeal = event({
      kind: 'appeal-resolution',
      serviceDate: '2026-06-30',
      episodeId: 'ep-appeal',
      amountMinor: -500,
    });
    expect(book.apply(appeal).owner).toBe('legacy');
  });

  it('routes a native-era event that arrives through legacy to native', () => {
    const { book } = harness();
    expect(book.apply(event({ arrivedVia: 'legacy', episodeId: 'ep-new' }))).toEqual({
      status: 'applied',
      owner: 'native',
      crossEra: true,
    });
    expect(book.balance(TENANT, 'acct-1', 'ep-new')).toBe(3_000);
  });

  it('treats the cutover date itself as native and cutovers as per payer', () => {
    const { registry } = harness();
    const base = { tenantId: TENANT, arrivedVia: 'native' as const };
    expect(registry.route({ ...base, payerId: 'payer-1', serviceDate: '2026-07-01' }).owner).toBe(
      'native',
    );
    expect(registry.route({ ...base, payerId: 'payer-1', serviceDate: '2026-06-30' }).owner).toBe(
      'legacy',
    );
    expect(registry.route({ ...base, payerId: 'payer-2', serviceDate: '2026-08-01' }).owner).toBe(
      'legacy',
    );
  });

  it('pins an episode to one owner even when a later event would route elsewhere', () => {
    const { book } = harness();
    book.apply(event({ episodeId: 'ep-pin', serviceDate: '2026-06-20' }));
    const later = book.apply(
      event({ episodeId: 'ep-pin', serviceDate: '2026-07-05', arrivedVia: 'native' }),
    );
    expect(later).toEqual({ status: 'forwarded', owner: 'legacy', crossEra: true });
    expect(book.ownerOf(TENANT, 'acct-1', 'ep-pin')).toBe('legacy');
    expect(book.balance(TENANT, 'acct-1', 'ep-pin')).toBe(0);
  });

  it('ignores a replayed event', () => {
    const { book } = harness();
    const charge = event({ episodeId: 'ep-dup' });
    book.apply(charge);
    expect(book.apply(charge).status).toBe('duplicate');
    expect(book.balance(TENANT, 'acct-1', 'ep-dup')).toBe(3_000);
  });
});

describe('WP-090 single-statement guarantee', () => {
  it('states a balance once, however often the run repeats', () => {
    const { issuer, book } = harness();
    book.apply(event({ episodeId: 'ep-s1' }));
    expect(book.runStatements(TENANT, '2026-09-01').map((item) => item.status)).toEqual(['issued']);
    expect(book.runStatements(TENANT, '2026-09-02').map((item) => item.status)).toEqual([
      'already-stated',
    ]);
    expect(issuer.delivered()).toHaveLength(1);
  });

  it('does not restate a balance that churns back to the stated amount', () => {
    const { issuer, book } = harness();
    book.apply(event({ episodeId: 'ep-s2' }));
    book.runStatements(TENANT, '2026-09-01');
    book.apply(event({ episodeId: 'ep-s2', kind: 'patient-payment', amountMinor: -1_000 }));
    book.apply(event({ episodeId: 'ep-s2', kind: 'adjustment', amountMinor: 1_000 }));
    expect(book.runStatements(TENANT, '2026-09-02')[0]?.status).toBe('already-stated');
    expect(issuer.delivered()).toHaveLength(1);
  });

  it('states a changed balance as a new balance', () => {
    const { issuer, book } = harness();
    book.apply(event({ episodeId: 'ep-s3' }));
    book.runStatements(TENANT, '2026-09-01');
    book.apply(event({ episodeId: 'ep-s3', kind: 'patient-payment', amountMinor: -1_000 }));
    const second = book.runStatements(TENANT, '2026-09-02');
    expect(second.map((item) => [item.status, item.amountMinor])).toEqual([['issued', 2_000]]);
    expect(issuer.delivered().map((item) => item.amountMinor)).toEqual([3_000, 2_000]);
  });

  it('replays through an idempotent issuer instead of sending a second statement after a crash', () => {
    let crash = true;
    const { issuer, book } = harness(() => {
      if (crash) {
        crash = false;
        throw new Error('simulated process death after issue');
      }
    }, true);
    book.apply(event({ episodeId: 'ep-s4' }));
    expect(() => book.runStatements(TENANT, '2026-09-01')).toThrow(/simulated/);
    const retry = book.runStatements(TENANT, '2026-09-01');
    expect(retry.map((item) => item.status)).toEqual(['already-stated']);
    expect(issuer.delivered()).toHaveLength(1);
  });

  it('holds instead of resending through a non-idempotent issuer (WP-057 at base) after a crash', () => {
    let crash = true;
    const { issuer, book } = harness(() => {
      if (crash) {
        crash = false;
        throw new Error('simulated process death after issue');
      }
    });
    book.apply(event({ episodeId: 'ep-s5' }));
    expect(() => book.runStatements(TENANT, '2026-09-01')).toThrow(/simulated/);
    expect(book.runStatements(TENANT, '2026-09-02').map((item) => item.status)).toEqual([
      'unconfirmed',
    ]);
    expect(book.runStatements(TENANT, '2026-09-03').map((item) => item.status)).toEqual([
      'unconfirmed',
    ]);
    expect(issuer.delivered()).toHaveLength(1);
    expect(book.exceptions()).toEqual([
      {
        reason: 'statement-unconfirmed',
        tenantId: TENANT,
        accountRef: 'acct-1',
        episodeId: 'ep-s5',
        owner: 'rcm-lead',
      },
    ]);
    book.resolveUnconfirmed(TENANT, 'acct-1', 'ep-s5', true);
    expect(book.runStatements(TENANT, '2026-09-04').map((item) => item.status)).toEqual([
      'already-stated',
    ]);
    expect(issuer.delivered()).toHaveLength(1);
  });

  it('sends a held statement once a human finds it was not delivered', () => {
    let crash = true;
    const { issuer, book } = harness(() => {
      if (crash) {
        crash = false;
        throw new Error('simulated process death after issue');
      }
    });
    book.apply(event({ episodeId: 'ep-s6' }));
    expect(() => book.runStatements(TENANT, '2026-09-01')).toThrow(/simulated/);
    book.resolveUnconfirmed(TENANT, 'acct-1', 'ep-s6', false);
    expect(book.runStatements(TENANT, '2026-09-02').map((item) => item.status)).toEqual(['issued']);
    expect(issuer.delivered()).toHaveLength(2);
  });

  it('never states a legacy-owned episode natively', () => {
    const { issuer, book } = harness();
    book.apply(event({ episodeId: 'ep-legacy', serviceDate: '2026-05-01', arrivedVia: 'native' }));
    expect(book.runStatements(TENANT, '2026-09-01')).toEqual([]);
    expect(issuer.delivered()).toEqual([]);
  });

  it('holds a native episode the legacy system already stated as an owned exception', () => {
    const { issuer, book } = harness();
    book.apply(event({ episodeId: 'ep-both' }));
    book.recordLegacyStatement(TENANT, 'acct-1', 'ep-both');
    expect(book.runStatements(TENANT, '2026-09-01')[0]?.status).toBe('legacy-stated');
    book.runStatements(TENANT, '2026-09-02');
    expect(issuer.delivered()).toEqual([]);
    expect(book.exceptions()).toEqual([
      {
        reason: 'dual-statement-risk',
        tenantId: TENANT,
        accountRef: 'acct-1',
        episodeId: 'ep-both',
        owner: 'rcm-lead',
      },
    ]);
  });

  it('sends nothing for a zero or credit balance', () => {
    const { issuer, book } = harness();
    book.apply(event({ episodeId: 'ep-credit', amountMinor: -500, kind: 'patient-payment' }));
    expect(book.runStatements(TENANT, '2026-09-01')[0]?.status).toBe('no-balance');
    expect(issuer.delivered()).toEqual([]);
  });
});

describe('WP-090 rework 1 (review 0191)', () => {
  it('[medium] bills a bounced payment that restores the stated amount (P5)', () => {
    const { issuer, book } = harness();
    book.apply(event({ episodeId: 'ep-nsf' }));
    expect(book.runStatements(TENANT, '2026-09-01')[0]?.status).toBe('issued');
    book.apply(event({ episodeId: 'ep-nsf', kind: 'patient-payment', amountMinor: -3_000 }));
    expect(book.runStatements(TENANT, '2026-09-02')[0]?.status).toBe('no-balance');
    book.apply(event({ episodeId: 'ep-nsf', kind: 'adjustment', amountMinor: 3_000 }));
    expect(book.runStatements(TENANT, '2026-09-03')[0]?.status).toBe('issued');
    expect(issuer.delivered().map((item) => item.amountMinor)).toEqual([3_000, 3_000]);
  });

  it('[medium] bills a payment reversal even with no statement run in between', () => {
    const { issuer, book } = harness();
    book.apply(event({ episodeId: 'ep-rev' }));
    book.runStatements(TENANT, '2026-09-01');
    book.apply(event({ episodeId: 'ep-rev', kind: 'patient-payment', amountMinor: -3_000 }));
    book.apply(event({ episodeId: 'ep-rev', kind: 'adjustment', amountMinor: 3_000 }));
    expect(book.runStatements(TENANT, '2026-09-02')[0]?.status).toBe('issued');
    expect(issuer.delivered()).toHaveLength(2);
  });

  it('[low] a failed apply leaves the event retryable (P6)', () => {
    const { book } = harness();
    book.apply(event({ episodeId: 'ep-big', amountMinor: Number.MAX_SAFE_INTEGER }));
    const tooMuch = event({ episodeId: 'ep-big', amountMinor: 1 });
    expect(() => book.apply(tooMuch)).toThrow(expect.objectContaining({ code: 'BALANCE_INVALID' }));
    book.apply(event({ episodeId: 'ep-big', kind: 'patient-payment', amountMinor: -10 }));
    expect(book.apply(tooMuch).status).toBe('applied');
    expect(book.balance(TENANT, 'acct-1', 'ep-big')).toBe(Number.MAX_SAFE_INTEGER - 9);
  });

  it('[low] the era registry cannot be changed after construction (P7)', () => {
    const { registry } = harness();
    expect(Object.keys(registry)).toEqual([]);
    expect(Reflect.set(registry, 'cutovers', new Map())).toBe(false);
    const copy = registry.entries() as EraCutover[];
    copy.push({
      tenantId: TENANT,
      payerId: 'payer-x',
      cutoverOn: '2026-01-01',
      legacySystem: 'athena',
    });
    expect(() =>
      registry.route({
        tenantId: TENANT,
        payerId: 'payer-x',
        serviceDate: '2026-08-01',
        arrivedVia: 'native',
      }),
    ).toThrow(expect.objectContaining({ code: 'ERA_UNREGISTERED' }));
    expect(registry.entries()).toHaveLength(2);
  });
});
