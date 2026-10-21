import { describe, expect, it } from 'vitest';

import { evaluateCoveredVisit } from './awv-timing.js';
import {
  bucketForCatalogKind,
  routeSplitBilling,
  type CompositionElement,
  type ProposedCharge,
} from './split-billing.js';

const elements: readonly CompositionElement[] = [
  { componentRef: 'awv-health-risk-assessment', bucket: 'awv-covered' },
  { componentRef: 'awv-personalized-plan', bucket: 'awv-covered' },
  { componentRef: 'vo2max-test', bucket: 'non-covered-enhanced' },
  { componentRef: 'extended-time-60', bucket: 'non-covered-enhanced' },
];

const charge = (componentRef: string, rail: ProposedCharge['rail']): ProposedCharge => ({
  chargeRef: `chg:${componentRef}:${rail}`,
  componentRef,
  rail,
});

const cleanCharges: readonly ProposedCharge[] = [
  charge('awv-health-risk-assessment', 'medicare-claim'),
  charge('awv-personalized-plan', 'medicare-claim'),
  charge('vo2max-test', 'membership'),
  charge('extended-time-60', 'cash'),
];

const eligibleAwv = evaluateCoveredVisit({
  kind: 'awv',
  serviceDate: '2026-05-01',
  partBEffectiveDate: '2020-01-01',
  history: [],
});

describe('WP-094 split billing: one element is never billed both ways (R6-REQ-024)', () => {
  it('routes covered elements to the claim and enhanced elements to membership or cash', () => {
    const decision = routeSplitBilling({
      medicarePatient: true,
      elements,
      charges: cleanCharges,
      windows: { awv: eligibleAwv },
    });
    expect(decision.submit).toBe(true);
    expect(decision.holds).toEqual([]);
    expect(decision.claimLines.map((line) => line.componentRef)).toEqual([
      'awv-health-risk-assessment',
      'awv-personalized-plan',
    ]);
    expect(decision.membershipLines.map((line) => line.componentRef)).toEqual(['vo2max-test']);
    expect(decision.cashLines.map((line) => line.componentRef)).toEqual(['extended-time-60']);
    expect(decision.adjudication.every((row) => row.rails.length === 1)).toBe(true);
  });

  it('blocks submission when a covered element is also charged to membership', () => {
    const decision = routeSplitBilling({
      medicarePatient: true,
      elements,
      charges: [...cleanCharges, charge('awv-health-risk-assessment', 'membership')],
      windows: { awv: eligibleAwv },
    });
    expect(decision.submit).toBe(false);
    expect(decision.holds).toEqual([
      {
        componentRef: 'awv-health-risk-assessment',
        reason: 'element-billed-both-ways',
        queue: 'biller-review',
      },
      {
        componentRef: 'awv-health-risk-assessment',
        reason: 'covered-element-off-claim',
        queue: 'compliance-review',
      },
    ]);
  });

  it('blocks an enhanced element billed to both the claim and cash', () => {
    const decision = routeSplitBilling({
      medicarePatient: true,
      elements,
      charges: [...cleanCharges, charge('extended-time-60', 'medicare-claim')],
      windows: { awv: eligibleAwv },
    });
    expect(decision.holds.map((item) => item.reason)).toEqual([
      'element-billed-both-ways',
      'noncovered-element-on-claim',
    ]);
  });

  it('blocks an element charged to membership and cash at once, even for a non-Medicare patient', () => {
    const decision = routeSplitBilling({
      medicarePatient: false,
      elements,
      charges: [
        ...cleanCharges.filter((item) => item.rail !== 'medicare-claim'),
        charge('vo2max-test', 'cash'),
      ],
      windows: {},
    });
    expect(decision.holds).toEqual([
      { componentRef: 'vo2max-test', reason: 'element-billed-both-ways', queue: 'biller-review' },
    ]);
  });

  it('holds an unclassified element for compliance review and a stray charge for biller review', () => {
    const decision = routeSplitBilling({
      medicarePatient: true,
      elements: [
        ...elements,
        { componentRef: 'body-composition-dexa', bucket: bucketForCatalogKind('other') },
      ],
      charges: [
        ...cleanCharges,
        charge('body-composition-dexa', 'cash'),
        charge('mystery-item', 'cash'),
      ],
      windows: { awv: eligibleAwv },
    });
    expect(decision.holds).toEqual([
      { componentRef: 'mystery-item', reason: 'charge-not-in-composition', queue: 'biller-review' },
      {
        componentRef: 'body-composition-dexa',
        reason: 'unclassified-element',
        queue: 'compliance-review',
      },
    ]);
    expect(decision.cashLines.map((line) => line.componentRef)).not.toContain('mystery-item');
  });

  it('holds a covered element that never reaches the claim', () => {
    const decision = routeSplitBilling({
      medicarePatient: true,
      elements,
      charges: cleanCharges.filter((item) => item.componentRef !== 'awv-personalized-plan'),
      windows: { awv: eligibleAwv },
    });
    expect(decision.holds).toEqual([
      {
        componentRef: 'awv-personalized-plan',
        reason: 'covered-element-unbilled',
        queue: 'biller-review',
      },
    ]);
  });

  it('holds covered claim lines when the AWV is already used or eligibility is unknown', () => {
    const used = evaluateCoveredVisit({
      kind: 'awv',
      serviceDate: '2026-05-01',
      partBEffectiveDate: '2020-01-01',
      history: [{ kind: 'awv', date: '2026-01-15', status: 'completed' }],
    });
    expect(
      routeSplitBilling({
        medicarePatient: true,
        elements,
        charges: cleanCharges,
        windows: { awv: used },
      }).holds.map((item) => item.reason),
    ).toEqual(['covered-visit-not-eligible', 'covered-visit-not-eligible']);
    const unknown = evaluateCoveredVisit({
      kind: 'awv',
      serviceDate: '2026-05-01',
      partBEffectiveDate: null,
      history: null,
    });
    expect(
      routeSplitBilling({
        medicarePatient: true,
        elements,
        charges: cleanCharges,
        windows: { awv: unknown },
      }).holds[0],
    ).toEqual({
      componentRef: 'awv-health-risk-assessment',
      reason: 'manual-eligibility-confirmation',
      queue: 'eligibility-confirmation',
    });
  });

  it('maps catalog kinds to buckets and refuses a composition that lists an element twice', () => {
    expect(bucketForCatalogKind('awv')).toBe('awv-covered');
    expect(bucketForCatalogKind('ippe')).toBe('ippe-covered');
    expect(bucketForCatalogKind('cash-service')).toBe('non-covered-enhanced');
    expect(bucketForCatalogKind('lab')).toBeNull();
    expect(() =>
      routeSplitBilling({
        medicarePatient: true,
        elements: [...elements, { componentRef: 'vo2max-test', bucket: 'awv-covered' }],
        charges: [],
        windows: {},
      }),
    ).toThrow('lists vo2max-test twice');
  });
});
