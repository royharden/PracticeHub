import { expect, test } from '@playwright/test';

import { loadJourneyBindings } from './support/matrix.js';

const gates = loadJourneyBindings().parityGates;

test('provider parity inventory records four honest blocked obligations', () => {
  expect(gates).toHaveLength(4);
  for (const gate of gates) {
    expect(gate.status).toBe('blocked');
    expect(gate.wpId).toMatch(/^WP-\d{3}$/);
    expect(gate.reason.length).toBeGreaterThan(0);
  }
  expect(gates.map((gate) => gate.contractId)).toEqual([
    'wp030-accountable-message-page/v1',
    'wp031-paid-service-page/v1',
    'wp032-clinical-coexistence-page/v1',
    'portal-intake-accessibility/v1',
  ]);
});
