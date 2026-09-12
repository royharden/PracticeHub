import { describe, expect, it } from 'vitest';

import { makeFacts, makeMetricDefinition, makeProjection } from './analytics-fixture-harness.js';
import { rebuildProjection } from './rebuild.js';

describe('analytics rebuild', () => {
  it('rebuilds an identical immutable version from source facts', () => {
    const expected = makeProjection();
    const result = rebuildProjection({
      definition: makeMetricDefinition(),
      facts: makeFacts({ a: 5, b: 5 }),
      expected,
    });
    expect(result.equivalent).toBe(true);
    expect(result.projection.contentHash).toBe(expected.contentHash);
  });

  it('detects divergence without mutating the prior version', () => {
    const expected = makeProjection();
    const result = rebuildProjection({
      definition: makeMetricDefinition(),
      facts: makeFacts({ a: 6, b: 5 }),
      expected,
      versionRef: 'projection:0002',
      builtAt: '2026-03-10T12:05:00.000Z',
    });
    expect(result.equivalent).toBe(false);
    expect(result.projection.supersedesVersionRef).toBe(expected.versionRef);
    expect(result.projection.verificationStatus).toBe('quarantined');
    expect(result.quarantineReason).toBe('rebuild-divergence');
    expect(expected.versionRef).toBe('projection:0001');
  });

  it('does not trust an expected hash that no longer matches expected bytes', () => {
    const expected = makeProjection();
    const tampered = {
      ...expected,
      cells: expected.cells.map((cell, index) => (index === 0 ? { ...cell, value: 999 } : cell)),
    };
    expect(
      rebuildProjection({
        definition: makeMetricDefinition(),
        facts: makeFacts({ a: 5, b: 5 }),
        expected: tampered,
      }).equivalent,
    ).toBe(false);
  });
});
