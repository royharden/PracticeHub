import { describe, expect, it } from 'vitest';

import { makeMetricDefinition, makeProjection } from './analytics-fixture-harness.js';
import { assessFreshness } from './freshness.js';

describe('analytics freshness evidence', () => {
  it('treats the exact objective boundary as fresh', () => {
    const result = assessFreshness(
      makeMetricDefinition({ freshnessObjectiveMinutes: 60 }),
      makeProjection({ recordedAt: '2026-03-10T11:00:00.000Z' }),
      '2026-03-10T12:00:00.000Z',
    );
    expect(result).toMatchObject({ fresh: true, knownGaps: [] });
  });

  it('reports missing receipts and late sources explicitly', () => {
    const result = assessFreshness(
      makeMetricDefinition(),
      makeProjection({ sourceReceiptRef: '', recordedAt: '2026-03-10T10:59:59.000Z' }),
      '2026-03-10T12:00:00.000Z',
    );
    expect(result.fresh).toBe(false);
    expect(result.knownGaps).toEqual(['missing-receipt:source-a', 'late-source:source-a']);
  });

  it('reports an entirely missing required source', () => {
    const result = assessFreshness(
      makeMetricDefinition({ requiredSourceRefs: ['source-a', 'source-b'] }),
      makeProjection(),
      '2026-03-10T12:00:00.000Z',
    );
    expect(result.knownGaps).toContain('missing-source:source-b');
  });

  it('fails closed for invalid clocks and future source loads', () => {
    const definition = makeMetricDefinition();
    expect(assessFreshness(definition, makeProjection(), 'bad-date').fresh).toBe(false);
    const future = assessFreshness(
      definition,
      makeProjection({ recordedAt: '2026-03-10T12:00:01.000Z' }),
      '2026-03-10T12:00:00.000Z',
    );
    expect(future.knownGaps).toContain('future-load:source-a');
    expect(future.fresh).toBe(false);
  });
});
