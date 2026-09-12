import { fileURLToPath } from 'node:url';

import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import {
  fixtureOps,
  runIntakeFixtureCase,
  type IntakeFixtureCase,
} from './intake-fixture-harness.js';

const directory = fileURLToPath(new URL('../fixtures', import.meta.url));

for (const requirementId of ['REQ-PORT-004', 'REQ-PORT-010']) {
  describe(`${requirementId} fixture pack`, () => {
    const pack = loadRequirementFixturePack(directory, requirementId);
    it('carries the complete four-class floor and a closed operation vocabulary', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
      for (const fixtureClass of requiredFixtureClasses) {
        const fixture = pack.fixtures[fixtureClass] as { cases: readonly IntakeFixtureCase[] };
        expect(fixture.cases.length).toBeGreaterThan(0);
        for (const fixtureCase of fixture.cases) expect(fixtureOps).toContain(fixtureCase.op);
      }
    });
    for (const fixtureClass of requiredFixtureClasses) {
      const fixture = pack.fixtures[fixtureClass] as { cases: readonly IntakeFixtureCase[] };
      for (const fixtureCase of fixture.cases) {
        it(`${fixtureClass}: ${fixtureCase.name}`, async () => runIntakeFixtureCase(fixtureCase));
      }
    }
  });
}
