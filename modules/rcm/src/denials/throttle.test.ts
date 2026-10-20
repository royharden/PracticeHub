import { describe, expect, it } from 'vitest';

import { DenialQueues, type DenialIntake } from './queue.js';
import { AppealThrottle } from './throttle.js';

const T = 'tenant-synthetic';

function intake(
  denialId: string,
  payerId: string,
  deniedMinor: number,
  remitReceivedAt: string,
  tenantId = T,
): DenialIntake {
  return {
    denialId,
    claim: {
      claimId: `claim-${denialId}`,
      tenantId,
      payerId,
      controlNumber: `ctl-${denialId}`,
      totalMinor: 100_000,
      state: 'finalized',
    },
    adjustments: [{ group: 'CO', code: '50', amountMinor: deniedMinor }],
    rarcs: [],
    deniedMinor,
    serviceDate: '2026-01-05',
    remitReceivedAt,
  };
}

function setup(): DenialQueues {
  const queues = new DenialQueues([
    { payerId: 'payer-1', appealWindowDays: 30, timelyFilingDays: 90 },
    { payerId: 'payer-2', appealWindowDays: 30, timelyFilingDays: 90 },
  ]);
  // payer-1: five denials with deadlines spread across the month.
  queues.intake(intake('p1-a', 'payer-1', 1_000, '2026-02-05T00:00:00Z'));
  queues.intake(intake('p1-b', 'payer-1', 9_000, '2026-02-20T00:00:00Z'));
  queues.intake(intake('p1-c', 'payer-1', 5_000, '2026-02-01T00:00:00Z'));
  queues.intake(intake('p1-d', 'payer-1', 7_000, '2026-02-10T00:00:00Z'));
  queues.intake(intake('p1-e', 'payer-1', 3_000, '2026-02-15T00:00:00Z'));
  queues.intake(intake('p2-a', 'payer-2', 2_000, '2026-02-01T00:00:00Z'));
  return queues;
}

describe('WP-088 batch appeal throttle: tenant scoping (F1)', () => {
  it("one tenant's appeals never spend another tenant's allowance, and foreign ids read as not queued", () => {
    const queues = new DenialQueues([
      { payerId: 'payer-1', appealWindowDays: 30, timelyFilingDays: 90 },
    ]);
    queues.intake(intake('a-1', 'payer-1', 1_000, '2026-02-01T00:00:00Z', 'tenant-a'));
    queues.intake(intake('a-2', 'payer-1', 1_000, '2026-02-01T00:00:00Z', 'tenant-a'));
    queues.intake(intake('b-1', 'payer-1', 1_000, '2026-02-01T00:00:00Z', 'tenant-b'));
    const throttle = new AppealThrottle(queues, {
      maxPerPayerPerWindow: 2,
      windowHours: 24,
      maxBatchSize: 50,
    });
    expect(
      throttle.submitBatch('tenant-a', ['a-1', 'a-2'], '2026-02-10T00:00:00Z', 'rcm-lead-1').sent,
    ).toEqual(['a-1', 'a-2']);
    const b = throttle.submitBatch(
      'tenant-b',
      ['b-1', 'a-1'],
      '2026-02-10T00:00:00Z',
      'rcm-lead-1',
    );
    expect(b.sent).toEqual(['b-1']);
    expect(b.deferred).toEqual([]);
    expect(b.refused).toEqual([{ denialId: 'a-1', reason: 'not queued' }]);
  });
});

describe('WP-088 batch appeal throttle', () => {
  it('sends at most the per-payer allowance, nearest deadline first, and defers the rest', () => {
    const queues = setup();
    const throttle = new AppealThrottle(queues, {
      maxPerPayerPerWindow: 2,
      windowHours: 24,
      maxBatchSize: 50,
    });
    const result = throttle.submitBatch(
      T,
      ['p1-a', 'p1-b', 'p1-c', 'p1-d', 'p1-e', 'p2-a'],
      '2026-02-25T09:00:00Z',
      'rcm-lead-1',
    );
    expect(result.sent).toEqual(['p1-c', 'p2-a', 'p1-a']);
    expect(
      result.deferred.map((item) => `${item.denialId}:${item.reason}:${item.notBefore}`),
    ).toEqual([
      'p1-d:payer-throttle:2026-02-26T09:00:00Z',
      'p1-e:payer-throttle:2026-02-26T09:00:00Z',
      'p1-b:payer-throttle:2026-02-26T09:00:00Z',
    ]);
    expect(result.refused).toEqual([]);
    expect(queues.get(T, 'p1-c').status).toBe('appealed');
    expect(queues.get(T, 'p1-d').status).toBe('open');
  });

  it('flags a deferral that would pass the deadline instead of silently waiting', () => {
    const queues = setup();
    const throttle = new AppealThrottle(queues, {
      maxPerPayerPerWindow: 1,
      windowHours: 72,
      maxBatchSize: 50,
    });
    const result = throttle.submitBatch(T, ['p1-c', 'p1-a'], '2026-03-02T00:00:00Z', 'rcm-lead-1');
    // p1-c deadline 03-03 is sent; p1-a deadline 03-07 waits until 03-05: fine.
    expect(result.sent).toEqual(['p1-c']);
    expect(result.deferred).toEqual([
      {
        denialId: 'p1-a',
        reason: 'payer-throttle',
        notBefore: '2026-03-05T00:00:00Z',
        deadlineConflict: false,
      },
    ]);
    const later = throttle.submitBatch(T, ['p1-a', 'p1-d'], '2026-03-04T00:00:00Z', 'rcm-lead-1');
    // Still throttled until 03-05; p1-d's deadline 03-12 is safe, p1-a's 03-07 is too.
    expect(later.sent).toEqual([]);
    expect(later.deferred.map((item) => item.deadlineConflict)).toEqual([false, false]);
    const tight = new AppealThrottle(setup(), {
      maxPerPayerPerWindow: 1,
      windowHours: 240,
      maxBatchSize: 50,
    });
    const tightResult = tight.submitBatch(
      T,
      ['p1-c', 'p1-a'],
      '2026-03-02T00:00:00Z',
      'rcm-lead-1',
    );
    expect(tightResult.deferred).toEqual([
      {
        denialId: 'p1-a',
        reason: 'payer-throttle',
        notBefore: '2026-03-12T00:00:00Z',
        deadlineConflict: true,
      },
    ]);
  });

  it('frees the allowance as the sliding window moves', () => {
    const queues = setup();
    const throttle = new AppealThrottle(queues, {
      maxPerPayerPerWindow: 2,
      windowHours: 24,
      maxBatchSize: 50,
    });
    throttle.submitBatch(T, ['p1-a', 'p1-c', 'p1-d'], '2026-02-25T09:00:00Z', 'rcm-lead-1');
    const same = throttle.submitBatch(T, ['p1-d'], '2026-02-26T08:59:59Z', 'rcm-lead-1');
    expect(same.sent).toEqual([]);
    const next = throttle.submitBatch(T, ['p1-d'], '2026-02-26T09:00:00Z', 'rcm-lead-1');
    expect(next.sent).toEqual(['p1-d']);
  });

  it('caps the batch size across payers', () => {
    const throttle = new AppealThrottle(setup(), {
      maxPerPayerPerWindow: 10,
      windowHours: 24,
      maxBatchSize: 2,
    });
    const result = throttle.submitBatch(
      T,
      ['p1-a', 'p1-c', 'p2-a'],
      '2026-02-25T09:00:00Z',
      'rcm-lead-1',
    );
    expect(result.sent).toEqual(['p1-c', 'p2-a']);
    expect(result.deferred.map((item) => `${item.denialId}:${item.reason}`)).toEqual([
      'p1-a:batch-size',
    ]);
  });

  it('refuses repeats, unknown ids, already-appealed items and a batch that runs backwards in time', () => {
    const queues = setup();
    const throttle = new AppealThrottle(queues, {
      maxPerPayerPerWindow: 10,
      windowHours: 24,
      maxBatchSize: 50,
    });
    throttle.submitBatch(T, ['p1-a'], '2026-02-25T09:00:00Z', 'rcm-lead-1');
    const result = throttle.submitBatch(
      T,
      ['p1-a', 'nope', 'p1-c', 'p1-c'],
      '2026-02-25T10:00:00Z',
      'rcm-lead-1',
    );
    expect(result.sent).toEqual(['p1-c']);
    expect(result.refused).toEqual([
      { denialId: 'p1-a', reason: 'status appealed' },
      { denialId: 'nope', reason: 'not queued' },
      { denialId: 'p1-c', reason: 'listed twice in one batch' },
    ]);
    expect(() => throttle.submitBatch(T, [], '2026-02-25T08:00:00Z', 'rcm-lead-1')).toThrow(
      /before the previous/,
    );
    expect(
      () =>
        new AppealThrottle(queues, { maxPerPayerPerWindow: 0, windowHours: 1, maxBatchSize: 1 }),
    ).toThrow(/positive whole/);
  });
});
