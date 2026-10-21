import { RcmShadowError } from '../contracts.js';

export type GateConfidence = 0.9 | 0.95 | 0.99;

/** Two-sided normal quantiles for the supported confidence levels. */
export const Z_FOR_CONFIDENCE: Readonly<Record<GateConfidence, number>> = {
  0.9: 1.6448536269514722,
  0.95: 1.959963984540054,
  0.99: 2.5758293035489004,
};

export interface WilsonInterval {
  readonly successes: number;
  readonly n: number;
  readonly point: number;
  readonly lower: number;
  readonly upper: number;
}

/**
 * Wilson score interval for a proportion. A gate compares the LOWER bound to its threshold, so
 * a small sample with a high point estimate cannot pass: tiny percentages never authorise a
 * promotion (CDX stats correction: the point estimate is never the test).
 */
export function wilsonInterval(
  successes: number,
  n: number,
  confidence: GateConfidence,
): WilsonInterval {
  if (
    !Number.isSafeInteger(n) ||
    n < 0 ||
    !Number.isSafeInteger(successes) ||
    successes < 0 ||
    successes > n
  ) {
    throw new RcmShadowError('GATE_STATS', 'need whole numbers with 0 <= successes <= n');
  }
  const z = Z_FOR_CONFIDENCE[confidence];
  if (z === undefined) {
    throw new RcmShadowError('GATE_STATS', 'confidence must be 0.9, 0.95 or 0.99');
  }
  if (n === 0) {
    return { successes, n, point: 0, lower: 0, upper: 1 };
  }
  const p = successes / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return {
    successes,
    n,
    point: p,
    // Exact at the edges; floating point would otherwise leave 1 - 1e-16 at k = n.
    lower: successes === 0 ? 0 : Math.max(0, centre - half),
    upper: successes === n ? 1 : Math.min(1, centre + half),
  };
}
