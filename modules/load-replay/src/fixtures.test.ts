import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RecordingDrillRegistry } from './doubles.js';
import { flushOutageBacklog, generateLoad, runHarness, skipRun } from './replay.js';
import { LoadReplayRefusal } from './types.js';

const fixtureDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));
const requiredClasses = ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const;

interface FixtureCase {
  readonly name: string;
  readonly op: 'harness-green' | 'zero-baseline' | 'skip' | 'duplicate-flush';
}

function load(fixtureClass: string): {
  readonly class: string;
  readonly cases: readonly FixtureCase[];
} {
  return JSON.parse(readFileSync(`${fixtureDirectory}/WP-122.${fixtureClass}.json`, 'utf8')) as {
    readonly class: string;
    readonly cases: readonly FixtureCase[];
  };
}

describe('WP-122 four-class fixtures', () => {
  it.each(requiredClasses)('executes %s cases', (fixtureClass) => {
    const fixture = load(fixtureClass);
    expect(fixture.class).toBe(fixtureClass);
    for (const fixtureCase of fixture.cases) {
      if (fixtureCase.op === 'harness-green') {
        const table = runHarness(new RecordingDrillRegistry(), 2);
        expect(table['mpi-merge-queues'].green).toBe(true);
        continue;
      }
      if (fixtureCase.op === 'zero-baseline') {
        expect(() => generateLoad('entitlement-ledger', 0)).toThrow(LoadReplayRefusal);
        continue;
      }
      if (fixtureCase.op === 'skip') {
        expect(() => skipRun()).toThrow(LoadReplayRefusal);
        continue;
      }
      if (fixtureCase.op === 'duplicate-flush') {
        const events = generateLoad('consent-ledger', 2);
        const extra = events[0];
        if (extra === undefined) {
          throw new Error('expected a generated event');
        }
        const proof = flushOutageBacklog([...events, extra]);
        expect(proof.lost).toBe(0);
        expect(proof.duplicatesDropped).toBe(1);
        continue;
      }
      throw new Error(`unknown fixture op ${(fixtureCase as FixtureCase).op}`);
    }
  });
});
