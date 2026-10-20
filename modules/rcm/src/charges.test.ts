import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WP062_PACKAGE_ID, type Wp062EncounterCharge } from './contracts.js';
import {
  chargeReconciliationHeartbeats,
  InMemoryReconciliationHeartbeats,
  reconcileCharges,
} from './charges.js';
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

const charge = (
  tenantId: string,
  encounterId: string,
  chargeId: string,
  amountMinor: number,
): Wp062EncounterCharge => ({
  packageId: WP062_PACKAGE_ID,
  tenantId,
  encounterId,
  chargeId,
  amountMinor,
  currency: 'USD',
});

describe('WP-083 charge reconciliation', () => {
  it('detects a missing charge and does not post it', () => {
    const expected = loadExpected();
    const missing = expected.find((item) => item.chargeId === 'chg-missing');
    const captured = expected.filter((item) => item.chargeId !== 'chg-missing');
    const result = reconcileCharges(expected, captured, 'run-missing', '2026-09-25T12:00:00Z');
    expect(result.missing.map((item) => item.chargeId)).toEqual(['chg-missing']);
    expect(result.posted.map((item) => item.chargeId)).not.toContain('chg-missing');
    expect(missing).toBeDefined();
    expect(result.heartbeat).toEqual({
      runId: 'run-missing',
      at: '2026-09-25T12:00:00Z',
      missingCount: 1,
      duplicateCount: 0,
      postedCount: 2,
      conflictCount: 0,
      amountMismatchCount: 0,
      unexpectedCount: 0,
    });
  });

  it('detects a duplicate charge and posts it once', () => {
    const expected = loadExpected();
    const duplicate = expected.find((item) => item.chargeId === 'chg-dup');
    if (!duplicate) {
      throw new Error('WP-062 fixture has no duplicate charge');
    }
    const captured = [...expected, duplicate];
    const result = reconcileCharges(expected, captured, 'run-duplicate', '2026-09-25T12:05:00Z');
    expect(result.duplicates.map((item) => item.chargeId)).toEqual(['chg-dup']);
    expect(result.posted.filter((item) => item.chargeId === 'chg-dup')).toHaveLength(1);
    expect(result.heartbeat.runId).toBe('run-duplicate');
    expect(result.heartbeat.duplicateCount).toBe(1);
    expect(result.heartbeat.postedCount).toBe(expected.length);
  });
});

describe('WP-083 rework 1: tenant- and encounter-scoped keys (review finding high)', () => {
  const tenantA = charge('tenant-a-synthetic', 'enc-a-1', 'chg-1', 1500);
  const tenantB = charge('tenant-b-synthetic', 'enc-b-1', 'chg-1', 1500);

  it("does not let tenant B's chg-1 mask tenant A's missing chg-1", () => {
    const result = reconcileCharges(
      [tenantA],
      [tenantB],
      'run-two-tenant-mask',
      '2026-09-25T13:00:00Z',
    );
    expect(result.missing).toEqual([tenantA]);
    expect(result.posted).toEqual([]);
    expect(result.unexpected).toEqual([tenantB]);
  });

  it("does not suppress tenant B's own chg-1 as a duplicate of tenant A's", () => {
    const result = reconcileCharges(
      [tenantA, tenantB],
      [tenantA, tenantB],
      'run-two-tenant-suppress',
      '2026-09-25T13:05:00Z',
    );
    expect(result.duplicates).toEqual([]);
    expect(result.posted).toEqual([tenantA, tenantB]);
    expect(result.missing).toEqual([]);
  });

  it('keeps the same chargeId on two encounters of one tenant apart', () => {
    const second = charge('tenant-a-synthetic', 'enc-a-2', 'chg-1', 900);
    const result = reconcileCharges(
      [tenantA, second],
      [second],
      'run-two-encounters',
      '2026-09-25T13:10:00Z',
    );
    expect(result.missing).toEqual([tenantA]);
    expect(result.posted).toEqual([second]);
  });
});

describe('WP-083 rework 1: amounts are compared, not discarded (review finding medium)', () => {
  const expected = charge('tenant-a-synthetic', 'enc-a-1', 'chg-1', 1500);

  it('surfaces a same-key, different-amount capture as a conflict and posts neither copy', () => {
    const corrected = { ...expected, amountMinor: 1800 };
    const result = reconcileCharges(
      [expected],
      [expected, corrected],
      'run-conflict',
      '2026-09-25T14:00:00Z',
    );
    expect(result.conflicts).toEqual([expected, corrected]);
    expect(result.posted).toEqual([]);
    expect(result.duplicates).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.heartbeat.conflictCount).toBe(2);
  });

  it('holds a captured amount that differs from the expected amount', () => {
    const captured = { ...expected, amountMinor: 1400 };
    const result = reconcileCharges(
      [expected],
      [captured],
      'run-amount-mismatch',
      '2026-09-25T14:05:00Z',
    );
    expect(result.amountMismatches).toEqual([{ expected, captured }]);
    expect(result.posted).toEqual([]);
    expect(result.heartbeat.amountMismatchCount).toBe(1);
  });

  it('reports a captured charge with no expected line instead of posting it silently', () => {
    const stray = charge('tenant-a-synthetic', 'enc-a-9', 'chg-9', 700);
    const result = reconcileCharges(
      [expected],
      [expected, stray],
      'run-unexpected',
      '2026-09-25T14:10:00Z',
    );
    expect(result.unexpected).toEqual([stray]);
    expect(result.posted).toEqual([expected]);
    expect(result.heartbeat.unexpectedCount).toBe(1);
  });

  it('refuses an expected set that repeats a key with different amounts', () => {
    expect(() =>
      reconcileCharges(
        [expected, { ...expected, amountMinor: 1 }],
        [],
        'run-bad-expected',
        '2026-09-25T14:15:00Z',
      ),
    ).toThrow('expected charges repeat a key with different amounts');
  });
});

describe('WP-083 hardening H-03 (NR-117)', () => {
  it('the default sink keeps the same run id apart across tenants', () => {
    const a = charge('tenant-h03-a', 'enc-1', 'chg-1', 100);
    const b = charge('tenant-h03-b', 'enc-1', 'chg-1', 100);
    const first = reconcileCharges([a], [a], 'run-h03-shared', '2026-09-25T16:00:00Z');
    const second = reconcileCharges([b], [], 'run-h03-shared', '2026-09-25T16:00:00Z');
    expect(second.missing).toEqual([b]);
    expect(chargeReconciliationHeartbeats.forRun('run-h03-shared', 'tenant-h03-a')).toEqual(
      first.heartbeat,
    );
    expect(chargeReconciliationHeartbeats.forRun('run-h03-shared', 'tenant-h03-b')).toEqual(
      second.heartbeat,
    );
  });

  it('refuses a divergent replay before doing any reconciliation work', () => {
    const sink = new InMemoryReconciliationHeartbeats();
    const good = charge('tenant-h03-c', 'enc-1', 'chg-1', 100);
    reconcileCharges([good], [good], 'run-h03-early', '2026-09-25T16:05:00Z', sink);
    const invalid = { ...good, chargeId: 'chg-2', amountMinor: -1 };
    // Before the fix this reached charge validation (WP062_CHARGE); now the replay check refuses first.
    expect(() =>
      reconcileCharges([good], [good, invalid], 'run-h03-early', '2026-09-25T16:05:00Z', sink),
    ).toThrow(expect.objectContaining({ code: 'CHARGE_RUN' }));
    expect(sink.all()).toHaveLength(1);
  });
});

describe('WP-083 rework 1: every run records its heartbeat (review finding low)', () => {
  it('records one heartbeat per run in the module-owned sink', () => {
    const before = chargeReconciliationHeartbeats.all().length;
    const result = reconcileCharges(
      loadExpected(),
      loadExpected(),
      'run-heartbeat-default',
      '2026-09-25T15:00:00Z',
    );
    expect(chargeReconciliationHeartbeats.all()).toHaveLength(before + 1);
    expect(chargeReconciliationHeartbeats.forRun('run-heartbeat-default')).toEqual(
      result.heartbeat,
    );
  });

  it('records into a supplied sink, once per run, and refuses a divergent replay', () => {
    const sink = new InMemoryReconciliationHeartbeats();
    const expected = loadExpected();
    reconcileCharges(expected, expected, 'run-sink', '2026-09-25T15:05:00Z', sink);
    reconcileCharges(expected, expected, 'run-sink', '2026-09-25T15:05:00Z', sink);
    expect(sink.all()).toHaveLength(1);
    expect(() => reconcileCharges(expected, [], 'run-sink', '2026-09-25T15:05:00Z', sink)).toThrow(
      'already recorded a different heartbeat',
    );
  });
});
