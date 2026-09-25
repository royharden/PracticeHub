/** Marketing touch owned by WP-071. This module does not implement it. */
export interface MarketingTouchPlaceholder {
  readonly packageId: 'WP-071';
  readonly typeName: 'MarketingTouch';
  readonly fixtureId: 'wp071-marketing-touch';
}

export const wp071MarketingTouchPlaceholder: MarketingTouchPlaceholder = {
  packageId: 'WP-071',
  typeName: 'MarketingTouch',
  fixtureId: 'wp071-marketing-touch',
};

export interface ScheduleAttempt {
  readonly scheduled: boolean;
  readonly sideEffects: number;
}

/**
 * Decline-the-fee blocks the scheduling side effect. The WP-071 marketing
 * touch is not invoked from this path.
 */
export function scheduleAfterFeeChoice(input: {
  readonly declineFee: boolean;
  readonly onSchedule: () => void;
}): ScheduleAttempt {
  if (input.declineFee) {
    return { scheduled: false, sideEffects: 0 };
  }
  input.onSchedule();
  return { scheduled: true, sideEffects: 1 };
}
