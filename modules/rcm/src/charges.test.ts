import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WP062_PACKAGE_ID, type Wp062EncounterCharge } from './contracts.js';
import { reconcileCharges } from './charges.js';
import { parseWp062Fixture } from './placeholder.js';

const directory = dirname(fileURLToPath(import.meta.url));

function loadExpected(): readonly Wp062EncounterCharge[] {
  const raw: unknown = JSON.parse(
    readFileSync(resolve(directory, '../fixtures/wp-062-charges.json'), 'utf8'),
  );
  const fixture = parseWp062Fixture(raw);
  expect(fixture.packageId).toBe(WP062_PACKAGE_ID);
  return fixture.expected;
}

describe('WP-083 charge reconciliation', () => {
  it('detects a missing charge and does not post it', () => {
    const expected = loadExpected();
    const missing = expected.find((charge) => charge.chargeId === 'chg-missing');
    const captured = expected.filter((charge) => charge.chargeId !== 'chg-missing');
    const result = reconcileCharges(expected, captured, 'run-missing', '2026-09-25T12:00:00Z');
    expect(result.missing.map((charge) => charge.chargeId)).toEqual(['chg-missing']);
    expect(result.posted.map((charge) => charge.chargeId)).not.toContain('chg-missing');
    expect(missing).toBeDefined();
    expect(result.heartbeat).toEqual({
      runId: 'run-missing',
      at: '2026-09-25T12:00:00Z',
      missingCount: 1,
      duplicateCount: 0,
      postedCount: 2,
    });
  });

  it('detects a duplicate charge and posts it once', () => {
    const expected = loadExpected();
    const duplicate = expected.find((charge) => charge.chargeId === 'chg-dup');
    if (!duplicate) {
      throw new Error('WP-062 fixture has no duplicate charge');
    }
    const captured = [...expected, duplicate];
    const result = reconcileCharges(expected, captured, 'run-duplicate', '2026-09-25T12:05:00Z');
    expect(result.duplicates.map((charge) => charge.chargeId)).toEqual(['chg-dup']);
    expect(result.posted.filter((charge) => charge.chargeId === 'chg-dup')).toHaveLength(1);
    expect(result.heartbeat.runId).toBe('run-duplicate');
    expect(result.heartbeat.duplicateCount).toBe(1);
    expect(result.heartbeat.postedCount).toBe(expected.length);
  });
});
