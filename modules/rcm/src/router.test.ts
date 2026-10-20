import { describe, expect, it } from 'vitest';

import {
  acceptRemit,
  ClearinghouseRouter,
  type PayerRoute,
  type RailId,
  type RailSendResult,
  type RailTransport,
  type RoutedClaim,
} from './router.js';

const route: PayerRoute = {
  payerId: 'payer-1',
  primary: 'ch-sim-A',
  secondary: 'ch-sim-B',
  enrolledTransactions: ['837'],
};

const claims: RoutedClaim[] = [
  { claimId: 'claim-1', payerId: 'payer-1' },
  { claimId: 'claim-2', payerId: 'payer-1' },
  { claimId: 'claim-3', payerId: 'payer-1' },
];

/** Simulated rails that record every send and answer from a script. */
class ScriptedRails implements RailTransport {
  public readonly sends: string[] = [];
  public constructor(
    private readonly script: (railId: RailId, claim: RoutedClaim, index: number) => RailSendResult,
  ) {}
  public send(railId: RailId, claim: RoutedClaim): RailSendResult {
    const index = this.sends.length;
    this.sends.push(`${claim.tenantId ?? '-'}/${claim.claimId}@${railId}`);
    return this.script(railId, claim, index);
  }
  /** How many rails each claim id reached (any answer other than a definite refusal). */
  public holders(results: readonly RailSendResult[]): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    this.sends.forEach((send, index) => {
      if (results[index] === 'refused') {
        return;
      }
      const [claim, rail] = send.split('@');
      const set = map.get(claim ?? '') ?? new Set<string>();
      set.add(rail ?? '');
      map.set(claim ?? '', set);
    });
    return map;
  }
}

describe('WP-085 clearinghouse router', () => {
  it('fails over mid-batch without a duplicate claim', () => {
    const router = new ClearinghouseRouter([route], 'dual-rail', {
      clock: () => '2026-03-01T00:00:00Z',
    });
    const result = router.submitBatch(claims, 1);
    expect(result.duplicateCount).toBe(0);
    expect(result.submitted.map((claim) => `${claim.claimId}:${claim.railId}`)).toEqual([
      'claim-1:ch-sim-A',
      'claim-2:ch-sim-B',
      'claim-3:ch-sim-B',
    ]);
    expect(new Set(result.submitted.map((claim) => claim.claimId)).size).toBe(3);
    router.manualSwitch('payer-1', 'ch-sim-B', 'drill', 'rcm-lead-1');
    const next = router.submitBatch([{ claimId: 'claim-4', payerId: 'payer-1' }]);
    expect(next.submitted[0]?.railId).toBe('ch-sim-B');
    expect(router.switchLog()).toEqual([
      {
        payerId: 'payer-1',
        target: 'ch-sim-B',
        reason: 'drill',
        actor: 'rcm-lead-1',
        at: '2026-03-01T00:00:00Z',
        previousPrimary: 'ch-sim-A',
      },
    ]);
  });

  it('records one acknowledgment in single-rail mode', () => {
    const router = new ClearinghouseRouter([route], 'single-rail');
    const result = router.submitBatch(claims);
    expect(result.acknowledgments).toEqual([
      { railId: 'ch-sim-A', mode: 'single-rail', claimCount: 3 },
    ]);
    expect(result.submitted.every((claim) => claim.railId === 'ch-sim-A')).toBe(true);
  });

  it('rejects an 835 that fails the enrollment constraint', () => {
    expect(acceptRemit(route)).toEqual({ accepted: false, reason: 'enrollment-constraint' });
    expect(acceptRemit({ ...route, enrolledTransactions: ['837', '835'] })).toEqual({
      accepted: true,
      reason: null,
    });
  });
});

describe('WP-085 rework 1: review findings', () => {
  // [high] router.ts:91 cross-batch idempotency, real mid-send failover drill.
  it('drill: primary dies mid-send, the whole batch is retried, and no claim reaches two rails', () => {
    const results: RailSendResult[] = [];
    // ch-sim-A acknowledges claim-1, times out on claim-2 (in flight, may hold it), then refuses.
    const rails = new ScriptedRails((railId, claim) => {
      const answer: RailSendResult =
        railId === 'ch-sim-B'
          ? 'ack'
          : claim.claimId === 'claim-1'
            ? 'ack'
            : claim.claimId === 'claim-2'
              ? 'timeout'
              : 'refused';
      results.push(answer);
      return answer;
    });
    const router = new ClearinghouseRouter([route], 'dual-rail', { transport: rails });
    const first = router.submitBatch(claims);
    expect(first.submitted.map((claim) => `${claim.claimId}:${claim.railId}`)).toEqual([
      'claim-1:ch-sim-A',
      'claim-3:ch-sim-B',
    ]);
    expect(first.inFlight).toEqual([
      { claimId: 'claim-2', payerId: 'payer-1', railId: 'ch-sim-A' },
    ]);

    // The usual recovery: resubmit the failed batch, whole.
    const retry = router.submitBatch(claims);
    expect(retry.submitted).toEqual([]);
    expect(retry.duplicateCount).toBe(3);
    expect(
      retry.alreadySubmitted?.map((entry) => `${entry.claimId}:${entry.railId}:${entry.state}`),
    ).toEqual([
      'claim-1:ch-sim-A:acknowledged',
      'claim-2:ch-sim-A:in-flight',
      'claim-3:ch-sim-B:acknowledged',
    ]);
    const holders = rails.holders(results);
    expect([...holders.values()].every((set) => set.size === 1)).toBe(true);
    // claim-3 never touched ch-sim-A: after the timeout the payer failed over to ch-sim-B.
    expect(rails.sends).toEqual(['-/claim-1@ch-sim-A', '-/claim-2@ch-sim-A', '-/claim-3@ch-sim-B']);
  });

  it('resends an in-flight claim only after a status inquiry says no rail holds it', () => {
    const rails = new ScriptedRails((_railId, _claim, index) => (index === 0 ? 'timeout' : 'ack'));
    const router = new ClearinghouseRouter([route], 'dual-rail', { transport: rails });
    router.submitBatch([claims[0] as RoutedClaim]);
    expect(router.submitBatch([claims[0] as RoutedClaim]).submitted).toEqual([]);
    expect(router.resolveInFlight('claim-1', 'payer-1', { result: 'not-held' }).state).toBe(
      'released',
    );
    const resent = router.submitBatch([claims[0] as RoutedClaim]);
    expect(resent.submitted).toEqual([
      { claimId: 'claim-1', payerId: 'payer-1', railId: 'ch-sim-A' },
    ]);
    expect(() => router.resolveInFlight('claim-1', 'payer-1', { result: 'not-held' })).toThrow(
      /only an in-flight/,
    );
  });

  it('marks an in-flight claim acknowledged when the inquiry finds it, and never resends it', () => {
    const rails = new ScriptedRails((_railId, _claim, index) => (index === 0 ? 'timeout' : 'ack'));
    const router = new ClearinghouseRouter([route], 'dual-rail', { transport: rails });
    router.submitBatch([claims[0] as RoutedClaim]);
    router.resolveInFlight('claim-1', 'payer-1', { result: 'holds', railId: 'ch-sim-A' });
    expect(router.submitBatch([claims[0] as RoutedClaim]).duplicateCount).toBe(1);
    expect(rails.sends).toHaveLength(1);
  });

  it('treats a send that throws as in flight, not as unsent', () => {
    const rails: RailTransport = {
      send: () => {
        throw new Error('socket closed mid-write');
      },
    };
    const router = new ClearinghouseRouter([route], 'dual-rail', { transport: rails });
    const result = router.submitBatch([claims[0] as RoutedClaim]);
    expect(result.inFlight).toEqual([
      { claimId: 'claim-1', payerId: 'payer-1', railId: 'ch-sim-A' },
    ]);
    expect(router.ledgerEntry('claim-1', 'payer-1')?.state).toBe('in-flight');
  });

  // [medium] router.ts:147 no throw mid-batch; routes validated up front, partial result kept.
  it('refuses a dual-rail route without a distinct secondary before anything is sent', () => {
    expect(() => new ClearinghouseRouter([{ ...route, secondary: null }], 'dual-rail')).toThrow(
      /distinct secondary/,
    );
    expect(
      () => new ClearinghouseRouter([{ ...route, secondary: 'ch-sim-A' }], 'dual-rail'),
    ).toThrow(/distinct secondary/);
    const router = new ClearinghouseRouter([route], 'dual-rail');
    expect(() =>
      router.submitBatch([...claims, { claimId: 'x', payerId: 'payer-unknown' }]),
    ).toThrow(/no route/);
    expect(router.ledgerEntry('claim-1', 'payer-1')).toBeUndefined();
  });

  it('keeps the partial result when failover finds no usable secondary', () => {
    const perRail: PayerRoute = {
      ...route,
      enrollment: [
        { railId: 'ch-sim-A', transactions: ['837'] },
        { railId: 'ch-sim-B', transactions: ['835'] },
      ],
    };
    const router = new ClearinghouseRouter([perRail], 'dual-rail');
    const result = router.submitBatch(claims, 1);
    expect(result.submitted).toEqual([
      { claimId: 'claim-1', payerId: 'payer-1', railId: 'ch-sim-A' },
    ]);
    expect(result.held).toEqual([
      { claimId: 'claim-2', payerId: 'payer-1', reason: 'secondary-not-enrolled' },
      { claimId: 'claim-3', payerId: 'payer-1', reason: 'secondary-not-enrolled' },
    ]);
    expect(router.ledgerEntry('claim-2', 'payer-1')).toBeUndefined();
  });

  // [medium] router.ts:128 acknowledgments come from rail answers, per rail.
  it('credits each rail with its own acknowledgments in single-rail mode, and none for an empty batch', () => {
    const router = new ClearinghouseRouter(
      [
        route,
        { payerId: 'payer-2', primary: 'ch-sim-B', secondary: null, enrolledTransactions: ['837'] },
      ],
      'single-rail',
    );
    const result = router.submitBatch([
      { claimId: 'claim-1', payerId: 'payer-1' },
      { claimId: 'claim-2', payerId: 'payer-2' },
      { claimId: 'claim-3', payerId: 'payer-2' },
    ]);
    expect(result.acknowledgments).toEqual([
      { railId: 'ch-sim-A', mode: 'single-rail', claimCount: 1 },
      { railId: 'ch-sim-B', mode: 'single-rail', claimCount: 2 },
    ]);
    expect(router.submitBatch([]).acknowledgments).toEqual([]);
  });

  it('does not acknowledge claims a rail timed out on or rejected', () => {
    const rails = new ScriptedRails((_railId, claim) =>
      claim.claimId === 'claim-1' ? 'rejected' : 'timeout',
    );
    const router = new ClearinghouseRouter([route], 'single-rail', { transport: rails });
    const result = router.submitBatch(claims.slice(0, 2));
    expect(result.acknowledgments).toEqual([]);
    expect(result.railRejected?.map((claim) => claim.claimId)).toEqual(['claim-1']);
    expect(result.inFlight?.map((claim) => claim.claimId)).toEqual(['claim-2']);
    // A rail-level rejection is a recorded disposition: the claim may be resubmitted.
    expect(router.submitBatch([claims[0] as RoutedClaim]).alreadySubmitted).toEqual([]);
    expect(rails.sends.filter((send) => send.includes('claim-1'))).toHaveLength(2);
  });

  // [medium] router.ts:164 enrollment per (payer, rail, transaction).
  it('refuses 837 submission on a primary the payer is not enrolled on', () => {
    const router = new ClearinghouseRouter(
      [{ ...route, enrollment: [{ railId: 'ch-sim-B', transactions: ['837'] }] }],
      'dual-rail',
    );
    const result = router.submitBatch([claims[0] as RoutedClaim]);
    expect(result.submitted).toEqual([]);
    expect(result.held).toEqual([
      { claimId: 'claim-1', payerId: 'payer-1', reason: 'primary-not-enrolled' },
    ]);
  });

  it('accepts an 835 only on a rail enrolled for 835', () => {
    const perRail: PayerRoute = {
      ...route,
      enrolledTransactions: ['837', '835'],
      enrollment: [
        { railId: 'ch-sim-A', transactions: ['837'] },
        { railId: 'ch-sim-B', transactions: ['837', '835'] },
      ],
    };
    expect(acceptRemit(perRail, 'ch-sim-A')).toEqual({
      accepted: false,
      reason: 'enrollment-constraint',
    });
    expect(acceptRemit(perRail, 'ch-sim-B')).toEqual({ accepted: true, reason: null });
    const router = new ClearinghouseRouter([perRail], 'dual-rail');
    expect(router.acceptRemitOn('payer-1', 'ch-sim-A').accepted).toBe(false);
    expect(router.acceptRemitOn('payer-1', 'ch-sim-B').accepted).toBe(true);
    // Legacy route-wide enrollment still applies to the route's own rails only.
    expect(
      acceptRemit({ ...route, secondary: null, enrolledTransactions: ['837', '835'] }, 'ch-sim-B')
        .accepted,
    ).toBe(false);
  });

  // [low] router.ts:79 manual switch validation, swap, audit, frozen log, tenant-scoped identity.
  it('swaps primary and secondary on a switch to the secondary, so dual-rail failover still works', () => {
    const router = new ClearinghouseRouter([route], 'dual-rail', {
      clock: () => '2026-03-01T00:00:00Z',
    });
    router.manualSwitch('payer-1', 'ch-sim-B', 'primary maintenance', 'rcm-lead-1');
    const result = router.submitBatch(claims, 1);
    expect(result.submitted.map((claim) => claim.railId)).toEqual([
      'ch-sim-B',
      'ch-sim-A',
      'ch-sim-A',
    ]);
  });

  it('validates the switch target and returns a frozen copy of the log', () => {
    const router = new ClearinghouseRouter([route], 'dual-rail');
    expect(() => router.manualSwitch('payer-1', 'ch-sim-C' as RailId, 'x')).toThrow(
      /ch-sim-A or ch-sim-B/,
    );
    expect(() => router.manualSwitch('payer-1', 'ch-sim-B', '')).toThrow(/requires a reason/);
    router.manualSwitch('payer-1', 'ch-sim-B', 'drill');
    const log = router.switchLog();
    expect(Object.isFrozen(log)).toBe(true);
    expect(Object.isFrozen(log[0])).toBe(true);
    expect(log[0]?.actor).toBe('unattributed');
    expect(router.switchLog()).not.toBe(log);
  });

  it('refuses a switch to a rail the payer is not enrolled on for 837', () => {
    const router = new ClearinghouseRouter(
      [{ ...route, enrollment: [{ railId: 'ch-sim-A', transactions: ['837'] }] }],
      'dual-rail',
    );
    expect(() => router.manualSwitch('payer-1', 'ch-sim-B', 'x')).toThrow(/not enrolled/);
  });

  it('scopes claim identity by tenant', () => {
    const router = new ClearinghouseRouter([route], 'dual-rail');
    const result = router.submitBatch([
      { claimId: 'claim-1', payerId: 'payer-1', tenantId: 'tenant-a' },
      { claimId: 'claim-1', payerId: 'payer-1', tenantId: 'tenant-b' },
      { claimId: 'claim-1', payerId: 'payer-1', tenantId: 'tenant-a' },
    ]);
    expect(result.submitted).toHaveLength(2);
    expect(result.duplicateCount).toBe(1);
    expect(() =>
      router.submitBatch([{ claimId: 'c', payerId: 'payer-1', tenantId: 'bad tenant' }]),
    ).toThrow(/tenantId must be a token/);
  });
});

describe('H-02 hardening', () => {
  it('NR-121: an unknown or malformed transport answer is in-flight, never refused: no delete, no failover, no resend', () => {
    for (const answer of ['garbage', undefined, null, 42, 'ACK']) {
      const rails = new ScriptedRails((railId) =>
        railId === 'ch-sim-A' ? (answer as unknown as RailSendResult) : 'ack',
      );
      const router = new ClearinghouseRouter([route], 'dual-rail', { transport: rails });
      const result = router.submitBatch([claims[0] as RoutedClaim]);
      expect(result.inFlight).toEqual([
        { claimId: 'claim-1', payerId: 'payer-1', railId: 'ch-sim-A' },
      ]);
      expect(result.submitted).toEqual([]);
      expect(rails.sends).toEqual(['-/claim-1@ch-sim-A']);
      expect(router.ledgerEntry('claim-1', 'payer-1')?.state).toBe('in-flight');
      // A retry does not resend it until a status inquiry resolves it.
      expect(router.submitBatch([claims[0] as RoutedClaim]).duplicateCount).toBe(1);
      expect(rails.sends).toHaveLength(1);
    }
  });

  it('NR-120: ledger entries returned to callers are frozen', () => {
    const router = new ClearinghouseRouter([route], 'dual-rail');
    router.submitBatch([claims[0] as RoutedClaim]);
    const entry = router.ledgerEntry('claim-1', 'payer-1');
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as { state: string }).state = 'released';
    }).toThrow(TypeError);
    expect(router.ledgerEntry('claim-1', 'payer-1')?.state).toBe('acknowledged');
    const again = router.submitBatch([claims[0] as RoutedClaim]);
    const prior = again.alreadySubmitted?.[0];
    expect(Object.isFrozen(prior)).toBe(true);
    expect(() => {
      (prior as { state: string }).state = 'released';
    }).toThrow(TypeError);
    // Still acknowledged, so still never resent.
    expect(router.submitBatch([claims[0] as RoutedClaim]).duplicateCount).toBe(1);
  });
});
