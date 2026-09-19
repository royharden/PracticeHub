import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { type RehearsalKind, type ScheduleSnapshot, type WaitlistEntry } from './contracts.js';
import { assertNoLateMutation, rehearse } from './rehearsals.js';

type FixtureClass = 'HAPPY' | 'BOUNDARY' | 'FAILURE' | 'RECOVERY';

interface FixturePack {
  readonly requirementId: 'WP-133/REQ-WL';
  readonly fixtureClass: FixtureClass;
  readonly synthetic: true;
  readonly kind: RehearsalKind;
  readonly entry: WaitlistEntry;
  readonly schedule: ScheduleSnapshot;
  readonly expectOk: boolean;
}

const directory = dirname(fileURLToPath(import.meta.url));

function loadPack(fixtureClass: FixtureClass): FixturePack {
  const path = resolve(directory, `../fixtures/WP-133.${fixtureClass}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FixturePack>;
  if (
    raw.requirementId !== 'WP-133/REQ-WL' ||
    raw.fixtureClass !== fixtureClass ||
    raw.synthetic !== true
  ) {
    throw new Error(`INVALID_WP133_FIXTURE:${fixtureClass}`);
  }
  return raw as FixturePack;
}

describe('WP-133 fixtures', () => {
  for (const fixtureClass of ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const) {
    it(fixtureClass, () => {
      const pack = loadPack(fixtureClass);
      const result = rehearse(pack.kind, pack.entry, pack.schedule);
      expect(result.ok).toBe(pack.expectOk);
      if (pack.kind === 'late-accept') {
        assertNoLateMutation(result);
      }
    });
  }
});
