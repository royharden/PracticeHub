import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONTINUITY_GAP_THRESHOLD_DAYS,
  WP040_PACKAGE_ID,
  WP056_PACKAGE_ID,
  WP066_PACKAGE_ID,
} from './contracts.js';
import { escalateContinuity, honorInterimClauses, openContinuityAlert } from './continuity.js';
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
    const opened = openContinuityAlert(source);
    expect(opened.gapDays).toBeGreaterThan(CONTINUITY_GAP_THRESHOLD_DAYS);
    const covering = escalateContinuity(opened);
    expect(covering.escalated).toBe(true);
    expect(covering.level).toBe('covering-prescriber');
    const director = escalateContinuity(covering);
    expect(director.level).toBe('medical-director');
    const inside = openContinuityAlert({
      ...source,
      daysOfSupplyRemaining: 10,
      nextFillInDays: 12,
    });
    expect(escalateContinuity(inside).escalated).toBe(false);
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
