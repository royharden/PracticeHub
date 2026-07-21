/**
 * Executable 4-class fixture packs for the WP-015 authority slice:
 * REQ-ID-006 (minor proxy scope), REQ-ID-007 (majority transition),
 * REQ-ID-008 (granular caregiver access), REQ-ID-010 (court-order
 * replacement), REQ-ID-011 (custody conflict), REQ-ID-012 (temporary
 * authority expiry), REQ-ID-013 (emancipation), REQ-ID-014 (incapacity),
 * REQ-ID-016 (financial-responsibility change). Same harness + review-009
 * discipline as the PDP packs.
 */
import { fileURLToPath } from 'node:url';

import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import { acceptedOps, runFixtureCase, type PdpFixture } from './pdp-fixture-harness.js';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));

for (const requirementId of [
  'REQ-ID-006',
  'REQ-ID-007',
  'REQ-ID-008',
  'REQ-ID-010',
  'REQ-ID-011',
  'REQ-ID-012',
  'REQ-ID-013',
  'REQ-ID-014',
  'REQ-ID-016',
]) {
  describe(`${requirementId} fixture pack (4-class floor)`, () => {
    const pack = loadRequirementFixturePack(fixturesDirectory, requirementId);

    it('carries all four fixture classes with the synthetic watermark', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
    });

    it('every case declares a recognized op (load-time validation, review-009)', () => {
      for (const fixtureClass of requiredFixtureClasses) {
        const fixture = pack.fixtures[fixtureClass] as unknown as PdpFixture;
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
        const fixture = pack.fixtures[fixtureClass] as unknown as PdpFixture;
        for (const fixtureCase of fixture.cases) {
          it(fixtureCase.name, () => {
            runFixtureCase(fixtureCase);
          });
        }
      });
    }
  });
}
