/**
 * Effective-dating primitive (ADR-ADJ-002 semantics 1–8). This is the SHARED
 * temporal model the jurisdiction resolver (WP-011) and the WP-019 policy/clock
 * registries both select through — FWD-SR-019-TEMPORAL's fork guard. The
 * boundary anchors here pin the semantics; the jurisdiction truth-table proves
 * the resolver's behavior is unchanged by delegating to this module.
 */
import { describe, expect, it } from 'vitest';

import {
  EffectiveDatingError,
  epochEffectiveOn,
  isEffectiveDate,
  resolveEffectiveAsOf,
  selectEffectiveVersion,
} from './effective-dating.js';

interface V {
  readonly version: number;
  readonly effectiveOn: string;
}

describe('isEffectiveDate (semantics 5: calendar date, UTC, round-trip)', () => {
  it('accepts a real calendar date', () => {
    expect(isEffectiveDate('2026-01-01')).toBe(true);
    expect(isEffectiveDate(epochEffectiveOn)).toBe(true);
  });

  it('rejects a malformed or impossible date (fails closed)', () => {
    expect(isEffectiveDate('2026-1-1')).toBe(false);
    expect(isEffectiveDate('2026-02-30')).toBe(false);
    expect(isEffectiveDate('2026-13-01')).toBe(false);
    expect(isEffectiveDate('not-a-date')).toBe(false);
    expect(isEffectiveDate('2026-01-01T00:00:00Z')).toBe(false);
  });
});

describe('resolveEffectiveAsOf (semantics 4)', () => {
  it('returns an explicit asOf verbatim', () => {
    expect(resolveEffectiveAsOf('2026-06-01')).toBe('2026-06-01');
  });

  it('defaults to a calendar date when omitted (current date, UTC basis)', () => {
    expect(isEffectiveDate(resolveEffectiveAsOf())).toBe(true);
  });

  it('fails closed on a malformed asOf — never a wall-clock fallback', () => {
    expect(() => resolveEffectiveAsOf('2026-02-30')).toThrow(EffectiveDatingError);
    expect(() => resolveEffectiveAsOf('June 1')).toThrow('calendar date');
  });
});

describe('selectEffectiveVersion (semantics 2: highest version among effectiveOn <= asOf)', () => {
  const versions: readonly V[] = [
    { version: 1, effectiveOn: '1970-01-01' },
    { version: 2, effectiveOn: '2026-01-01' },
    { version: 3, effectiveOn: '2099-12-31' }, // future-staged, inert
  ];

  it('selects the highest effective version, ignoring future-staged ones', () => {
    expect(selectEffectiveVersion(versions, '2026-06-01')?.version).toBe(2);
  });

  it('inclusive boundary: effectiveOn == asOf is selectable (on and after)', () => {
    expect(selectEffectiveVersion(versions, '2026-01-01')?.version).toBe(2);
    expect(selectEffectiveVersion(versions, '2025-12-31')?.version).toBe(1);
  });

  it('activates the staged version exactly on its date', () => {
    expect(selectEffectiveVersion(versions, '2099-12-30')?.version).toBe(2);
    expect(selectEffectiveVersion(versions, '2099-12-31')?.version).toBe(3);
  });

  it('no monotonicity: a correction is a new highest version with an earlier date', () => {
    const corrected: readonly V[] = [
      ...versions,
      { version: 4, effectiveOn: '2026-02-01' }, // highest version, earlier than staged v3
    ];
    expect(selectEffectiveVersion(corrected, '2100-01-01')?.version).toBe(4);
  });

  it('returns undefined when nothing is effective as-of the query (caller fails closed)', () => {
    expect(selectEffectiveVersion(versions, '1969-12-31')).toBeUndefined();
  });
});
