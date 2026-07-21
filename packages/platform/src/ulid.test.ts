import { describe, expect, it } from 'vitest';

import { createUlidFactory, isUlid, toEventId, ulidLength, UlidError } from './ulid.js';

function fixedBytes(seed: number): (length: number) => Uint8Array {
  return (length) => Uint8Array.from({ length }, (_unused, index) => (seed + index) & 0xff);
}

describe('ULID event ids', () => {
  it('produces a 26-character Crockford-base32 id', () => {
    const ulid = createUlidFactory({ now: () => 1_700_000_000_000, randomBytes: fixedBytes(1) })();
    expect(ulid).toHaveLength(ulidLength);
    expect(isUlid(ulid)).toBe(true);
  });

  it('is deterministic given deterministic sources (seeds/tests reproduce exactly)', () => {
    const make = (): string =>
      createUlidFactory({ now: () => 1_700_000_000_000, randomBytes: fixedBytes(7) })();
    expect(make()).toBe(make());
  });

  it('is monotonic within a single millisecond (order preserved, no collision)', () => {
    const factory = createUlidFactory({ now: () => 1_700_000_000_000, randomBytes: fixedBytes(3) });
    const ids = Array.from({ length: 50 }, () => factory());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sorts lexicographically by creation time across milliseconds', () => {
    let clock = 1_700_000_000_000;
    const factory = createUlidFactory({ now: () => clock, randomBytes: fixedBytes(9) });
    const earlier = factory();
    clock += 5;
    const later = factory();
    expect(earlier < later).toBe(true);
  });

  it('rejects a non-ULID string', () => {
    expect(isUlid('not-a-ulid')).toBe(false);
    expect(isUlid('IL0O' + 'A'.repeat(22))).toBe(false); // I, L, O are not in the alphabet
    expect(() => toEventId('short')).toThrow(UlidError);
  });

  it('rejects a timestamp outside the 48-bit range', () => {
    expect(() =>
      createUlidFactory({ now: () => 0x1_0000_0000_0000, randomBytes: fixedBytes(1) })(),
    ).toThrow(UlidError);
  });
});
