import { describe, expect, it } from 'vitest';

import { createSeededRng, deriveDomainSeed } from './rng.js';

describe('deriveDomainSeed', () => {
  it('is stable for a (masterSeed, domain) pair and separates domains', () => {
    const a = deriveDomainSeed('master', 'households');
    const b = deriveDomainSeed('master', 'households');
    const c = deriveDomainSeed('master', 'persons');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('separates master seeds', () => {
    expect(deriveDomainSeed('master-a', 'persons')).not.toBe(
      deriveDomainSeed('master-b', 'persons'),
    );
  });

  it('refuses an empty master seed and a non-kebab domain', () => {
    expect(() => deriveDomainSeed('', 'persons')).toThrow(/non-empty/);
    expect(() => deriveDomainSeed('master', 'Persons')).toThrow(/kebab-case/);
  });
});

describe('createSeededRng', () => {
  it('replays an identical draw sequence from the same seed', () => {
    const draw = (): number[] => {
      const rng = createSeededRng('seed-1');
      return Array.from({ length: 64 }, () => rng.nextInt(1000));
    };
    expect(draw()).toEqual(draw());
  });

  it('produces a different sequence from a different seed', () => {
    const left = createSeededRng('seed-1');
    const right = createSeededRng('seed-2');
    const leftDraws = Array.from({ length: 32 }, () => left.nextInt(1000));
    const rightDraws = Array.from({ length: 32 }, () => right.nextInt(1000));
    expect(leftDraws).not.toEqual(rightDraws);
  });

  it('crosses the internal block boundary without repeating', () => {
    // The stream refills every 8 draws (32 bytes / 4). Drawing well past that
    // must keep advancing rather than cycling a single block.
    const rng = createSeededRng('block-boundary');
    const draws = Array.from({ length: 40 }, () => rng.nextUint32());
    expect(new Set(draws).size).toBeGreaterThan(30);
    expect(draws.slice(0, 8)).not.toEqual(draws.slice(8, 16));
  });

  it('stays inside the requested bound across many draws', () => {
    const rng = createSeededRng('bounds');
    for (let n = 0; n < 500; n += 1) {
      const value = rng.nextInt(7);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
  });

  it('is close to uniform (rejection sampling, not modulo bias)', () => {
    const rng = createSeededRng('uniformity');
    const buckets = new Array<number>(5).fill(0);
    for (let n = 0; n < 20_000; n += 1) {
      const index = rng.nextInt(5);
      buckets[index] = (buckets[index] ?? 0) + 1;
    }
    for (const count of buckets) {
      expect(count).toBeGreaterThan(3_600);
      expect(count).toBeLessThan(4_400);
    }
  });

  it('refuses a non-positive bound and an empty pool', () => {
    const rng = createSeededRng('refusals');
    expect(() => rng.nextInt(0)).toThrow(/positive integer/);
    expect(() => rng.nextInt(1.5)).toThrow(/positive integer/);
    expect(() => rng.pick([])).toThrow(/empty pool/);
  });

  it('refuses an empty seed', () => {
    expect(() => createSeededRng('')).toThrow(/non-empty/);
  });
});
