import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

import { expect, test } from '@playwright/test';

import {
  evaluateParityAcceptance,
  requiredParityContracts,
} from './provider-parity-acceptance.mjs';

test('fabricated ready metadata cannot satisfy executable provider parity', async () => {
  const bindings = JSON.parse(
    readFileSync(new URL('./journey-bindings.v1.json', import.meta.url), 'utf8'),
  );
  bindings.parityGates = bindings.parityGates.map((gate) => ({
    ...gate,
    status: 'ready',
    normalizedParity: 'passed',
  }));
  const result = await evaluateParityAcceptance(bindings);
  expect(result.accepted).toBe(false);
  expect(result.evidence).toEqual([]);
  expect(result.blocked).toEqual(requiredParityContracts);
});
