import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { type AuthSession, type RehearsalKind } from './contracts.js';
import { rehearse } from './rehearsals.js';

type FixtureClass = 'HAPPY' | 'BOUNDARY' | 'FAILURE' | 'RECOVERY';

interface FixturePack {
  readonly requirementId: 'WP-136/REQ-AUTH';
  readonly fixtureClass: FixtureClass;
  readonly synthetic: true;
  readonly kind: RehearsalKind;
  readonly session: AuthSession;
  readonly expectAllowed: boolean;
}

const directory = dirname(fileURLToPath(import.meta.url));

function loadPack(fixtureClass: FixtureClass): FixturePack {
  const path = resolve(directory, `../fixtures/WP-136.${fixtureClass}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FixturePack>;
  if (raw.requirementId !== 'WP-136/REQ-AUTH' || raw.fixtureClass !== fixtureClass || raw.synthetic !== true) {
    throw new Error(`INVALID_WP136_FIXTURE:${fixtureClass}`);
  }
  return raw as FixturePack;
}

describe('WP-136 fixtures', () => {
  for (const fixtureClass of ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const) {
    it(fixtureClass, () => {
      const pack = loadPack(fixtureClass);
      expect(rehearse(pack.kind, pack.session).allowed).toBe(pack.expectAllowed);
    });
  }
});
