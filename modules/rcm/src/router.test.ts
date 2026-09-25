import { describe, expect, it } from 'vitest';

import { acceptRemit, ClearinghouseRouter, type PayerRoute, type RoutedClaim } from './router.js';

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

describe('WP-085 clearinghouse router', () => {
  it('fails over mid-batch without a duplicate claim', () => {
    const router = new ClearinghouseRouter([route], 'dual-rail');
    const result = router.submitBatch(claims, 1);
    expect(result.duplicateCount).toBe(0);
    expect(result.submitted.map((claim) => `${claim.claimId}:${claim.railId}`)).toEqual([
      'claim-1:ch-sim-A',
      'claim-2:ch-sim-B',
      'claim-3:ch-sim-B',
    ]);
    expect(new Set(result.submitted.map((claim) => claim.claimId)).size).toBe(3);
    router.manualSwitch('payer-1', 'ch-sim-B', 'drill');
    const next = router.submitBatch([{ claimId: 'claim-4', payerId: 'payer-1' }]);
    expect(next.submitted[0]?.railId).toBe('ch-sim-B');
    expect(router.switchLog()).toEqual([
      { payerId: 'payer-1', target: 'ch-sim-B', reason: 'drill' },
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
