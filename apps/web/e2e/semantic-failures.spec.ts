import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import type { ContractFixture } from './contracts/v1/index.js';
import { loadSynthCorpus } from './support/corpus.js';
import { contractFixture, loadFixturePacks } from './support/fixtures.js';
import { journeyPlans } from './support/journey-plan.js';

const packs = loadFixturePacks(loadSynthCorpus());

test('validation failure focuses a linked correction and announces the error', async ({ page }) => {
  const plan = journeyPlans[0];
  const pack = packs.get('HAPPY');
  if (!plan || !pack) throw new Error('missing validation fixture');
  const fixture = contractFixture(pack, plan.contract.key);
  await plan.contract.registerApi(page, fixture);
  await plan.contract.mount(page, fixture);
  await page.locator('#action-note').fill('');
  await page.locator('#submit-action').click();
  await expect(page.locator('#error-summary')).toBeFocused();
  await expect(page.locator('#error-summary a')).toHaveAttribute('href', '#action-note');
  await expect(page.getByRole('status')).toContainText('required action note');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

for (const [key, phrase] of [
  ['wp030', 'authority'],
  ['wp031', 'consent'],
  ['wp032', 'accommodation'],
] as const) {
  test('semantic failure is explicit:' + key, async ({ page }) => {
    const plan = journeyPlans.find((candidate) => candidate.contract.key === key);
    const pack = packs.get('FAILURE');
    if (!plan || !pack) throw new Error('missing semantic failure fixture ' + key);
    const fixture = contractFixture(pack, key);
    await plan.contract.registerApi(page, fixture);
    await plan.contract.mount(page, fixture);
    await plan.contract.runPrimaryJourney(page, fixture);
    await expect(page.getByRole('status')).toContainText(phrase, { ignoreCase: true });
  });
}

test('missing certified translation routes to interpreter-assisted completion', async ({
  page,
}) => {
  const plan = journeyPlans[0];
  const pack = packs.get('BOUNDARY');
  if (!plan || !pack) throw new Error('missing translation fixture');
  const baseline = contractFixture(pack, plan.contract.key);
  const fixture: ContractFixture = {
    ...baseline,
    operationKey: 'wp030-translation-001',
    apiOutcome: 'failure',
    failureMode: 'translation',
    expectedEffectCount: 0,
  };
  await plan.contract.registerApi(page, fixture);
  await plan.contract.mount(page, fixture);
  await plan.contract.runPrimaryJourney(page, fixture);
  await expect(page.getByRole('status')).toContainText('intérprete');
  await expect(page.locator('#translation-notice')).toContainText('traducción certificada');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
