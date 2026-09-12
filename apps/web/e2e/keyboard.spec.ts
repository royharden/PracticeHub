import { expect, test, type Page } from '@playwright/test';

import { fixtureClasses } from './contracts/v1/index.js';
import { loadSynthCorpus } from './support/corpus.js';
import { contractFixture, loadFixturePacks } from './support/fixtures.js';
import { journeyPlans } from './support/journey-plan.js';

const packs = loadFixturePacks(loadSynthCorpus());

async function expectVisibleKeyboardFocus(page: Page): Promise<void> {
  const focus = await page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return { owner: '', visible: false };
    const style = getComputedStyle(active);
    return {
      owner: active.id || active.className || active.tagName.toLowerCase(),
      visible: style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth || '0') >= 2,
    };
  });
  expect(focus.owner).not.toBe('');
  expect(focus.visible).toBe(true);
}

for (const plan of journeyPlans) {
  for (const fixtureClass of fixtureClasses) {
    test('keyboard:' + plan.contract.key + ':' + fixtureClass, async ({ page }) => {
      const pack = packs.get(fixtureClass);
      if (!pack) throw new Error('missing fixture pack ' + fixtureClass);
      const fixture = contractFixture(pack, plan.contract.key);
      await plan.contract.registerApi(page, fixture);
      await plan.contract.mount(page, fixture);

      await page.keyboard.press('Tab');
      await expect(page.locator('.skip')).toBeFocused();
      await expectVisibleKeyboardFocus(page);
      await page.keyboard.press('Enter');
      await expect(page.locator('#main')).toBeFocused();
      await expectVisibleKeyboardFocus(page);

      await page.keyboard.press('Shift+Tab');
      await expect(page.locator('#open-help')).toBeFocused();
      await page.keyboard.press('Space');
      await expect(page.locator('#close-help')).toBeFocused();
      await expectVisibleKeyboardFocus(page);
      await page.keyboard.press('Escape');
      await expect(page.locator('#open-help')).toBeFocused();

      await page.keyboard.press('Tab');
      await expect(page.locator('#action-note')).toBeFocused();
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Tab');
      await expect(page.locator('#submit-action')).toBeFocused();
      await page.keyboard.press('Space');
      await expect(page.locator('#error-summary')).toBeFocused();
      await expect(page.getByRole('status')).not.toBeEmpty();
      await expectVisibleKeyboardFocus(page);

      await page.keyboard.press('Tab');
      await expect(page.locator('#error-summary a')).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('#action-note')).toBeFocused();
      await page.keyboard.type(fixture.actionNote);
      await page.keyboard.press('Tab');
      await expect(page.locator('#submit-action')).toBeFocused();
      await page.keyboard.press('Enter');

      if (fixture.apiOutcome === 'success') {
        await expect(page.locator('body')).toHaveAttribute('data-effect-count', '1');
        await expect(page.locator('#submit-action')).toBeFocused();
        await expectVisibleKeyboardFocus(page);
      } else {
        await expect(page.locator('#error-summary')).toBeFocused();
        await expect(page.locator('#action-note')).toHaveValue(fixture.actionNote);
        if (fixture.apiOutcome === 'recoverable') {
          await page.keyboard.press('Tab');
          await page.keyboard.press('Tab');
          await expect(page.locator('#action-note')).toBeFocused();
          await expect(page.locator('#action-note')).toHaveValue(fixture.actionNote);
          await page.keyboard.press('Tab');
          await expect(page.locator('#submit-action')).toBeFocused();
          await page.keyboard.press('Enter');
          await expect(page.locator('body')).toHaveAttribute('data-effect-count', '1');
          await expect(page.locator('#submit-action')).toBeFocused();
          await expectVisibleKeyboardFocus(page);
        }
      }
    });
  }
}
