import { describe, expect, it } from 'vitest';

import { evaluateCoveredVisit } from './awv-timing.js';

const partB = '2025-03-15';

describe('WP-094 AWV / IPPE window tracking (R6-REQ-025)', () => {
  it('IPPE is eligible only inside the first 12 months of Part B, once', () => {
    expect(
      evaluateCoveredVisit({
        kind: 'ippe',
        serviceDate: '2025-09-01',
        partBEffectiveDate: partB,
        history: [],
      }),
    ).toMatchObject({
      status: 'eligible',
      earliestEligible: partB,
    });
    expect(
      evaluateCoveredVisit({
        kind: 'ippe',
        serviceDate: '2026-03-15',
        partBEffectiveDate: partB,
        history: [],
      }).status,
    ).toBe('outside-ippe-window');
    expect(
      evaluateCoveredVisit({
        kind: 'ippe',
        serviceDate: '2026-03-14',
        partBEffectiveDate: partB,
        history: [],
      }).status,
    ).toBe('eligible');
    expect(
      evaluateCoveredVisit({
        kind: 'ippe',
        serviceDate: '2025-10-01',
        partBEffectiveDate: partB,
        history: [{ kind: 'ippe', date: '2025-05-01', status: 'completed' }],
      }),
    ).toMatchObject({
      status: 'already-used',
      earliestEligible: null,
      warnings: ['covered-visit-already-used'],
    });
  });

  it('AWV is not available in the first 12 months of Part B', () => {
    const early = evaluateCoveredVisit({
      kind: 'awv',
      serviceDate: '2026-03-14',
      partBEffectiveDate: partB,
      history: [],
    });
    expect(early).toMatchObject({ status: 'too-early', earliestEligible: '2026-03-15' });
    expect(
      evaluateCoveredVisit({
        kind: 'awv',
        serviceDate: '2026-03-15',
        partBEffectiveDate: partB,
        history: [],
      }).status,
    ).toBe('eligible');
  });

  it('AWV waits 12 months after an IPPE', () => {
    const result = evaluateCoveredVisit({
      kind: 'awv',
      serviceDate: '2026-04-01',
      partBEffectiveDate: partB,
      history: [{ kind: 'ippe', date: '2025-06-20', status: 'completed' }],
    });
    expect(result).toMatchObject({ status: 'too-early', earliestEligible: '2026-06-01' });
    expect(
      evaluateCoveredVisit({
        kind: 'awv',
        serviceDate: '2026-06-01',
        partBEffectiveDate: partB,
        history: [{ kind: 'ippe', date: '2025-06-20', status: 'completed' }],
      }).status,
    ).toBe('eligible');
    const blocked = evaluateCoveredVisit({
      kind: 'awv',
      serviceDate: '2026-04-01',
      partBEffectiveDate: '2025-01-01',
      history: [{ kind: 'ippe', date: '2025-12-01', status: 'completed' }],
    });
    expect(blocked).toMatchObject({ status: 'too-early', earliestEligible: '2026-12-01' });
  });

  it('AWV repeats only after 11 full months following the month of the last AWV', () => {
    const history = [{ kind: 'awv' as const, date: '2026-01-15', status: 'completed' as const }];
    expect(
      evaluateCoveredVisit({
        kind: 'awv',
        serviceDate: '2026-12-31',
        partBEffectiveDate: '2020-01-01',
        history,
      }),
    ).toMatchObject({ status: 'already-used', earliestEligible: '2027-01-01' });
    expect(
      evaluateCoveredVisit({
        kind: 'awv',
        serviceDate: '2027-01-01',
        partBEffectiveDate: '2020-01-01',
        history,
      }).status,
    ).toBe('eligible');
  });

  it('warns when a concierge visit would displace a scheduled covered AWV', () => {
    const result = evaluateCoveredVisit({
      kind: 'awv',
      serviceDate: '2026-05-01',
      partBEffectiveDate: '2020-01-01',
      history: [{ kind: 'awv', date: '2026-09-10', status: 'scheduled' }],
    });
    expect(result.status).toBe('eligible');
    expect(result.warnings).toEqual(['displaces-scheduled-awv:2026-09-10']);
  });

  it('never blocks on unknown history: flags manual confirmation before the claim', () => {
    for (const unknown of [
      { partBEffectiveDate: null, history: [] },
      { partBEffectiveDate: partB, history: null },
    ]) {
      expect(evaluateCoveredVisit({ kind: 'awv', serviceDate: '2026-05-01', ...unknown })).toEqual({
        kind: 'awv',
        status: 'unknown-history',
        earliestEligible: null,
        manualConfirmationRequired: true,
        warnings: ['manual-eligibility-confirmation-before-claim'],
      });
    }
  });

  it('refuses a malformed date', () => {
    expect(() =>
      evaluateCoveredVisit({
        kind: 'awv',
        serviceDate: '2026-5-1',
        partBEffectiveDate: partB,
        history: [],
      }),
    ).toThrow('YYYY-MM-DD');
  });
});
