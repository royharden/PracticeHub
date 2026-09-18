import { describe, expect, it } from 'vitest';

import { AthenaSimAdapter } from './adapter.js';
import { replayDeltas } from './delta.js';
import { loadGolden } from './goldens.js';

describe('athena-sim adapter', () => {
  it('records a local clinical-contracts double without claiming WP-060 integration', () => {
    const adapter = new AthenaSimAdapter();
    adapter.observe({
      tenantId: 'northwind-synthetic',
      subjectRef: 'wp061-subject-1',
      resourceType: 'Observation',
      id: 'obs-1',
    });
    expect(adapter.contracts.last()?.parityStatus).toBe('WP-060-integration-required');
  });

  it('makes eligibility failures visible when the API is down or cache is stale', () => {
    const adapter = new AthenaSimAdapter();
    expect(adapter.degradedDrill(true, false)).toBe('fail-visible');
    adapter.cache.put({
      key: 'k1',
      tenantId: 'northwind-synthetic',
      payloadHash: 'abc',
      observedAt: '2026-09-18T00:00:00.000Z',
      staleAfter: '2026-09-18T00:01:00.000Z',
    });
    expect(adapter.cache.isStale('k1', '2026-09-18T00:02:00.000Z')).toBe(true);
    expect(adapter.cache.purge()).toBe(1);
  });

  it('holds results without granted recording consent', () => {
    const adapter = new AthenaSimAdapter();
    const held = adapter.releaseIfConsented(
      {
        tenantId: 'northwind-synthetic',
        subjectRef: 'wp061-subject-1',
        purpose: 'results-release',
        state: 'denied',
        synthetic: true,
      },
      'result-1',
    );
    expect(held.visible).toBe(false);
  });

  it('replays deltas in sequence without duplicates', () => {
    const replayed = replayDeltas([
      {
        id: 'd2',
        tenantId: 'northwind-synthetic',
        subjectRef: 'wp061-subject-1',
        sequence: 2,
        payloadHash: 'b',
        synthetic: true,
      },
      {
        id: 'd1',
        tenantId: 'northwind-synthetic',
        subjectRef: 'wp061-subject-1',
        sequence: 1,
        payloadHash: 'a',
        synthetic: true,
      },
      {
        id: 'd1b',
        tenantId: 'northwind-synthetic',
        subjectRef: 'wp061-subject-1',
        sequence: 1,
        payloadHash: 'a',
        synthetic: true,
      },
    ]);
    expect(replayed.map((delta) => delta.sequence)).toEqual([1, 2]);
  });

  it('loads the northwind synthetic golden', () => {
    const golden = loadGolden('northwind-delta-v1');
    expect(golden.tenantId).toBe('northwind-synthetic');
    expect(golden.synthetic).toBe(true);
  });
});
