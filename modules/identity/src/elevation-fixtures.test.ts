/**
 * Executable 4-class fixture packs for the WP-017 elevation slice: REQ-ID-001
 * (break-glass), REQ-ID-002 (credential anomaly), REQ-ID-025 (offboarding),
 * REQ-ID-028 (provider departure), REQ-ADM-017 (break-glass grant mechanism),
 * REQ-ADM-018 (periodic access review), REQ-ADM-019 (snooping investigation).
 * Every case runs against the real domain functions via the shared harness;
 * the accepted-op list validates at LOAD and the dispatcher throws on unknown
 * ops (review-009).
 */
import { fileURLToPath } from 'node:url';

import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import { acceptedOps, runFixtureCase, type ElevationFixture } from './elevation-fixture-harness.js';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));

for (const requirementId of [
  'REQ-ID-001',
  'REQ-ID-002',
  'REQ-ID-025',
  'REQ-ID-028',
  'REQ-ADM-017',
  'REQ-ADM-018',
  'REQ-ADM-019',
]) {
  describe(`${requirementId} fixture pack (4-class floor)`, () => {
    const pack = loadRequirementFixturePack(fixturesDirectory, requirementId);

    it('carries all four fixture classes with the synthetic watermark', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
    });

    it('every case declares a recognized op (load-time validation, review-009)', () => {
      for (const fixtureClass of requiredFixtureClasses) {
        const fixture = pack.fixtures[fixtureClass] as unknown as ElevationFixture;
        expect(fixture.cases.length).toBeGreaterThan(0);
        for (const fixtureCase of fixture.cases) {
          expect(
            (acceptedOps as readonly string[]).includes(fixtureCase.op),
            `${fixtureClass}: unknown op ${JSON.stringify(fixtureCase.op)}`,
          ).toBe(true);
        }
      }
    });

    for (const fixtureClass of requiredFixtureClasses) {
      describe(fixtureClass, () => {
        const fixture = pack.fixtures[fixtureClass] as unknown as ElevationFixture;
        for (const fixtureCase of fixture.cases) {
          it(fixtureCase.name, () => {
            runFixtureCase(fixtureCase);
          });
        }
      });
    }
  });
}
