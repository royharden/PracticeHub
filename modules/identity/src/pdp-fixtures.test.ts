/**
 * Executable 4-class fixture packs for the WP-015 PDP slice: REQ-ID-018
 * (RBAC role definitions + least-privilege reviews), REQ-ID-019 (GIPA
 * partition), REQ-ID-021 (deceased chart lock half), REQ-ID-023 (guarantor
 * without clinical access), and R6-REQ-002 (RBAC minimum-necessary
 * deny-by-default). Every case runs against the real domain functions via
 * the shared harness; the accepted-op list validates at LOAD and the
 * dispatcher throws on unknown ops (review-009).
 */
import { fileURLToPath } from 'node:url';

import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import { acceptedOps, runFixtureCase, type PdpFixture } from './pdp-fixture-harness.js';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));

for (const requirementId of [
  'REQ-ID-018',
  'REQ-ID-019',
  'REQ-ID-021',
  'REQ-ID-023',
  'R6-REQ-002',
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
