import { describe, expect, it } from 'vitest';

import {
  monitorFeeScheduleFreshness,
  type FeeScheduleSnapshot,
  type FreshnessAlarmCode,
} from './fee-schedule-freshness.js';

const reference: FeeScheduleSnapshot = {
  scheduleId: 'ref-payer-1-2026',
  payerId: 'payer-1',
  version: '2026.1',
  publishedOn: '2026-01-01',
  loadedAt: '2026-01-02T00:00:00Z',
  rates: [
    { code: '99213', amountMinor: 9_000 },
    { code: '99214', amountMinor: 13_000 },
  ],
};

const local: FeeScheduleSnapshot = {
  ...reference,
  scheduleId: 'loc-payer-1-2026',
  loadedAt: '2026-01-05T00:00:00Z',
};

function codes(
  l: FeeScheduleSnapshot,
  now = '2026-02-01T00:00:00Z',
  r: FeeScheduleSnapshot = reference,
): FreshnessAlarmCode[] {
  return monitorFeeScheduleFreshness(l, r, now, { maxAgeDays: 90, toleranceMinor: 0 }).alarms.map(
    (a) => a.code,
  );
}

describe('WP-084 fee-schedule freshness monitor', () => {
  it('is fresh when the local copy matches a current reference', () => {
    const report = monitorFeeScheduleFreshness(local, reference, '2026-02-01T00:00:00Z');
    expect(report.fresh).toBe(true);
    expect(report.alarms).toEqual([]);
    expect(report.ageDays).toBe(27);
  });

  it('alarms stale-load one day past the limit, not on the limit', () => {
    expect(codes(local, '2026-04-05T00:00:00Z')).toEqual([]); // 90 days
    expect(codes(local, '2026-04-06T00:00:00Z')).toEqual(['stale-load']); // 91 days
  });

  it('alarms when the reference has published a newer version, and when local claims to be newer', () => {
    expect(
      codes(local, undefined, { ...reference, version: '2026.2', publishedOn: '2026-01-15' }),
    ).toEqual(['behind-reference']);
    expect(codes({ ...local, publishedOn: '2026-01-20' })).toEqual(['ahead-of-reference']);
  });

  it('alarms divergence in both directions', () => {
    const above = {
      ...local,
      rates: [
        { code: '99213', amountMinor: 9_001 },
        { code: '99214', amountMinor: 13_000 },
      ],
    };
    const below = {
      ...local,
      rates: [
        { code: '99213', amountMinor: 8_999 },
        { code: '99214', amountMinor: 13_000 },
      ],
    };
    expect(codes(above)).toEqual(['divergent-above-reference']);
    expect(codes(below)).toEqual(['divergent-below-reference']);
  });

  it('respects the tolerance exactly at its edge', () => {
    const above = {
      ...local,
      rates: [
        { code: '99213', amountMinor: 9_005 },
        { code: '99214', amountMinor: 12_995 },
      ],
    };
    const at = monitorFeeScheduleFreshness(above, reference, '2026-02-01T00:00:00Z', {
      maxAgeDays: 90,
      toleranceMinor: 5,
    });
    expect(at.alarms).toEqual([]);
    const past = monitorFeeScheduleFreshness(above, reference, '2026-02-01T00:00:00Z', {
      maxAgeDays: 90,
      toleranceMinor: 4,
    });
    expect(past.alarms.map((a) => [a.code, a.rateCode])).toEqual([
      ['divergent-above-reference', '99213'],
      ['divergent-below-reference', '99214'],
    ]);
  });

  it('alarms codes missing on either side', () => {
    const fewer = {
      ...local,
      rates: [
        { code: '99213', amountMinor: 9_000 },
        { code: '99215', amountMinor: 18_000 },
      ],
    };
    expect(codes(fewer)).toEqual(['missing-locally', 'missing-in-reference']);
  });

  it('refuses mismatched payers, future loads, duplicate codes and bad policy', () => {
    expect(() => codes({ ...local, payerId: 'payer-2' })).toThrow(/different payers/);
    expect(() => codes({ ...local, loadedAt: '2026-03-01T00:00:00Z' })).toThrow(/after the check/);
    expect(() =>
      codes({ ...local, rates: [...local.rates, { code: '99213', amountMinor: 1 }] }),
    ).toThrow(/twice/);
    expect(() =>
      monitorFeeScheduleFreshness(local, reference, '2026-02-01T00:00:00Z', {
        maxAgeDays: -1,
        toleranceMinor: 0,
      }),
    ).toThrow(/non-negative/);
  });
});
