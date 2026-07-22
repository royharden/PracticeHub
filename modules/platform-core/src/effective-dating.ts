/**
 * Effective-dating primitive (ADR-ADJ-002 frozen semantics 1–8), extracted from
 * the WP-011 jurisdiction resolver so every counsel-owned, effective-dated
 * registry selects versions through ONE model — the WP-011 jurisdiction packs
 * (`jurisdiction.ts` delegates here) AND the WP-019 policy/disclosure +
 * obligation-clock registries (`@practicehub/consent`). This is the mechanical
 * carrier for FWD-SR-019-TEMPORAL: a second registry cannot fork the temporal
 * model (an exclusive boundary, a wall-clock default) because it reuses this
 * code, not a re-derivation. ADR-ADJ-002 ground 3.
 *
 * Semantics: `effectiveOn` is an ISO `YYYY-MM-DD` calendar date (UTC basis,
 * day-granular — sub-day/timezone precision is deliberately out of scope in v1);
 * the active version as-of `T` is the HIGHEST version among those with
 * `effectiveOn ≤ T` (inclusive boundary); no monotonicity constraint links
 * version order to `effectiveOn` order (a correction may land as a new highest
 * version with an earlier date than a staged future version).
 */

/**
 * The epoch sentinel (ADR-ADJ-002 semantics 3): a registry's always-effective
 * base/pseudo variant carries this `effectiveOn` so it is selectable at every
 * queriable as-of and fail-closed resolution is never vacuous.
 */
export const epochEffectiveOn = '1970-01-01';

/** The minimal shape the selector orders over. */
export interface EffectiveDatedVersion {
  readonly version: number;
  /** ISO `YYYY-MM-DD` (UTC basis, inclusive "on and after"). */
  readonly effectiveOn: string;
}

export class EffectiveDatingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EffectiveDatingError';
  }
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Calendar-date check (ADR-ADJ-002 semantics 5): ISO `YYYY-MM-DD`, compared as
 * strings on a UTC basis, round-trip validated so `2026-02-30` is rejected. Day
 * granularity is deliberate — counsel effective dates are day-granular.
 */
export function isEffectiveDate(value: string): boolean {
  if (!isoDatePattern.test(value)) {
    return false;
  }
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    return false;
  }
  return new Date(parsed).toISOString().slice(0, 10) === value;
}

/**
 * The as-of date a resolution uses (ADR-ADJ-002 semantics 4): the caller's
 * explicit `asOf`, or the current date at evaluation (UTC basis) — send-time /
 * action-time consumers omit it; retrospective and audit consumers pass it. A
 * malformed date fails closed (never a wall-clock fallback).
 */
export function resolveEffectiveAsOf(asOf?: string): string {
  const resolved = asOf ?? new Date().toISOString().slice(0, 10);
  if (!isEffectiveDate(resolved)) {
    throw new EffectiveDatingError(
      `asOf must be a calendar date (YYYY-MM-DD); received ${JSON.stringify(resolved)}`,
    );
  }
  return resolved;
}

/**
 * Selection rule (ADR-ADJ-002 semantics 2): the active version among a set of
 * versions (already narrowed to one registry key by the caller) is the highest
 * `version` whose `effectiveOn ≤ asOf` (inclusive ISO-string comparison). A
 * future-dated version is pre-staged and inert until its date; `undefined` when
 * no version is effective as-of the query (the caller decides the fail-closed
 * route — a safe default, a base variant, or an error).
 */
export function selectEffectiveVersion<T extends EffectiveDatedVersion>(
  versions: readonly T[],
  asOf: string,
): T | undefined {
  return versions
    .filter((candidate) => candidate.effectiveOn <= asOf)
    .sort((left, right) => right.version - left.version)[0];
}
