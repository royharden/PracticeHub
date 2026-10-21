/**
 * WP-111 hardening H-10 (NR-138, NR-139) for the podium-exit instant parser.
 * Each test fails on the pre-hardening parser and passes after.
 */
import { describe, expect, it } from 'vitest';

import { parseInstant, requireInstant } from './instant.js';
import { evaluateOptOutContinuity } from './opt-out-continuity.js';
import type { SuppressionLedgerPort } from './ports.js';
import { numberA, tenant } from './synthetic.js';

describe('NR-139: impossible calendar dates and times are refused, not rolled over', () => {
  it('returns null for dates and times that do not exist', () => {
    for (const impossible of [
      '2026-02-30T00:00:00Z',
      '2026-02-29T12:00:00Z',
      '2026-04-31T09:00:00+02:00',
      '2026-06-01T24:00:00Z',
      '2026-06-01T10:60:00Z',
      '2026-06-01T10:00:60Z',
      '2026-06-01T10:00:00+24:00',
    ]) {
      expect(parseInstant(impossible), impossible).toBeNull();
    }
    expect(parseInstant('2028-02-29T12:00:00Z')).toBe(Date.parse('2028-02-29T12:00:00Z'));
  });

  it('fails the stop-ship gate closed on a rolled-over freeze instant', () => {
    const suppressed: SuppressionLedgerPort = { smsSuppression: () => 'suppressed' };
    const decision = evaluateOptOutContinuity(suppressed, {
      tenantId: tenant,
      numberRef: numberA,
      podiumOptOuts: [],
      consentImportWatermark: '2026-03-02T00:00:00Z',
      podiumReadOnlyAt: '2026-02-30T00:00:00Z',
    });
    expect(decision.shipAllowed).toBe(false);
    expect(decision.reasons).toEqual(['podium-freeze-instant-unparseable']);
  });
});

describe('NR-138: millisecond precision is explicit; finer precision is refused, not truncated', () => {
  it('accepts up to three fractional digits exactly', () => {
    expect(parseInstant('2026-06-01T10:00:00.5Z')).toBe(Date.parse('2026-06-01T10:00:00.500Z'));
    expect(parseInstant('2026-06-01T10:00:00.123Z')).toBe(Date.parse('2026-06-01T10:00:00.123Z'));
  });

  it('refuses sub-millisecond fractions that epoch milliseconds would silently truncate', () => {
    for (const fine of [
      '2026-06-01T10:00:00.1234Z',
      '2026-06-01T10:00:00.000999Z',
      '2026-06-01T10:00:00.123456789Z',
    ]) {
      expect(parseInstant(fine), fine).toBeNull();
      expect(() => requireInstant(fine, 'probe')).toThrow('not an ISO 8601 instant');
    }
  });
});
