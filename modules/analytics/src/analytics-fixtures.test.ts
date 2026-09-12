import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  analyticsFixtureOperations,
  runAnalyticsFixtureCase,
  type AnalyticsFixtureFile,
} from './analytics-fixture-harness.js';

const fixtureRoot = fileURLToPath(new URL('../fixtures/', import.meta.url));
const fixtureNames = [
  'REQ-ANA-010.HAPPY.json',
  'REQ-ANA-010.BOUNDARY.json',
  'REQ-ANA-010.FAILURE.json',
  'REQ-ANA-010.RECOVERY.json',
  'ANALYTICS-PRIVACY.HAPPY.json',
  'ANALYTICS-PRIVACY.BOUNDARY.json',
  'ANALYTICS-PRIVACY.FAILURE.json',
  'ANALYTICS-PRIVACY.RECOVERY.json',
  'ANALYTICS-REBUILD.HAPPY.json',
  'ANALYTICS-REBUILD.BOUNDARY.json',
  'ANALYTICS-REBUILD.FAILURE.json',
  'ANALYTICS-REBUILD.RECOVERY.json',
] as const;

describe('analytics four-class fixtures', () => {
  for (const fixtureName of fixtureNames) {
    it(`${fixtureName} invokes analytics production code`, async () => {
      const fixture = JSON.parse(
        readFileSync(`${fixtureRoot}${fixtureName}`, 'utf8'),
      ) as AnalyticsFixtureFile;
      expect(fixture.synthetic).toBe(true);
      expect(fixture.cases.length).toBeGreaterThan(0);
      for (const fixtureCase of fixture.cases) {
        expect(analyticsFixtureOperations).toContain(fixtureCase.operation);
        await expect(runAnalyticsFixtureCase(fixtureCase)).resolves.toBe(fixtureCase.expected);
      }
    });
  }
});
