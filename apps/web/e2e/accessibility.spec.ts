import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { fixtureClasses } from './contracts/v1/index.js';
import { loadSynthCorpus } from './support/corpus.js';
import { contractFixture, loadFixturePacks } from './support/fixtures.js';
import { journeyPlans } from './support/journey-plan.js';

const packs = loadFixturePacks(loadSynthCorpus());
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectAxeBaseline(page: Page): Promise<void> {
  const enabled = await new AxeBuilder({ page }).withTags(wcagTags).analyze();
  expect(enabled.violations).toEqual([]);
  const allRules = await new AxeBuilder({ page }).analyze();
  expect(
    allRules.violations.filter(
      (violation) => violation.impact === 'serious' || violation.impact === 'critical',
    ),
  ).toEqual([]);
}

for (const plan of journeyPlans) {
  for (const fixtureClass of fixtureClasses) {
    test('axe:' + plan.contract.key + ':' + fixtureClass, async ({ page }) => {
      const pack = packs.get(fixtureClass);
      if (!pack) throw new Error('missing fixture pack ' + fixtureClass);
      const fixture = contractFixture(pack, plan.contract.key);
      if (fixtureClass === 'BOUNDARY') await page.setViewportSize({ width: 320, height: 640 });
      await plan.contract.registerApi(page, fixture);
      await plan.contract.mount(page, fixture);
      await expectAxeBaseline(page);

      await page.locator('#open-help').click();
      await expectAxeBaseline(page);
      await page.locator('#close-help').click();
      await expect(page.locator('#help-dialog')).toHaveJSProperty('open', false);

      await page.locator('#action-note').fill('');
      await expect(page.locator('#action-note')).toHaveValue('');
      await page.locator('#submit-action').click();
      await expect(page.locator('#error-summary')).toBeFocused();
      await expectAxeBaseline(page);
      await page.locator('#action-note').fill(fixture.actionNote);

      await plan.contract.runPrimaryJourney(page, fixture, async () => expectAxeBaseline(page));
      if (fixtureClass === 'BOUNDARY') {
        const overflowingElements = await page.locator('body *').evaluateAll((elements) =>
          elements
            .filter((element) => {
              const box = element.getBoundingClientRect();
              return box.left < 0 || box.right > document.documentElement.clientWidth;
            })
            .map((element) => {
              const node = element as HTMLElement;
              return node.id || node.className || node.tagName.toLowerCase();
            }),
        );
        expect(overflowingElements).toEqual([]);
        const controlsOverlap = await page.evaluate(() => {
          const note = document.querySelector('#action-note')?.getBoundingClientRect();
          const submit = document.querySelector('#submit-action')?.getBoundingClientRect();
          const status = document.querySelector('#status')?.getBoundingClientRect();
          if (!note || !submit || !status) return true;
          return note.bottom > submit.top || submit.bottom > status.top;
        });
        expect(controlsOverlap).toBe(false);
        expect(await page.locator('body').evaluate((body) => getComputedStyle(body).fontSize)).toBe(
          '32px',
        );
      }
    });
  }
}
