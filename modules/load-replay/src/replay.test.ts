import { describe, expect, it } from 'vitest';

import { RecordingDrillRegistry } from './doubles.js';
import {
  flushOutageBacklog,
  generateLoad,
  loadMultiple,
  outageEquivalentHours,
  replayTwice,
  runHarness,
  skipRun,
  stressTable,
} from './replay.js';
import { LoadReplayRefusal, stressContracts } from './types.js';

describe('WP-122 2x load/replay harness', () => {
  it('replays twice at 2x synthetic load', () => {
    const events = generateLoad('consent-ledger', 4);
    expect(events).toHaveLength(4 * loadMultiple);
    const replayed = replayTwice(events);
    expect(replayed.second).toEqual(replayed.first);
  });

  it('flushes a 72h-equivalent backlog with no loss and drops duplicates', () => {
    expect(outageEquivalentHours).toBe(72);
    const events = generateLoad('sla-engine', 3);
    const proof = flushOutageBacklog([...events, ...events]);
    expect(proof.lost).toBe(0);
    expect(proof.applied).toHaveLength(events.length);
    expect(proof.duplicatesDropped).toBe(events.length);
  });

  it('records 2x stress green for every named contract', () => {
    const table = stressTable(2);
    expect(stressContracts).toContain('possible-match-search-p95');
    for (const contract of stressContracts) {
      expect(table[contract].green).toBe(true);
      expect(table[contract].load).toBe(4);
    }
    expect(table['possible-match-search-p95'].green).toBe(true);
  });

  it('records drill outcomes on the WP-120 double and refuses skipped runs', () => {
    const registry = new RecordingDrillRegistry();
    runHarness(registry, 2);
    expect(registry.outcomes).toHaveLength(3);
    expect(registry.outcomes.every((row) => row.outcome === 'green')).toBe(true);
    expect(() => skipRun()).toThrow(LoadReplayRefusal);
  });
});
