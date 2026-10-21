import { describe, expect, it } from 'vitest';

import {
  CASH_FULFILLMENT_STAGES,
  CASH_LEAKAGE_GRACE_DAYS,
  CashFulfillmentPipeline,
  type CashPipelineError,
} from './pipeline.js';

const enteredAt = '2026-01-01T00:00:00.000Z';

describe('WP-058 cash fulfillment pipeline', () => {
  it('opens an owner queue at the paid aging threshold and not one minute earlier', () => {
    const pipeline = new CashFulfillmentPipeline();
    pipeline.track({
      tenantId: 'northwind-synthetic',
      workRef: 'work-paid-1',
      packageRef: 'pkg-1',
      stage: 'paid',
      enteredAt,
    });
    expect(pipeline.agedQueue('northwind-synthetic', '2026-01-01T00:59:00.000Z')).toEqual([]);
    expect(pipeline.agedQueue('northwind-synthetic', '2026-01-01T01:00:00.000Z')).toEqual([
      {
        workRef: 'work-paid-1',
        stage: 'paid',
        ownerRole: 'role:billing-owner',
        ageMinutes: 60,
        thresholdMinutes: 60,
      },
    ]);
  });

  it('rolls up partial package state and still lists the unfulfilled child', () => {
    const pipeline = new CashFulfillmentPipeline();
    pipeline.track({
      tenantId: 'northwind-synthetic',
      workRef: 'child-paid',
      packageRef: 'pkg-1',
      stage: 'paid',
      enteredAt,
    });
    pipeline.track({
      tenantId: 'northwind-synthetic',
      workRef: 'child-delivered',
      packageRef: 'pkg-1',
      stage: 'delivered',
      enteredAt,
    });
    const rollup = pipeline.rollup('northwind-synthetic', 'pkg-1');
    expect(rollup.partial).toBe(true);
    expect(rollup.children.map((child) => child.childRef)).toEqual([
      'child-paid',
      'child-delivered',
    ]);
    expect(rollup.unfulfilledChildRefs).toEqual(['child-paid']);
  });

  it('counts paid and scheduled work that has not reached performed', () => {
    const pipeline = new CashFulfillmentPipeline();
    pipeline.track({
      tenantId: 'northwind-synthetic',
      workRef: 'still-paid',
      packageRef: 'pkg-1',
      stage: 'paid',
      enteredAt,
    });
    pipeline.track({
      tenantId: 'northwind-synthetic',
      workRef: 'still-scheduled',
      packageRef: 'pkg-1',
      stage: 'scheduled',
      enteredAt,
    });
    pipeline.track({
      tenantId: 'northwind-synthetic',
      workRef: 'done-performed',
      packageRef: 'pkg-1',
      stage: 'performed',
      enteredAt,
    });
    expect(pipeline.leakage('northwind-synthetic')).toEqual({
      paidNotPerformed: 2,
      workRefs: ['still-paid', 'still-scheduled'],
    });
  });

  it('refuses a stage advance for unknown work', () => {
    const pipeline = new CashFulfillmentPipeline();
    expect(() =>
      pipeline.advance('northwind-synthetic', 'missing', 'performed', enteredAt),
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' } satisfies Partial<CashPipelineError>));
  });
});

// Rework 1 (review D48-WP-058-cc-review-1, F1 / NR-093). Each case fails on 2390dd1.
describe('WP-058 cash pipeline rework: advance is forward-only and event-sourced', () => {
  const tenant = 'northwind-synthetic';
  const at = (minutes: number): string =>
    new Date(Date.parse(enteredAt) + minutes * 60_000).toISOString();
  const tracked = (stage: 'paid' | 'delivered' = 'paid'): CashFulfillmentPipeline => {
    const pipeline = new CashFulfillmentPipeline();
    pipeline.track({ tenantId: tenant, workRef: 'w-1', packageRef: 'pkg-1', stage, enteredAt });
    return pipeline;
  };
  const codeOf = (action: () => unknown): string => {
    try {
      action();
    } catch (error) {
      return (error as CashPipelineError).code;
    }
    return 'NO_ERROR';
  };

  it('refuses a backward move and a same-stage move, leaving the stage unchanged', () => {
    const pipeline = tracked('delivered');
    expect(codeOf(() => pipeline.advance(tenant, 'w-1', 'paid', at(60)))).toBe('STAGE_REGRESSION');
    expect(codeOf(() => pipeline.advance(tenant, 'w-1', 'delivered', at(60)))).toBe(
      'STAGE_REGRESSION',
    );
    expect(pipeline.leakage(tenant).paidNotPerformed).toBe(0);
    expect(pipeline.history(tenant, 'w-1').map((event) => event.stage)).toEqual(['delivered']);
  });

  it('refuses a time before the current stage and an unparseable time', () => {
    const pipeline = tracked();
    expect(
      codeOf(() => pipeline.advance(tenant, 'w-1', 'scheduled', '2020-01-01T00:00:00.000Z')),
    ).toBe('CLOCK_INVALID');
    expect(codeOf(() => pipeline.advance(tenant, 'w-1', 'scheduled', 'garbage'))).toBe(
      'CLOCK_INVALID',
    );
    expect(pipeline.history(tenant, 'w-1')).toHaveLength(1);
  });

  it('appends every transition to the work history instead of overwriting it', () => {
    const pipeline = tracked();
    pipeline.advance(tenant, 'w-1', 'scheduled', at(10));
    pipeline.advance(tenant, 'w-1', 'performed', at(20));
    expect(
      pipeline.history(tenant, 'w-1').map((event) => [event.kind, event.stage, event.enteredAt]),
    ).toEqual([
      ['tracked', 'paid', enteredAt],
      ['advanced', 'scheduled', at(10)],
      ['advanced', 'performed', at(20)],
    ]);
  });

  it('allows a backward move only as a named correction with a reason, and records it', () => {
    const pipeline = tracked('delivered');
    expect(
      codeOf(() =>
        pipeline.correctStage(tenant, 'w-1', 'performed', at(5), { actorRef: '', reason: 'x' }),
      ),
    ).toBe('CORRECTION_INVALID');
    pipeline.correctStage(tenant, 'w-1', 'performed', at(5), {
      actorRef: 'role:billing-owner',
      reason: 'delivery recorded against the wrong order',
    });
    const last = pipeline.history(tenant, 'w-1').at(-1);
    expect(last).toMatchObject({
      kind: 'corrected',
      stage: 'performed',
      actorRef: 'role:billing-owner',
    });
  });

  it('one record the clock cannot age never breaks the tenant queue', () => {
    const pipeline = tracked();
    pipeline.track({
      tenantId: tenant,
      workRef: 'w-future',
      packageRef: 'pkg-1',
      stage: 'paid',
      enteredAt: at(600),
    });
    expect(pipeline.agedQueue(tenant, at(60)).map((entry) => entry.workRef)).toEqual(['w-1']);
    expect(pipeline.agedQueueReport(tenant, at(60)).skipped).toEqual([
      { workRef: 'w-future', reason: 'CLOCK_INVALID' },
    ]);
  });
});

describe('H-16 catalog-cash hardening', () => {
  const tenant = 'northwind-synthetic';

  it('NR-175: with a clock, work paid moments ago is not leakage until the grace period passes', () => {
    const pipeline = new CashFulfillmentPipeline();
    pipeline.track({
      tenantId: tenant,
      workRef: 'fresh',
      packageRef: 'pkg-1',
      stage: 'paid',
      enteredAt: '2026-03-01T09:00:00.000Z',
    });
    pipeline.track({
      tenantId: tenant,
      workRef: 'old',
      packageRef: 'pkg-1',
      stage: 'paid',
      enteredAt: '2026-02-01T09:00:00.000Z',
    });
    // Scheduling later does not restart the clock: payment time is what counts.
    pipeline.advance(tenant, 'old', 'scheduled', '2026-02-27T09:00:00.000Z');
    const now = '2026-03-01T09:00:10.000Z';
    expect(pipeline.leakage(tenant, { now })).toEqual({ paidNotPerformed: 1, workRefs: ['old'] });
    expect(CASH_LEAKAGE_GRACE_DAYS).toBe(7);
    expect(pipeline.leakage(tenant, { now: '2026-03-08T09:00:00.000Z' }).workRefs).toEqual([
      'fresh',
      'old',
    ]);
    expect(pipeline.leakage(tenant, { now, graceDays: 0 }).paidNotPerformed).toBe(2);
    expect(() => pipeline.leakage(tenant, { now: 'not-a-time' })).toThrow(
      expect.objectContaining({ code: 'CLOCK_INVALID' }),
    );
  });

  it('NR-094: the cash stage table has not drifted from the catalog stage table', async () => {
    // catalog-cash has no workspace dependency on catalog, so the shared table is enforced by
    // this drift test (read-only, test-only import by computed path).
    const path = new URL('../../catalog/src/fulfillment-pipeline.ts', import.meta.url).href;
    const catalog = (await import(/* @vite-ignore */ path)) as { FULFILLMENT_STAGES: unknown };
    expect(JSON.parse(JSON.stringify(CASH_FULFILLMENT_STAGES))).toEqual(
      JSON.parse(JSON.stringify(catalog.FULFILLMENT_STAGES)),
    );
  });
});
