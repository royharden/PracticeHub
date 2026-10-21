import { describe, expect, it } from 'vitest';

import { parseAbnInstant } from './abn.js';

describe('WP-094 hardening H-14 (NR-155): ABN instants are calendar-checked', () => {
  it.each([
    '2026-02-30T10:00:00Z',
    '2026-02-29T10:00:00Z',
    '2026-04-31T10:00:00Z',
    '2026-13-01T10:00:00Z',
    '2026-00-10T10:00:00Z',
    '2026-01-00T10:00:00Z',
    '2026-01-10T24:00:00Z',
    '2026-01-10T10:60:00Z',
    '2026-01-10T10:00:60Z',
    '2026-01-10T10:00:00+24:00',
  ])('refuses the impossible instant %s instead of rolling it over', (value) => {
    expect(parseAbnInstant(value)).toBeNull();
  });

  it('still accepts valid instants, including a leap day, fractions and offsets', () => {
    expect(parseAbnInstant('2028-02-29T10:00:00Z')).toBe(Date.parse('2028-02-29T10:00:00Z'));
    expect(parseAbnInstant('2026-01-31T23:59:59.123Z')).toBe(
      Date.parse('2026-01-31T23:59:59.123Z'),
    );
    expect(parseAbnInstant('2026-01-10T10:00-05:00')).toBe(Date.parse('2026-01-10T15:00:00Z'));
  });
});
