import { expect, type Page } from '@playwright/test';

import {
  mountAccessibleShell,
  readAccessibleSemanticState,
} from '../../support/accessible-shell.js';
import { registerClosedApi } from './api-doubles.js';
import type { ContractFixture, JourneyContract } from './types.js';

export function createJourneyContract(
  definition: Pick<
    JourneyContract,
    | 'key'
    | 'id'
    | 'title'
    | 'endpoint'
    | 'actionKind'
    | 'localizedTitle'
    | 'localizedActionLabel'
    | 'createAction'
  >,
): JourneyContract {
  const contract: JourneyContract = {
    key: definition.key,
    id: definition.id,
    title: definition.title,
    endpoint: definition.endpoint,
    actionKind: definition.actionKind,
    localizedTitle: definition.localizedTitle,
    localizedActionLabel: definition.localizedActionLabel,
    createAction: definition.createAction,
    async mount(page: Page, fixture: ContractFixture): Promise<void> {
      await mountAccessibleShell(
        page,
        {
          contractId: definition.id,
          title: definition.localizedTitle[fixture.locale === 'es' ? 'es' : 'en'],
          actionLabel: definition.localizedActionLabel[fixture.locale === 'es' ? 'es' : 'en'],
          endpoint: definition.endpoint,
          action: definition.createAction(fixture.actionNote),
        },
        fixture,
      );
    },
    async registerApi(page: Page, fixture: ContractFixture): Promise<void> {
      await registerClosedApi(page, contract, fixture);
    },
    async runPrimaryJourney(
      page: Page,
      fixture: ContractFixture,
      onTransition?: () => Promise<void>,
    ) {
      await page.locator('#submit-action').click();
      if (fixture.apiOutcome === 'success') {
        await expect(page.locator('body')).toHaveAttribute('data-effect-count', '1');
        await onTransition?.();
      } else {
        await expect(page.locator('#error-summary')).toBeFocused();
        await expect(page.getByRole('status')).not.toBeEmpty();
        await onTransition?.();
        if (fixture.apiOutcome === 'recoverable') {
          await page.locator('#submit-action').click();
          await expect(page.locator('body')).toHaveAttribute('data-effect-count', '1');
          await onTransition?.();
        }
      }
      return readAccessibleSemanticState(page);
    },
    async readSemanticState(page: Page) {
      return readAccessibleSemanticState(page);
    },
  };
  return contract;
}
