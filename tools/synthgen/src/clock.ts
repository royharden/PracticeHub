/**
 * Simulated clock (WP-029; synthetic-data-plan §3 "no wall-clock reads inside
 * generators").
 *
 * Every date a generator emits is an offset from the corpus manifest's pinned
 * `simulated_clock_epoch`. Nothing in synthgen calls `Date.now()` or constructs
 * a Date without an argument — a wall-clock read would make regeneration
 * time-dependent and the byte-stability gate would then be unprovable rather
 * than merely failing. The corpus gate scans this package's sources for those
 * constructs, so the rule is machine-enforced rather than a convention.
 */

const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export interface SimulatedClock {
  /** The pinned origin, echoed for provenance. */
  readonly epochIso: string;
  /** ISO date (YYYY-MM-DD) at a whole-day offset from the epoch. */
  dateAtDayOffset(days: number): string;
  /** ISO-8601 UTC instant at a minute offset from the epoch. */
  instantAtMinuteOffset(minutes: number): string;
}

export function createSimulatedClock(epochIso: string): SimulatedClock {
  if (!instantPattern.test(epochIso)) {
    throw new Error(
      `createSimulatedClock: epoch "${epochIso}" must be an ISO-8601 UTC instant (YYYY-MM-DDTHH:MM:SSZ)`,
    );
  }
  const epochMs = Date.parse(epochIso);
  // Shape alone is not enough: Date.parse ROLLS OVER an impossible calendar
  // date (2026-02-30 becomes March 2) instead of rejecting it, so a pinned
  // epoch that does not exist would silently become a different one. The
  // round-trip is what actually refuses it — the WP-019 F4 lesson, applied to
  // the corpus clock.
  if (Number.isNaN(epochMs) || `${new Date(epochMs).toISOString().slice(0, 19)}Z` !== epochIso) {
    throw new Error(`createSimulatedClock: epoch "${epochIso}" is not a real instant`);
  }
  const dayMs = 86_400_000;
  const minuteMs = 60_000;

  const requireInteger = (value: number, label: string): void => {
    if (!Number.isInteger(value)) {
      throw new Error(`${label} must be an integer offset; received ${value}`);
    }
  };

  return {
    epochIso,
    dateAtDayOffset(days: number): string {
      requireInteger(days, 'dateAtDayOffset');
      return new Date(epochMs + days * dayMs).toISOString().slice(0, 10);
    },
    instantAtMinuteOffset(minutes: number): string {
      requireInteger(minutes, 'instantAtMinuteOffset');
      return `${new Date(epochMs + minutes * minuteMs).toISOString().slice(0, 19)}Z`;
    },
  };
}

/**
 * Birth date for a subject of a given age in whole years, measured from the
 * simulated epoch. Ages are corpus data; the arithmetic is epoch-relative so a
 * cohort keeps its age no matter when the corpus is regenerated.
 */
export function birthDateForAge(
  clock: SimulatedClock,
  ageYears: number,
  dayJitter: number,
): string {
  if (!Number.isInteger(ageYears) || ageYears < 0 || ageYears > 120) {
    throw new Error(
      `birthDateForAge: ageYears must be an integer in [0, 120]; received ${ageYears}`,
    );
  }
  // 365-day years plus the leap days that have elapsed; exactness is not the
  // point, determinism and a plausible cohort spread are.
  const days = ageYears * 365 + Math.floor(ageYears / 4) + dayJitter;
  return clock.dateAtDayOffset(-days);
}
