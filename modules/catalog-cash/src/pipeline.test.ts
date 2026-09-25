import { describe, expect, it } from 'vitest';

import { CashFulfillmentPipeline, type CashPipelineError } from './pipeline.js';

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
