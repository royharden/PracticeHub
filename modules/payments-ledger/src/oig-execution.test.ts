import { describe, expect, it } from 'vitest';

import { reportDoubleBills, routeTakeback, seededDoubleBillFixture } from './oig-execution.js';

describe('WP-095 OIG execution', () => {
  it('reports the seeded double-bill and does not miss it', () => {
    const findings = reportDoubleBills(seededDoubleBillFixture);
    expect(findings).toEqual([
      {
        patientRef: 'patient-casey',
        serviceRef: 'svc-awv',
        serviceDate: '2026-03-01',
        chargeIds: ['chg-insurance-awv', 'chg-membership-awv'],
      },
    ]);
  });

  it('routes an absorbed takeback to hardship', () => {
    expect(routeTakeback({ takebackId: 'tb-1', amountMinor: 2500, absorb: true })).toBe('hardship');
    expect(routeTakeback({ takebackId: 'tb-2', amountMinor: 2500, absorb: false })).toBe('reopen');
  });
});
