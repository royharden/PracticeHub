import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DayOneError, type SurfaceRecord } from './contracts.js';
import { assertComplete, evaluateRunbook } from './runbook.js';

type FixtureClass = 'HAPPY' | 'BOUNDARY' | 'FAILURE' | 'RECOVERY';

interface FixturePack {
  readonly requirementId: 'WP-118/DAY-ONE-BOOTSTRAP';
  readonly fixtureClass: FixtureClass;
  readonly synthetic: true;
  readonly records: readonly SurfaceRecord[];
  readonly expectComplete: boolean;
}

const directory = dirname(fileURLToPath(import.meta.url));

function loadPack(fixtureClass: FixtureClass): FixturePack {
  const path = resolve(directory, `../fixtures/WP-118.${fixtureClass}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FixturePack>;
  if (
    raw.requirementId !== 'WP-118/DAY-ONE-BOOTSTRAP' ||
    raw.fixtureClass !== fixtureClass ||
    raw.synthetic !== true
  ) {
    throw new Error(`INVALID_WP118_FIXTURE:${fixtureClass}`);
  }
  return raw as FixturePack;
}

describe('WP-118 fixtures', () => {
  for (const fixtureClass of ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const) {
    it(fixtureClass, () => {
      const pack = loadPack(fixtureClass);
      const result = evaluateRunbook(pack.records);
      if (pack.expectComplete) {
        expect(result.complete).toBe(true);
        assertComplete(result);
        return;
      }
      expect(result.complete).toBe(false);
      expect(() => assertComplete(result)).toThrow(DayOneError);
    });
  }
});
