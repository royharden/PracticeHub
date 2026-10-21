import { describe, expect, it } from 'vitest';

import { wilsonInterval, type GateConfidence } from './stats.js';

/** Deterministic PRNG (mulberry32) so the property runs are reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const LEVELS: readonly GateConfidence[] = [0.9, 0.95, 0.99];
const RUNS = 2_000;

describe('WP-092 gate math properties (Wilson interval)', () => {
  it('bounds stay in [0, 1] and bracket the point estimate', () => {
    const random = prng(92);
    for (let run = 0; run < RUNS; run += 1) {
      const n = 1 + Math.floor(random() * 5_000);
      const k = Math.floor(random() * (n + 1));
      const confidence = LEVELS[run % LEVELS.length] ?? 0.95;
      const interval = wilsonInterval(k, n, confidence);
      expect(interval.lower).toBeGreaterThanOrEqual(0);
      expect(interval.upper).toBeLessThanOrEqual(1);
      expect(interval.lower).toBeLessThanOrEqual(interval.point);
      expect(interval.point).toBeLessThanOrEqual(interval.upper);
    }
  });

  it('the lower bound rises with every extra success at fixed n', () => {
    const random = prng(7);
    for (let run = 0; run < RUNS; run += 1) {
      const n = 2 + Math.floor(random() * 2_000);
      const k = Math.floor(random() * n);
      expect(wilsonInterval(k + 1, n, 0.95).lower).toBeGreaterThan(
        wilsonInterval(k, n, 0.95).lower,
      );
    }
  });

  it('more evidence at the same rate narrows the interval', () => {
    const random = prng(11);
    for (let run = 0; run < RUNS; run += 1) {
      const n = 1 + Math.floor(random() * 500);
      const k = Math.floor(random() * (n + 1));
      const small = wilsonInterval(k, n, 0.95);
      const large = wilsonInterval(k * 10, n * 10, 0.95);
      expect(large.upper - large.lower).toBeLessThan(small.upper - small.lower);
    }
  });

  it('higher confidence widens the interval', () => {
    const random = prng(13);
    for (let run = 0; run < RUNS; run += 1) {
      const n = 1 + Math.floor(random() * 2_000);
      const k = Math.floor(random() * (n + 1));
      const w90 = wilsonInterval(k, n, 0.9);
      const w99 = wilsonInterval(k, n, 0.99);
      expect(w99.lower).toBeLessThanOrEqual(w90.lower);
      expect(w99.upper).toBeGreaterThanOrEqual(w90.upper);
    }
  });

  it('a tiny perfect sample cannot clear a high threshold (CDX stats correction)', () => {
    expect(wilsonInterval(5, 5, 0.95).point).toBe(1);
    expect(wilsonInterval(5, 5, 0.95).lower).toBeLessThan(0.6);
    expect(wilsonInterval(990, 1_000, 0.95).lower).toBeGreaterThan(0.98);
  });

  it('matches a known Wilson value and handles the edges exactly', () => {
    const interval = wilsonInterval(81, 263, 0.95);
    expect(interval.lower).toBeCloseTo(0.2553, 4);
    expect(interval.upper).toBeCloseTo(0.3662, 4);
    expect(wilsonInterval(0, 0, 0.95)).toEqual({
      successes: 0,
      n: 0,
      point: 0,
      lower: 0,
      upper: 1,
    });
    expect(wilsonInterval(0, 10, 0.95).lower).toBe(0);
    expect(wilsonInterval(10, 10, 0.95).upper).toBe(1);
  });

  it('refuses impossible counts', () => {
    expect(() => wilsonInterval(3, 2, 0.95)).toThrow(/successes <= n/);
    expect(() => wilsonInterval(-1, 2, 0.95)).toThrow(/successes <= n/);
    expect(() => wilsonInterval(1.5, 2, 0.95)).toThrow(/whole numbers/);
    expect(() => wilsonInterval(1, 2, 0.8 as GateConfidence)).toThrow(/0.9, 0.95 or 0.99/);
  });
});
