import { describe, expect, it } from 'vitest';

import { makeMetricDefinition } from './analytics-fixture-harness.js';
import { assertMetricDefinition, metricDefinitionKey } from './metric-definition.js';

describe('metric definitions', () => {
  it('accepts a versioned, owned definition with a closed release family', () => {
    const definition = makeMetricDefinition();
    expect(() => assertMetricDefinition(definition)).not.toThrow();
    expect(metricDefinitionKey(definition)).toBe('analytics.synthetic.completed-visits:v1');
  });

  it('rejects a sub-two privacy threshold', () => {
    expect(() =>
      assertMetricDefinition({ ...makeMetricDefinition(), minimumCellCount: 1 }),
    ).toThrow(/at least 2/);
  });

  it('rejects release nodes that name cells outside the declared family', () => {
    const definition = makeMetricDefinition({
      releaseFamily: {
        familyId: 'invalid',
        atomicCellIds: ['a'],
        nodes: [{ nodeId: 'other', memberCellIds: ['b'] }],
      },
    });
    expect(() => assertMetricDefinition(definition)).toThrow(/unknown atomic cell/);
  });

  it('rejects runtime-cast policy labels and missing synthetic provenance', () => {
    expect(() =>
      assertMetricDefinition({ ...makeMetricDefinition(), status: 'forged' as never }),
    ).toThrow(/closed vocabulary/);
    expect(() =>
      assertMetricDefinition({ ...makeMetricDefinition(), synthetic: false as never }),
    ).toThrow(/synthetic-watermarked/);
  });
});
