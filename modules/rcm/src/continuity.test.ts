import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONTINUITY_GAP_THRESHOLD_DAYS,
  WP040_PACKAGE_ID,
  WP056_PACKAGE_ID,
  WP066_PACKAGE_ID,
  type Wp066MedicationSource,
} from './contracts.js';
import {
  acknowledgeContinuityAlert,
  escalateContinuity,
  honorInterimClauses,
  InMemoryContinuityEscalations,
  openContinuityAlert,
} from './continuity.js';
import { parseWp040Fixture, parseWp056Fixture, parseWp066Fixture } from './placeholder.js';

const directory = dirname(fileURLToPath(import.meta.url));

describe('WP-082 medication continuity', () => {
  it('escalates when the supply gap exceeds the package threshold', () => {
    const raw: unknown = JSON.parse(
      readFileSync(resolve(directory, '../fixtures/wp-066-medication.json'), 'utf8'),
    );
    const fixture = parseWp066Fixture(raw);
    expect(fixture.packageId).toBe(WP066_PACKAGE_ID);
    const source = fixture.sources[0];
    if (!source) {
      throw new Error('WP-066 fixture has no source');
    }
    // H-01 (NR-131): escalation always runs on the clock; the unclocked step mode is gone.
    const tenantId = source.tenantId;
    const opened = openContinuityAlert(source, { openedAt: '2026-09-25T08:00:00Z' });
    expect(opened.gapDays).toBeGreaterThan(CONTINUITY_GAP_THRESHOLD_DAYS);
    const covering = escalateContinuity(opened, { now: '2026-09-25T12:00:00Z', tenantId });
    expect(covering.escalated).toBe(true);
    expect(covering.level).toBe('covering-prescriber');
    const director = escalateContinuity(covering, { now: '2026-09-25T16:00:00Z', tenantId });
    expect(director.level).toBe('medical-director');
    const inside = openContinuityAlert(
      { ...source, daysOfSupplyRemaining: 10, nextFillInDays: 12 },
      { openedAt: '2026-09-25T08:00:00Z' },
    );
    expect(escalateContinuity(inside, { now: '2026-09-26T08:00:00Z', tenantId }).escalated).toBe(
      false,
    );
  });

  it('honors an interim-source clause instead of dropping it', () => {
    const result = honorInterimClauses([
      {
        clauseId: 'pa-interim-athena',
        text: 'PA state from athena during overlay',
        interimSource: 'athena',
        nativeRule: false,
      },
      {
        clauseId: 'pa-unspecified',
        text: 'no source and no native rule',
        interimSource: null,
        nativeRule: false,
      },
    ]);
    expect(result.honored).toEqual([
      { clauseId: 'pa-interim-athena', interimSource: 'athena', honored: true },
    ]);
    expect(result.dropped).toEqual(['pa-unspecified']);
    expect(result.dropped).not.toContain('pa-interim-athena');
    const coverage: unknown = JSON.parse(
      readFileSync(resolve(directory, '../fixtures/wp-040-coverage.json'), 'utf8'),
    );
    const ledger: unknown = JSON.parse(
      readFileSync(resolve(directory, '../fixtures/wp-056-ledger.json'), 'utf8'),
    );
    expect(parseWp040Fixture(coverage).packageId).toBe(WP040_PACKAGE_ID);
    expect(parseWp056Fixture(ledger).packageId).toBe(WP056_PACKAGE_ID);
  });
});

function fixtureSource(): Wp066MedicationSource {
  const raw: unknown = JSON.parse(
    readFileSync(resolve(directory, '../fixtures/wp-066-medication.json'), 'utf8'),
  );
  const source = parseWp066Fixture(raw).sources[0];
  if (!source) throw new Error('WP-066 fixture has no source');
  return source;
}

describe('WP-082 rework 1: continuity escalation runs on an SLA clock (review finding medium)', () => {
  const tenantId = 'tenant-shadow';
  const openedAt = '2026-09-25T08:00:00Z';

  it('does not escalate before the level SLA elapses, however often it is called', () => {
    const sink = new InMemoryContinuityEscalations();
    let alert = openContinuityAlert(fixtureSource(), { openedAt });
    for (const now of ['2026-09-25T08:00:00Z', '2026-09-25T09:00:00Z', '2026-09-25T11:59:00Z']) {
      alert = escalateContinuity(alert, { now, tenantId, sink });
      expect(alert.level).toBe('open');
      expect(alert.escalated).toBe(false);
    }
    expect(sink.all()).toEqual([]);
  });

  it('escalates one level per elapsed SLA and records an event for each step', () => {
    const sink = new InMemoryContinuityEscalations();
    const opened = openContinuityAlert(fixtureSource(), { openedAt });
    const covering = escalateContinuity(opened, { now: '2026-09-25T12:00:00Z', tenantId, sink });
    expect(covering).toMatchObject({
      level: 'covering-prescriber',
      escalated: true,
      levelEnteredAt: '2026-09-25T12:00:00Z',
    });
    // Immediately again: no elapsed time at the new level, so no second jump.
    const again = escalateContinuity(covering, { now: '2026-09-25T12:00:00Z', tenantId, sink });
    expect(again.level).toBe('covering-prescriber');
    const director = escalateContinuity(again, { now: '2026-09-25T16:00:00Z', tenantId, sink });
    expect(director.level).toBe('medical-director');
    const top = escalateContinuity(director, { now: '2026-09-26T16:00:00Z', tenantId, sink });
    expect(top).toMatchObject({ level: 'medical-director', escalated: false });
    expect(sink.all()).toEqual([
      {
        tenantId,
        medicationId: 'med-shadow-1',
        from: 'open',
        to: 'covering-prescriber',
        at: '2026-09-25T12:00:00Z',
        gapDays: 6,
        minutesAtLevel: 240,
      },
      {
        tenantId,
        medicationId: 'med-shadow-1',
        from: 'covering-prescriber',
        to: 'medical-director',
        at: '2026-09-25T16:00:00Z',
        gapDays: 6,
        minutesAtLevel: 240,
      },
    ]);
  });

  it('stops escalating once acknowledged, on the clock and in legacy step mode', () => {
    const sink = new InMemoryContinuityEscalations();
    const opened = openContinuityAlert(fixtureSource(), { openedAt });
    const acknowledged = acknowledgeContinuityAlert(opened, {
      by: 'covering-prescriber-synthetic',
      at: '2026-09-25T08:30:00Z',
      tenantId,
    });
    expect(acknowledged).toMatchObject({
      acknowledged: true,
      acknowledgedBy: 'covering-prescriber-synthetic',
    });
    const later = escalateContinuity(acknowledged, { now: '2026-09-26T08:00:00Z', tenantId, sink });
    expect(later).toMatchObject({ level: 'open', escalated: false });
    expect(sink.all()).toEqual([]);

    const legacy = acknowledgeContinuityAlert(openContinuityAlert(fixtureSource()), {
      by: 'nurse-synthetic',
      at: '2026-09-25T08:30:00Z',
      tenantId,
    });
    expect(escalateContinuity(legacy, { now: '2026-09-26T08:00:00Z', tenantId })).toMatchObject({
      level: 'open',
      escalated: false,
    });
  });

  it('H-01 NR-131: an unclocked alert never steps without a clock, and with one starts its SLA clock', () => {
    const unclocked = openContinuityAlert(fixtureSource());
    expect(() => escalateContinuity(unclocked)).toThrow('escalates only with a clock');
    const started = escalateContinuity(unclocked, { now: '2026-09-25T08:00:00Z', tenantId });
    expect(started).toMatchObject({
      level: 'open',
      escalated: false,
      levelEnteredAt: '2026-09-25T08:00:00Z',
    });
    const early = escalateContinuity(started, { now: '2026-09-25T11:59:00Z', tenantId });
    expect(early.level).toBe('open');
    expect(escalateContinuity(early, { now: '2026-09-25T12:00:00Z', tenantId }).level).toBe(
      'covering-prescriber',
    );
  });

  it('refuses to escalate a clocked alert without a clock, or a clock that runs backwards', () => {
    const opened = openContinuityAlert(fixtureSource(), { openedAt });
    expect(() => escalateContinuity(opened)).toThrow('escalates only with a clock');
    expect(() => escalateContinuity(opened, { now: '2026-09-25T07:00:00Z', tenantId })).toThrow(
      'backwards',
    );
  });
});

describe('WP-082 rework 1: tenant binding and clause disposition (review findings low)', () => {
  it('binds the alert to the WP-066 source tenant and rejects cross-tenant escalation', () => {
    const opened = openContinuityAlert(fixtureSource(), { openedAt: '2026-09-25T08:00:00Z' });
    expect(opened.tenantId).toBe('tenant-shadow');
    expect(() =>
      escalateContinuity(opened, { now: '2026-09-25T12:00:00Z', tenantId: 'tenant-other' }),
    ).toThrow('crossed tenant scope');
    expect(() =>
      escalateContinuity(
        { ...opened, tenantId: 'tenant-other' },
        {
          now: '2026-09-25T12:00:00Z',
          tenantId: 'tenant-other',
        },
      ),
    ).toThrow('crossed tenant scope');
    expect(() =>
      acknowledgeContinuityAlert(opened, {
        by: 'x',
        at: '2026-09-25T09:00:00Z',
        tenantId: 'tenant-other',
      }),
    ).toThrow('crossed tenant scope');
  });

  it('gives every clause a disposition, including native-rule clauses', () => {
    const result = honorInterimClauses([
      { clauseId: 'pa-interim', text: 'interim', interimSource: 'athena', nativeRule: false },
      { clauseId: 'pa-native', text: 'native rule governs', interimSource: null, nativeRule: true },
      { clauseId: 'pa-orphan', text: 'neither', interimSource: '', nativeRule: false },
    ]);
    expect(result.honored.map((clause) => clause.clauseId)).toEqual(['pa-interim']);
    expect(result.native).toEqual(['pa-native']);
    expect(result.dropped).toEqual(['pa-orphan']);
  });
});
