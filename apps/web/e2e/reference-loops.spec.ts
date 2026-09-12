import { expect, test } from '@playwright/test';

import { fixtureClasses } from './contracts/v1/index.js';
import { loadSynthCorpus } from './support/corpus.js';
import { contractFixture, loadFixturePacks } from './support/fixtures.js';
import { journeyPlans } from './support/journey-plan.js';

const corpus = loadSynthCorpus();
const packs = loadFixturePacks(corpus);

for (const plan of journeyPlans) {
  for (const fixtureClass of fixtureClasses) {
    test(plan.testId + ':' + fixtureClass, async ({ page }) => {
      const pack = packs.get(fixtureClass);
      if (!pack) throw new Error('missing fixture pack ' + fixtureClass);
      const fixture = contractFixture(pack, plan.contract.key);
      await plan.contract.registerApi(page, fixture);
      await plan.contract.mount(page, fixture);
      const state = await plan.contract.runPrimaryJourney(page, fixture);

      expect(state.contractId).toBe(plan.contract.id);
      expect(state.heading).toBe(
        plan.contract.localizedTitle[fixture.locale === 'es' ? 'es' : 'en'],
      );
      expect(state.landmarks).toEqual(['header', 'nav', 'main', 'footer']);
      expect(state.namedControls.every((name) => name.length > 0)).toBe(true);
      expect(state.effectCount).toBe(fixture.expectedEffectCount);
      if (fixtureClass === 'FAILURE') {
        expect(state.error).toContain('Action not completed');
      } else {
        expect(state.status.length).toBeGreaterThan(0);
      }
    });
  }
}
