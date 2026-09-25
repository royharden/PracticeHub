import { describe, expect, it } from 'vitest';

import { scheduleAfterFeeChoice, wp071MarketingTouchPlaceholder } from './decline-fee.js';

describe('decline-the-fee', () => {
  it('prevents the scheduling side effect', () => {
    let calls = 0;
    const declined = scheduleAfterFeeChoice({
      declineFee: true,
      onSchedule: () => {
        calls += 1;
      },
    });
    expect(declined).toEqual({ scheduled: false, sideEffects: 0 });
    expect(calls).toBe(0);
    expect(wp071MarketingTouchPlaceholder).toEqual({
      packageId: 'WP-071',
      typeName: 'MarketingTouch',
      fixtureId: 'wp071-marketing-touch',
    });
  });

  it('schedules when the fee is not declined', () => {
    let calls = 0;
    const accepted = scheduleAfterFeeChoice({
      declineFee: false,
      onSchedule: () => {
        calls += 1;
      },
    });
    expect(accepted.scheduled).toBe(true);
    expect(calls).toBe(1);
  });
});
