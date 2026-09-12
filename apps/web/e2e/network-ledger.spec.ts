import { expect, test, type Page } from '@playwright/test';

import type { ContractFixture, JourneyContract } from './contracts/v1/index.js';
import { loadSynthCorpus } from './support/corpus.js';
import { contractFixture, loadFixturePacks } from './support/fixtures.js';
import { journeyPlans } from './support/journey-plan.js';

const packs = loadFixturePacks(loadSynthCorpus());

function requestBody(
  contract: JourneyContract,
  fixture: ContractFixture,
  note = fixture.actionNote,
): Readonly<Record<string, unknown>> {
  return {
    contractId: contract.id,
    operationKey: fixture.operationKey,
    reference: fixture.reference,
    action: contract.createAction(note),
  };
}

async function post(
  page: Page,
  url: string,
  body: Readonly<Record<string, unknown>>,
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  return page.evaluate(
    async ({ target, payload }) => {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return {
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      };
    },
    { target: url, payload: body },
  );
}

test('default-deny fence aborts unknown origin, path, and method without external traffic', async ({
  page,
}) => {
  const plan = journeyPlans[0];
  const pack = packs.get('HAPPY');
  if (!plan || !pack) throw new Error('missing WP-030 happy plan');
  const fixture = contractFixture(pack, plan.contract.key);
  await plan.contract.registerApi(page, fixture);

  for (const target of [
    'https://outside.invalid/never-contacted',
    'https://wp035.invalid/api/v1/unregistered',
  ]) {
    const result = await page.evaluate(async (url) => {
      try {
        await fetch(url);
        return 'unexpected-success';
      } catch {
        return 'blocked';
      }
    }, target);
    expect(result).toBe('blocked');
  }
  const wrongMethod = await page.evaluate(async (url) => {
    try {
      await fetch(url, { method: 'GET' });
      return 'unexpected-success';
    } catch {
      return 'blocked';
    }
  }, plan.contract.endpoint);
  expect(wrongMethod).toBe('blocked');
});

for (const plan of journeyPlans) {
  test('closed schema and idempotent ledger:' + plan.contract.key, async ({ page }) => {
    const pack = packs.get('HAPPY');
    if (!pack) throw new Error('missing happy fixture');
    const fixture = contractFixture(pack, plan.contract.key);
    await plan.contract.registerApi(page, fixture);

    const wrongSubject = {
      ...requestBody(plan.contract, fixture),
      reference: { ...fixture.reference, subjectId: 'sg-p-unknown' },
    };
    expect((await post(page, plan.contract.endpoint, wrongSubject)).status).toBe(400);
    const wrongAction = {
      ...requestBody(plan.contract, fixture),
      action: { kind: 'wrong-domain-action', note: fixture.actionNote },
    };
    expect((await post(page, plan.contract.endpoint, wrongAction)).status).toBe(400);
    const extraTopLevel = {
      ...requestBody(plan.contract, fixture),
      unexpected: true,
    };
    const extraReference = {
      ...requestBody(plan.contract, fixture),
      reference: { ...fixture.reference, unexpected: true },
    };
    const extraAction = {
      ...requestBody(plan.contract, fixture),
      action: { ...plan.contract.createAction(fixture.actionNote), unexpected: true },
    };
    for (const invalid of [
      extraTopLevel,
      extraReference,
      extraAction,
      requestBody(plan.contract, fixture, ''),
      requestBody(plan.contract, fixture, '   '),
      requestBody(plan.contract, fixture, 'x'.repeat(501)),
    ]) {
      const refusal = await post(page, plan.contract.endpoint, invalid);
      expect(refusal.status).toBe(400);
      expect(refusal.body['effectCount']).toBe(0);
    }

    const first = await post(page, plan.contract.endpoint, requestBody(plan.contract, fixture));
    expect(first.status).toBe(200);
    expect(first.body['effectCount']).toBe(1);
    expect(first.body['replay']).toBe(false);

    const replay = await post(page, plan.contract.endpoint, requestBody(plan.contract, fixture));
    expect(replay.status).toBe(200);
    expect(replay.body['effectCount']).toBe(1);
    expect(replay.body['replay']).toBe(true);

    const conflict = await post(
      page,
      plan.contract.endpoint,
      requestBody(plan.contract, fixture, fixture.actionNote + ' changed'),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body['effectCount']).toBe(1);
    expect(conflict.body['conflict']).toBe(true);
  });
}

test('ambiguous landed effect replays safely and unknown recovery key is rejected', async ({
  page,
}) => {
  const plan = journeyPlans[0];
  const pack = packs.get('RECOVERY');
  if (!plan || !pack) throw new Error('missing WP-030 recovery plan');
  const fixture = contractFixture(pack, plan.contract.key);
  await plan.contract.registerApi(page, fixture);

  const landed = await post(page, plan.contract.endpoint, requestBody(plan.contract, fixture));
  expect(landed.status).toBe(503);
  expect(landed.body['landed']).toBe(true);
  expect(landed.body['effectCount']).toBe(1);

  const replay = await post(page, plan.contract.endpoint, requestBody(plan.contract, fixture));
  expect(replay.status).toBe(200);
  expect(replay.body['replay']).toBe(true);
  expect(replay.body['effectCount']).toBe(1);

  const unknown = {
    ...requestBody(plan.contract, fixture),
    operationKey: 'wp030-unknown-recovery',
  };
  expect((await post(page, plan.contract.endpoint, unknown)).status).toBe(400);
});
