/**
 * Deterministic randomness for synthgen (WP-029; docs/requirements/synthetic-data-plan.md §3).
 *
 * One master seed, HKDF-style derived per-domain seeds, and a single seeded
 * stream. There is no entropy source in this file and no wall-clock read: given
 * the same (generator version, master seed, source pins) the corpus regenerates
 * byte-for-byte, which is what the byte-stability gate asserts.
 *
 * The stream is SHA-256 in counter mode. It is not a cryptographic PRNG in the
 * sense of secrecy — nothing here is a secret — it is a REPRODUCIBLE one, which
 * is the property the corpus needs.
 */
import { createHash } from 'node:crypto';

export interface SeededRng {
  /** The seed this stream was derived from (carried for provenance). */
  readonly seed: string;
  nextUint32(): number;
  /** Uniform integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  /** Uniform selection; throws on an empty pool rather than returning undefined. */
  pick<T>(items: readonly T[]): T;
  /** True with probability numerator/denominator. */
  chance(numerator: number, denominator: number): boolean;
}

/**
 * Derive a per-domain seed from the master seed. Domains are namespaced so that
 * changing the number of households cannot shift the clinical stream, and vice
 * versa — a corpus edit stays local to the domain it touches.
 */
export function deriveDomainSeed(masterSeed: string, domain: string): string {
  if (masterSeed.length === 0) {
    throw new Error('deriveDomainSeed: masterSeed must be a non-empty string');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(domain)) {
    throw new Error(
      `deriveDomainSeed: domain "${domain}" must be a lowercase kebab-case identifier`,
    );
  }
  return createHash('sha256').update(`${masterSeed}/${domain}`).digest('hex');
}

export function createSeededRng(seed: string): SeededRng {
  if (seed.length === 0) {
    throw new Error('createSeededRng: seed must be a non-empty string');
  }
  let counter = 0;
  let block = Buffer.alloc(0);
  let offset = 0;

  const refill = (): void => {
    block = createHash('sha256')
      .update(`${seed}#${String(counter)}`)
      .digest();
    counter += 1;
    offset = 0;
  };

  const nextUint32 = (): number => {
    if (offset + 4 > block.length) {
      refill();
    }
    const value = block.readUInt32BE(offset);
    offset += 4;
    return value;
  };

  const nextInt = (maxExclusive: number): number => {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`nextInt: maxExclusive must be a positive integer; received ${maxExclusive}`);
    }
    // Rejection sampling keeps the distribution uniform. The rejection band is
    // derived from the bound, so the draw sequence stays a pure function of the
    // seed and the call order.
    const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;
    let draw = nextUint32();
    while (draw >= limit) {
      draw = nextUint32();
    }
    return draw % maxExclusive;
  };

  return {
    seed,
    nextUint32,
    nextInt,
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new Error('pick: cannot select from an empty pool');
      }
      const chosen = items[nextInt(items.length)];
      if (chosen === undefined) {
        throw new Error('pick: pool holds an undefined entry');
      }
      return chosen;
    },
    chance(numerator: number, denominator: number): boolean {
      if (!Number.isInteger(denominator) || denominator <= 0) {
        throw new Error('chance: denominator must be a positive integer');
      }
      return nextInt(denominator) < numerator;
    },
  };
}
