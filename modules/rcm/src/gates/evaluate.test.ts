import { describe, expect, it } from 'vitest';

import {
  evaluateGate,
  evaluatePromotion,
  fromConcordance,
  fromDenialOutcomes,
  fromEnrollmentChecks,
  fromPostingOutcomes,
} from './evaluate.js';
import {
  ALL_PLANS,
  EVENT_AT,
  NOW,
  observations,
  passingPayer,
  plan,
  TENANT,
} from './test-support.js';

describe('WP-092 gate evaluation', () => {
  it('a failing subgroup is not masked by a passing aggregate', () => {
    const data = [
      ...observations('denial-free', 'payer-1', 900, 891, { location: 'loc-nv' }),
      ...observations('denial-free', 'payer-1', 100, 70, { location: 'loc-fl' }),
    ];
    const result = evaluateGate(plan('denial-free'), data, NOW);
    expect(result.aggregate.verdict).toBe('pass');
    expect(result.aggregate.interval.lower).toBeGreaterThanOrEqual(0.9);
    expect(result.subgroups.map((cell) => `${cell.cell}:${cell.verdict}`)).toEqual([
      'location=loc-fl:fail',
      'location=loc-nv:pass',
      'payer=payer-1:pass',
    ]);
    expect(result.maskedFailures).toEqual(['location=loc-fl']);
    expect(result.verdict).toBe('fail');
  });

  it('control: the same aggregate with a healthy subgroup passes', () => {
    const data = [
      ...observations('denial-free', 'payer-1', 900, 891, { location: 'loc-nv' }),
      ...observations('denial-free', 'payer-1', 100, 99, { location: 'loc-fl' }),
    ];
    const result = evaluateGate(plan('denial-free'), data, NOW);
    expect(result.verdict).toBe('pass');
    expect(result.maskedFailures).toEqual([]);
  });

  it('a subgroup below the minimum sample is insufficient, and insufficient blocks', () => {
    const data = [
      ...observations('denial-free', 'payer-1', 300, 300, { location: 'loc-nv' }),
      ...observations('denial-free', 'payer-1', 10, 10, { location: 'loc-mn' }),
    ];
    const result = evaluateGate(plan('denial-free'), data, NOW);
    expect(result.subgroups.find((cell) => cell.cell === 'location=loc-mn')?.verdict).toBe(
      'insufficient',
    );
    expect(result.verdict).toBe('insufficient');
  });

  it('an observation missing a subgroup key lands in a (missing) cell instead of vanishing', () => {
    const data = [
      ...observations('denial-free', 'payer-1', 200, 200, { location: 'loc-nv' }),
      ...observations('denial-free', 'payer-1', 5, 0, {}),
    ];
    const result = evaluateGate(plan('denial-free'), data, NOW);
    expect(result.aggregate.interval.n).toBe(205);
    expect(result.subgroups.map((cell) => cell.cell)).toContain('location=(missing)');
    expect(result.verdict).not.toBe('pass');
  });

  it('counts only mature outcomes, and a pending outcome past maturity as a failure', () => {
    const fresh = observations('claim-concordance', 'payer-1', 50, 50, undefined, {
      eventAt: '2026-02-20T00:00:00Z',
    });
    const overdue = observations('claim-concordance', 'payer-1', 20, 0, undefined, {
      outcome: 'pending',
    });
    const mature = observations('claim-concordance', 'payer-1', 100, 100);
    const result = evaluateGate(plan('claim-concordance'), [...fresh, ...overdue, ...mature], NOW);
    expect(result.immature).toBe(50);
    expect(result.overduePending).toBe(20);
    expect(result.aggregate.interval.n).toBe(120);
    expect(result.aggregate.interval.successes).toBe(100);
  });

  it('one critical failure fails the gate at any rate, even before it matures', () => {
    const data = [
      ...observations('posting-reconciliation', 'payer-1', 5_000, 5_000),
      ...observations('posting-reconciliation', 'payer-1', 1, 0, undefined, {
        critical: true,
        eventAt: '2026-02-28T00:00:00Z',
      }),
    ];
    const result = evaluateGate(plan('posting-reconciliation'), data, NOW);
    expect(result.aggregate.criticalFailures).toBe(1);
    expect(result.verdict).toBe('fail');
  });

  it('a small perfect sample cannot pass: the lower bound is the test, not the point estimate', () => {
    const result = evaluateGate(
      plan('denial-free', { minSample: 5, subgroupKeys: [] }),
      observations('denial-free', 'payer-1', 20, 20),
      NOW,
    );
    expect(result.aggregate.interval.point).toBe(1);
    expect(result.verdict).toBe('fail');
  });

  it('refuses unsealed data, a late plan, a wrong gate and repeated observation ids', () => {
    expect(() =>
      evaluateGate(
        plan('denial-free'),
        observations('denial-free', 'payer-1', 1, 1, undefined, { seal: '' }),
        NOW,
      ),
    ).toThrow(/sealed data only/);
    expect(() =>
      evaluateGate(
        plan('denial-free', { registeredAt: '2026-01-15T00:00:00Z' }),
        observations('denial-free', 'payer-1', 1, 1),
        NOW,
      ),
    ).toThrow(/registered after its cohort began/);
    expect(() =>
      evaluateGate(plan('denial-free'), observations('claim-concordance', 'payer-1', 1, 1), NOW),
    ).toThrow(/cannot enter denial-free/);
    const one = observations('denial-free', 'payer-1', 1, 1);
    expect(() => evaluateGate(plan('denial-free'), [...one, ...one], NOW)).toThrow(/unique tokens/);
    expect(() => evaluateGate(plan('denial-free', { subgroupKeys: ['payer'] }), [], NOW)).toThrow(
      /payer is always/,
    );
  });
});

describe('WP-092 promotion dossier', () => {
  it('needs a plan for each of the four gates', () => {
    expect(() => evaluatePromotion(TENANT, ALL_PLANS.slice(0, 3), [], NOW, 'gate-agent-1')).toThrow(
      /missing enrollment-liveness/,
    );
  });

  it('judges each payer on its own gates, and the dossier on everything', () => {
    const data = [
      ...passingPayer('payer-1'),
      ...passingPayer('payer-2').filter((item) => item.gateId !== 'posting-reconciliation'),
      ...observations('posting-reconciliation', 'payer-2', 200, 150),
    ];
    const dossier = evaluatePromotion(TENANT, ALL_PLANS, data, NOW, 'gate-agent-1');
    expect(dossier.payers.map((payer) => `${payer.payerId}:${payer.verdict}`)).toEqual([
      'payer-1:pass',
      'payer-2:fail',
    ]);
    expect(dossier.gates.map((gate) => `${gate.gateId}:${gate.verdict}`)).toEqual([
      'claim-concordance:pass',
      'denial-free:pass',
      'posting-reconciliation:fail',
      'enrollment-liveness:pass',
    ]);
    expect(dossier.verdict).toBe('fail');
  });

  it('a payer with no evidence for a gate is insufficient, not passed', () => {
    const data = passingPayer('payer-1').filter((item) => item.gateId !== 'enrollment-liveness');
    const dossier = evaluatePromotion(TENANT, ALL_PLANS, data, NOW, 'gate-agent-1');
    expect(dossier.payers[0]?.verdict).toBe('insufficient');
  });
});

describe('WP-092 placeholder adapters', () => {
  it('maps the WP-088/089/091 placeholders and shadow concordance to gate observations', () => {
    const subgroups = { location: 'loc-nv' };
    expect(
      fromConcordance([
        {
          claimId: 'c-1',
          tenantId: TENANT,
          payerId: 'payer-1',
          seal: 's',
          sealedAt: EVENT_AT,
          matchedActual: null,
          subgroups,
        },
      ])[0],
    ).toMatchObject({ observationId: 'cc:c-1', gateId: 'claim-concordance', outcome: 'pending' });
    expect(
      fromDenialOutcomes([
        {
          packageId: 'WP-088',
          claimId: 'c-1',
          tenantId: TENANT,
          payerId: 'payer-1',
          seal: 's',
          submittedAt: EVENT_AT,
          denied: true,
          subgroups,
        },
      ])[0],
    ).toMatchObject({ gateId: 'denial-free', outcome: 'failure', critical: false });
    expect(
      fromPostingOutcomes([
        {
          packageId: 'WP-089',
          remitId: 'r-1',
          tenantId: TENANT,
          payerId: 'payer-1',
          seal: 's',
          receivedAt: EVENT_AT,
          reconciled: false,
          subgroups,
        },
      ])[0],
    ).toMatchObject({ gateId: 'posting-reconciliation', outcome: 'failure', critical: true });
    expect(
      fromEnrollmentChecks([
        {
          packageId: 'WP-091',
          checkId: 'e-1',
          tenantId: TENANT,
          payerId: 'payer-1',
          seal: 's',
          checkedAt: EVENT_AT,
          enrolledAndDiverse: true,
          subgroups,
        },
      ])[0],
    ).toMatchObject({ gateId: 'enrollment-liveness', outcome: 'success' });
  });
});
