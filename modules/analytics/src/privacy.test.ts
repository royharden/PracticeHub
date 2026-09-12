import { describe, expect, it } from 'vitest';

import {
  makeMetricDefinition,
  makeProjection,
  northwindTenant,
} from './analytics-fixture-harness.js';
import { evaluateRelease, safeReleaseNodeIds } from './privacy.js';

const scope = {
  tenantId: northwindTenant,
  datasetId: 'dataset:visits',
  cohortRef: 'cohort:all',
  metricId: 'analytics.synthetic.completed-visits',
  projectionVersionRef: 'projection:0001',
  purpose: 'operations',
} as const;

describe('analytics privacy release', () => {
  it('allows every member of a safe declared query family', () => {
    expect([...safeReleaseNodeIds(makeMetricDefinition(), makeProjection())].sort()).toEqual([
      'a',
      'b',
      'total',
    ]);
  });

  it('suppresses complementary queries in both request orders', () => {
    const definition = makeMetricDefinition();
    const projection = makeProjection({ a: 5, b: 3 });
    const decide = (nodeId: string) =>
      evaluateRelease({ definition, projection, scope, nodeId, history: [] });
    expect([decide('total'), decide('a')]).toEqual([
      { allowed: false, reason: 'differencing-risk' },
      { allowed: false, reason: 'differencing-risk' },
    ]);
    expect([decide('a'), decide('total')]).toEqual([
      { allowed: false, reason: 'differencing-risk' },
      { allowed: false, reason: 'differencing-risk' },
    ]);
  });

  it('blocks three-query reconstruction when one hidden atom is sub-k', () => {
    const definition = makeMetricDefinition({
      releaseFamily: {
        familyId: 'three-query-reconstruction',
        atomicCellIds: ['a', 'b', 'c'],
        nodes: [
          { nodeId: 'total', memberCellIds: ['a', 'b', 'c'] },
          { nodeId: 'b', memberCellIds: ['b'] },
          { nodeId: 'c', memberCellIds: ['c'] },
        ],
      },
    });
    const projection = {
      ...makeProjection({ a: 1, b: 5 }),
      cells: [
        { cellId: 'a', count: 1, value: 1, workItemRefs: [] },
        { cellId: 'b', count: 5, value: 5, workItemRefs: [] },
        { cellId: 'c', count: 5, value: 5, workItemRefs: [] },
      ],
    };
    expect([...safeReleaseNodeIds(definition, projection)]).toEqual([]);
  });

  it('distinguishes a direct small cell from a differencing risk', () => {
    expect(
      evaluateRelease({
        definition: makeMetricDefinition(),
        projection: makeProjection({ a: 5, b: 3 }),
        scope,
        nodeId: 'b',
        history: [],
      }),
    ).toEqual({ allowed: false, reason: 'small-cell' });
  });

  it('rejects disclosure scopes that do not match the projection', () => {
    expect(() =>
      evaluateRelease({
        definition: makeMetricDefinition(),
        projection: makeProjection(),
        scope: { ...scope, datasetId: 'dataset:other' },
        nodeId: 'total',
        history: [],
      }),
    ).toThrow(/scope does not match/);
  });

  it('fails closed across projection versions in the same dataset and cohort', () => {
    const projection = makeProjection({ versionRef: 'projection:0002' });
    const currentScope = { ...scope, projectionVersionRef: 'projection:0002' };
    expect(
      evaluateRelease({
        definition: makeMetricDefinition(),
        projection,
        scope: currentScope,
        nodeId: 'total',
        history: [
          {
            ...scope,
            disclosureId: 'disclosure:v1',
            nodeId: 'total',
            surface: 'view',
            occurredAt: '2026-03-10T11:00:00.000Z',
            synthetic: true,
          },
        ],
      }),
    ).toEqual({ allowed: false, reason: 'differencing-risk' });
  });

  it('fails closed when the same dataset/cohort history uses another metric or purpose', () => {
    const projection = makeProjection();
    for (const prior of [
      { metricId: 'analytics.synthetic.other', purpose: scope.purpose },
      { metricId: scope.metricId, purpose: 'audit' },
    ]) {
      expect(
        evaluateRelease({
          definition: makeMetricDefinition(),
          projection,
          scope,
          nodeId: 'total',
          history: [
            {
              ...scope,
              ...prior,
              disclosureId: `disclosure:${prior.metricId}:${prior.purpose}`,
              nodeId: 'total',
              surface: 'view',
              occurredAt: '2026-03-10T11:00:00.000Z',
              synthetic: true,
            },
          ],
        }),
      ).toEqual({ allowed: false, reason: 'differencing-risk' });
    }
  });
});
