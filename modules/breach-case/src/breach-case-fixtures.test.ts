import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  breachFixtureOps,
  executeBreachFixtureCase,
  type BreachFixtureFile,
} from './fixture-harness.js';

const moduleRoot = fileURLToPath(new URL('..', import.meta.url));
const files = [
  'R6-REQ-006.HAPPY.json',
  'R6-REQ-006.BOUNDARY.json',
  'R6-REQ-006.FAILURE.json',
  'R6-REQ-006.RECOVERY.json',
  'R6-SR-033.HAPPY.json',
  'R6-SR-033.BOUNDARY.json',
  'R6-SR-033.FAILURE.json',
  'R6-SR-033.RECOVERY.json',
] as const;

describe('WP-098 four-class executable fixtures', () => {
  for (const file of files) {
    it(file, () => {
      const fixture = JSON.parse(
        readFileSync(`${moduleRoot}fixtures/${file}`, 'utf8'),
      ) as BreachFixtureFile;
      expect(fixture.synthetic).toBe(true);
      expect(`${fixture.requirementId}.${fixture.class}.json`).toBe(file);
      expect(fixture.cases.length).toBeGreaterThan(0);
      for (const fixtureCase of fixture.cases) {
        expect(breachFixtureOps).toContain(fixtureCase.op);
        executeBreachFixtureCase(fixtureCase);
      }
    });
  }
});
