import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  FULFILLMENT_STAGES,
  leakageWorkRefs,
  queueForAge,
  rollupPackage,
  stageDefinition,
  type PipelineError,
} from './fulfillment-pipeline.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));

describe('WP-058 fulfillment pipeline', () => {
  it('gives every stage an owner and opens a queue only at the aging threshold', () => {
    for (const stage of FULFILLMENT_STAGES) {
      expect(stage.ownerRole.length).toBeGreaterThan(0);
      expect(stage.agingThresholdMinutes).toBeGreaterThan(0);
    }
    const paid = stageDefinition('paid');
    const enteredAt = '2026-01-01T00:00:00.000Z';
    expect(
      queueForAge({
        workRef: 'work-paid-1',
        stage: paid,
        enteredAt,
        now: '2026-01-01T00:59:00.000Z',
      }),
    ).toBeNull();
    expect(
      queueForAge({
        workRef: 'work-paid-1',
        stage: paid,
        enteredAt,
        now: '2026-01-01T01:00:00.000Z',
      }),
    ).toEqual({
      workRef: 'work-paid-1',
      stage: 'paid',
      ownerRole: 'role:billing-owner',
      ageMinutes: 60,
      thresholdMinutes: 60,
    });
    expect(() =>
      queueForAge({
        workRef: 'work-paid-1',
        stage: { ...paid, ownerRole: '' },
        enteredAt,
        now: '2026-01-01T01:00:00.000Z',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'STAGE_OWNER_REQUIRED',
      } satisfies Partial<PipelineError>),
    );
  });

  it('rolls up a partial package without hiding the unfulfilled child', () => {
    const rollup = rollupPackage('pkg-1', [
      { childRef: 'child-paid', stage: 'paid' },
      { childRef: 'child-delivered', stage: 'delivered' },
    ]);
    expect(rollup.partial).toBe(true);
    expect(rollup.children.map((child) => child.childRef)).toEqual([
      'child-paid',
      'child-delivered',
    ]);
    expect(rollup.unfulfilledChildRefs).toEqual(['child-paid']);
    expect(rollup.children.find((child) => child.childRef === 'child-paid')?.fulfilled).toBe(false);
  });

  it('counts paid work that has not reached performed as leakage', () => {
    expect(
      leakageWorkRefs([
        { workRef: 'still-paid', stage: 'paid' },
        { workRef: 'still-scheduled', stage: 'scheduled' },
        { workRef: 'done-performed', stage: 'performed' },
        { workRef: 'done-delivered', stage: 'delivered' },
      ]),
    ).toEqual(['still-paid', 'still-scheduled']);
  });

  it('keeps the estimate contract copy inside the catalog module', () => {
    const copied = readFileSync(`${root}modules/catalog/contracts/estimate-api.md`);
    expect(copied.length).toBeGreaterThan(0);
    // docs/ is private and absent from a public clone; the drift check runs wherever it exists.
    const docsPath = `${root}docs/contracts/estimate-api.md`;
    if (existsSync(docsPath)) {
      expect(Buffer.compare(readFileSync(docsPath), copied)).toBe(0);
    }
  });
});
