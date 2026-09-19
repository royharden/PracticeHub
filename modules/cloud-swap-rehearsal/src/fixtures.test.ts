import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CloudSwapError, type Profile } from './contracts.js';
import { runSuite, swapConfigOnly } from './profiles.js';

type FixtureClass = 'HAPPY' | 'BOUNDARY' | 'FAILURE' | 'RECOVERY';

interface FixturePack {
  readonly requirementId: 'WP-125/CLOUD-SWAP';
  readonly fixtureClass: FixtureClass;
  readonly synthetic: true;
  readonly from: Profile;
  readonly to: Profile;
  readonly expectPass: boolean;
}

const directory = dirname(fileURLToPath(import.meta.url));

function loadPack(fixtureClass: FixtureClass): FixturePack {
  const path = resolve(directory, `../fixtures/WP-125.${fixtureClass}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FixturePack>;
  if (
    raw.requirementId !== 'WP-125/CLOUD-SWAP' ||
    raw.fixtureClass !== fixtureClass ||
    raw.synthetic !== true
  ) {
    throw new Error(`INVALID_WP125_FIXTURE:${fixtureClass}`);
  }
  return raw as FixturePack;
}

describe('WP-125 fixtures', () => {
  for (const fixtureClass of ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const) {
    it(fixtureClass, () => {
      const pack = loadPack(fixtureClass);
      if (pack.expectPass) {
        const swapped = swapConfigOnly(pack.from, pack.to);
        expect(runSuite(swapped).passed).toBe(true);
        return;
      }
      expect(() => swapConfigOnly(pack.from, pack.to)).toThrow(CloudSwapError);
    });
  }
});
