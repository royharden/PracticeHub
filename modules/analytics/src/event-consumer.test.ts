import { describe, expect, it } from 'vitest';

import { makeEnvelope, makeFacts, makeMetricDefinition } from './analytics-fixture-harness.js';
import { consumeAnalyticsEvent, deduplicateFacts } from './event-consumer.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected fixture fact');
  return value;
}

describe('analytics event consumption', () => {
  it('maps and validates a frozen event envelope', () => {
    const source = required(makeFacts({ a: 1, b: 0 })[0]);
    const mapped = consumeAnalyticsEvent(makeMetricDefinition(), makeEnvelope(source), {
      map: () => source,
    });
    expect(mapped.eventId).toBe(source.eventId);
  });

  it('structurally excludes the genetic partition', () => {
    const source = {
      ...required(makeFacts({ a: 1, b: 0 })[0]),
      classification: 'PHI-restricted' as const,
      partitionTags: ['gipa-genetic' as const],
    };
    expect(() =>
      consumeAnalyticsEvent(makeMetricDefinition(), makeEnvelope(source), { map: () => source }),
    ).toThrow(/genetic data|classification exceeds/);
  });

  it('does not let an adapter downgrade envelope classification', () => {
    const source = required(makeFacts({ a: 1, b: 0 })[0]);
    const restrictedEnvelope = {
      ...makeEnvelope(source),
      dataClassification: 'PHI-restricted' as const,
    };
    expect(() =>
      consumeAnalyticsEvent(makeMetricDefinition(), restrictedEnvelope, { map: () => source }),
    ).toThrow(/classification must match/);
  });

  it('rejects runtime-cast labels outside the closed vocabularies', () => {
    const source = required(makeFacts({ a: 1, b: 0 })[0]);
    expect(() =>
      consumeAnalyticsEvent(makeMetricDefinition(), makeEnvelope(source), {
        map: () => ({ ...source, classification: 'bogus' as never }),
      }),
    ).toThrow(/closed vocabulary|classification must match/);
    expect(() =>
      consumeAnalyticsEvent(makeMetricDefinition(), makeEnvelope(source), {
        map: () => ({ ...source, partitionTags: ['unknown-tag' as never] }),
      }),
    ).toThrow(/closed vocabulary/);
  });

  it('deduplicates identical deliveries and rejects conflicting mappings', () => {
    const source = required(makeFacts({ a: 1, b: 0 })[0]);
    expect(deduplicateFacts([source, source])).toHaveLength(1);
    expect(() => deduplicateFacts([source, { ...source, measure: 2 }])).toThrow(
      /conflicting facts/,
    );
  });
});
