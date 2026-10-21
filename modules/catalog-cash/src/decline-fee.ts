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

/**
 * Coverage of the service for the patient's active payer at scheduling (R6-REQ-022). The caller
 * resolves it; counsel owns the covered/non-covered line for specific services.
 */
export type ServiceCoverageClass =
  'covered' | 'non-covered' | 'conditionally-covered' | 'unclassified';

export interface ScheduleAttempt {
  readonly outcome: 'scheduled' | 'withheld' | 'held-for-review';
  readonly scheduled: boolean;
  readonly sideEffects: number;
  /** Where the scheduled service is billed; null when nothing is scheduled. */
  readonly billTo: 'payer-claim' | 'membership-fee' | null;
  readonly reason:
    | 'covered-service-never-conditioned-on-fee'
    | 'membership-fee-accepted'
    | 'membership-fee-declined'
    | 'coverage-needs-review';
}

/**
 * Decline-the-fee (decision D-1, NR-167; compliance map §B, R6-REQ-020/022/024/026).
 *
 * A membership fee may not cover items or services already covered by the patient's payer, so
 * declining it withholds only non-covered concierge services. A covered service always schedules,
 * with no fee, and routes to the payer claim. A conditionally-covered, unclassified or unknown
 * service is held for review and never scheduled. Declining triggers no marketing touch: the
 * WP-071 hook is accepted only so that a caller can prove it is never invoked from this path.
 */
export function scheduleAfterFeeChoice(input: {
  readonly declineFee: boolean;
  readonly coverage: ServiceCoverageClass;
  readonly onSchedule: () => void;
  readonly onMarketingTouch?: () => void;
}): ScheduleAttempt {
  if (input.coverage === 'covered') {
    input.onSchedule();
    return {
      outcome: 'scheduled',
      scheduled: true,
      sideEffects: 1,
      billTo: 'payer-claim',
      reason: 'covered-service-never-conditioned-on-fee',
    };
  }
  if (input.coverage === 'non-covered') {
    if (input.declineFee) {
      return {
        outcome: 'withheld',
        scheduled: false,
        sideEffects: 0,
        billTo: null,
        reason: 'membership-fee-declined',
      };
    }
    input.onSchedule();
    return {
      outcome: 'scheduled',
      scheduled: true,
      sideEffects: 1,
      billTo: 'membership-fee',
      reason: 'membership-fee-accepted',
    };
  }
  // conditionally-covered, unclassified, or anything unknown: fail closed to human review.
  return {
    outcome: 'held-for-review',
    scheduled: false,
    sideEffects: 0,
    billTo: null,
    reason: 'coverage-needs-review',
  };
}
