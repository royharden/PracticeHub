import { describe, expect, it } from 'vitest';

import {
  scheduleAfterFeeChoice,
  wp071MarketingTouchPlaceholder,
  type ServiceCoverageClass,
} from './decline-fee.js';

// Decision D-1 (additions/decision-policy-2.md, NR-167): declining the membership fee withholds
// only non-covered concierge services; a service covered for the active payer always schedules.

function attempt(declineFee: boolean, coverage: ServiceCoverageClass) {
  const calls = { schedule: 0, marketing: 0 };
  const result = scheduleAfterFeeChoice({
    declineFee,
    coverage,
    onSchedule: () => {
      calls.schedule += 1;
    },
    onMarketingTouch: () => {
      calls.marketing += 1;
    },
  });
  return { result, calls };
}

describe('decline-the-fee (D-1)', () => {
  it('schedules a covered service when the fee is declined, with no fee, routed to the payer claim', () => {
    const { result, calls } = attempt(true, 'covered');
    expect(result).toEqual({
      outcome: 'scheduled',
      scheduled: true,
      sideEffects: 1,
      billTo: 'payer-claim',
      reason: 'covered-service-never-conditioned-on-fee',
    });
    expect(calls).toEqual({ schedule: 1, marketing: 0 });
  });

  it('withholds a non-covered concierge service when the fee is declined', () => {
    const { result, calls } = attempt(true, 'non-covered');
    expect(result).toEqual({
      outcome: 'withheld',
      scheduled: false,
      sideEffects: 0,
      billTo: null,
      reason: 'membership-fee-declined',
    });
    expect(calls).toEqual({ schedule: 0, marketing: 0 });
  });

  it('holds a conditionally-covered or unclassified service for review and never schedules it', () => {
    for (const declineFee of [true, false]) {
      for (const coverage of ['conditionally-covered', 'unclassified'] as const) {
        const { result, calls } = attempt(declineFee, coverage);
        expect(result.outcome).toBe('held-for-review');
        expect(result.scheduled).toBe(false);
        expect(calls).toEqual({ schedule: 0, marketing: 0 });
      }
    }
  });

  it('schedules a non-covered service on the membership fee when the fee is accepted', () => {
    const { result, calls } = attempt(false, 'non-covered');
    expect(result).toMatchObject({ outcome: 'scheduled', billTo: 'membership-fee' });
    expect(calls).toEqual({ schedule: 1, marketing: 0 });
  });

  it('a covered service is billed to the payer whatever the fee choice', () => {
    expect(attempt(false, 'covered').result.billTo).toBe('payer-claim');
  });

  it('never invokes the WP-071 marketing touch, and keeps the placeholder shape', () => {
    for (const declineFee of [true, false]) {
      for (const coverage of [
        'covered',
        'non-covered',
        'conditionally-covered',
        'unclassified',
      ] as const) {
        expect(attempt(declineFee, coverage).calls.marketing).toBe(0);
      }
    }
    expect(wp071MarketingTouchPlaceholder).toEqual({
      packageId: 'WP-071',
      typeName: 'MarketingTouch',
      fixtureId: 'wp071-marketing-touch',
    });
  });

  it('fails closed on a coverage class it does not know', () => {
    const { result, calls } = attempt(true, 'covered-maybe' as ServiceCoverageClass);
    expect(result.outcome).toBe('held-for-review');
    expect(calls.schedule).toBe(0);
  });
});
