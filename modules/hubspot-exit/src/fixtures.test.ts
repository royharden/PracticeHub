import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { HubspotExitError, type ExitRecord } from './contracts.js';
import { runExit } from './export-orchestrator.js';

type FixtureClass = 'HAPPY' | 'BOUNDARY' | 'FAILURE' | 'RECOVERY';

interface FixturePack {
  readonly requirementId: 'WP-116/HUBSPOT-EXIT';
  readonly fixtureClass: FixtureClass;
  readonly synthetic: true;
  readonly windowHours: 24 | 30;
  readonly records: readonly ExitRecord[];
  readonly expectComplete: boolean;
}

const directory = dirname(fileURLToPath(import.meta.url));

function loadPack(fixtureClass: FixtureClass): FixturePack {
  const path = resolve(directory, `../fixtures/WP-116.${fixtureClass}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FixturePack>;
  if (
    raw.requirementId !== 'WP-116/HUBSPOT-EXIT' ||
    raw.fixtureClass !== fixtureClass ||
    raw.synthetic !== true
  ) {
    throw new Error(`INVALID_WP116_FIXTURE:${fixtureClass}`);
  }
  return raw as FixturePack;
}

describe('WP-116 fixtures', () => {
  for (const fixtureClass of ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const) {
    it(fixtureClass, () => {
      const pack = loadPack(fixtureClass);
      if (pack.expectComplete) {
        expect(runExit(pack.windowHours, pack.records).completeness.complete).toBe(true);
        return;
      }
      expect(() => runExit(pack.windowHours, pack.records)).toThrow(HubspotExitError);
    });
  }
});
