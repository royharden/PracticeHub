/**
 * ULID event ids (WP-021; ADR-009 Decision 1). A ULID is a 26-character
 * Crockford base32 string — 48 bits of millisecond timestamp then 80 bits of
 * randomness — so ids are globally unique AND lexicographically sortable by
 * creation time (the outbox drains in creation order without a separate clock).
 *
 * Generation is a FACTORY over injectable time + randomness sources: the live
 * factory uses the system clock and a CSPRNG, but a test or seed passes fixed
 * sources for byte-exact determinism. Envelope construction never generates an
 * id implicitly — the caller supplies one — so pure functions stay pure and the
 * drift-tested seeds reproduce exactly.
 */

import type { EventId } from '@practicehub/contracts';

/** Crockford base32 (no I, L, O, U — reduces transcription error). */
const encoding = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const encodingLength = encoding.length; // 32
const timeLength = 10;
const randomLength = 16;
export const ulidLength = timeLength + randomLength; // 26

const ulidPattern = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export class UlidError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'UlidError';
  }
}

/** True for a well-formed 26-character Crockford-base32 ULID. */
export function isUlid(value: string): boolean {
  return ulidPattern.test(value);
}

export function assertEventId(value: string): asserts value is EventId {
  if (!isUlid(value)) {
    throw new UlidError(`event id must be a 26-character ULID; received ${JSON.stringify(value)}`);
  }
}

/** Narrow a validated string to the branded EventId type. */
export function toEventId(value: string): EventId {
  assertEventId(value);
  return value;
}

function encodeTime(now: number): string {
  if (!Number.isInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new UlidError(`ulid timestamp must be a 48-bit non-negative integer; received ${now}`);
  }
  let remaining = now;
  const chars: string[] = [];
  for (let index = timeLength - 1; index >= 0; index -= 1) {
    const mod = remaining % encodingLength;
    // encoding[mod] is always defined (mod < 32); the cast satisfies
    // noUncheckedIndexedAccess without a runtime branch on a proven index.
    chars[index] = encoding[mod] as string;
    remaining = (remaining - mod) / encodingLength;
  }
  return chars.join('');
}

export interface UlidSources {
  /** Milliseconds since the epoch (48-bit). */
  readonly now: () => number;
  /** At least 16 bytes of randomness. */
  readonly randomBytes: (length: number) => Uint8Array;
}

/**
 * A monotonic ULID factory: within the same millisecond it increments the
 * random field so ids stay strictly increasing (two events in one tick never
 * collide and preserve order). Deterministic given deterministic sources.
 */
export function createUlidFactory(sources: UlidSources): () => EventId {
  let lastTime = -1;
  let lastRandom: number[] = [];
  return () => {
    const now = sources.now();
    if (now === lastTime) {
      // Increment the 80-bit random field (base-32 digits, least significant last).
      for (let index = lastRandom.length - 1; index >= 0; index -= 1) {
        const value = (lastRandom[index] as number) + 1;
        if (value < encodingLength) {
          lastRandom[index] = value;
          break;
        }
        lastRandom[index] = 0;
        if (index === 0) {
          throw new UlidError('ulid random field overflowed within a single millisecond');
        }
      }
    } else {
      lastTime = now;
      const bytes = sources.randomBytes(randomLength);
      lastRandom = Array.from(
        { length: randomLength },
        (_unused, index) => (bytes[index] as number) & 0x1f,
      );
    }
    const random = lastRandom.map((digit) => encoding[digit] as string).join('');
    return toEventId(encodeTime(now) + random);
  };
}
