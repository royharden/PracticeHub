import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runCertPack } from './cert-pack.js';

type FixtureClass = 'HAPPY' | 'BOUNDARY' | 'FAILURE' | 'RECOVERY';

interface FixturePack {
  readonly requirementId: 'WP-103/VOICE-AGENT-CERT';
  readonly fixtureClass: FixtureClass;
  readonly synthetic: true;
  readonly sampleDown: boolean;
  readonly expectPass: boolean;
}

const directory = dirname(fileURLToPath(import.meta.url));

function loadPack(fixtureClass: FixtureClass): FixturePack {
  const path = resolve(directory, `../fixtures/WP-103.${fixtureClass}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FixturePack>;
  if (raw.requirementId !== 'WP-103/VOICE-AGENT-CERT' || raw.fixtureClass !== fixtureClass || raw.synthetic !== true) {
    throw new Error(`INVALID_WP103_FIXTURE:${fixtureClass}`);
  }
  return raw as FixturePack;
}

describe('WP-103 fixtures', () => {
  for (const fixtureClass of ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const) {
    it(fixtureClass, () => {
      const pack = loadPack(fixtureClass);
      const result = runCertPack({ sampleDown: pack.sampleDown });
      expect(result.allPassed).toBe(pack.expectPass);
    });
  }
});
