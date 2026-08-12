import { describe, expect, it } from 'vitest';

import { birthDateForAge, createSimulatedClock } from './clock.js';

const epoch = '2026-01-01T00:00:00Z';

describe('createSimulatedClock', () => {
  it('anchors every date to the pinned epoch, never the wall clock', () => {
    const clock = createSimulatedClock(epoch);
    expect(clock.epochIso).toBe(epoch);
    expect(clock.dateAtDayOffset(0)).toBe('2026-01-01');
    expect(clock.dateAtDayOffset(1)).toBe('2026-01-02');
    expect(clock.dateAtDayOffset(-1)).toBe('2025-12-31');
  });

  it('emits ISO-8601 UTC instants at minute offsets', () => {
    const clock = createSimulatedClock(epoch);
    expect(clock.instantAtMinuteOffset(0)).toBe('2026-01-01T00:00:00Z');
    expect(clock.instantAtMinuteOffset(90)).toBe('2026-01-01T01:30:00Z');
  });

  it('crosses a leap day correctly (the boundary a naive year offset gets wrong)', () => {
    const clock = createSimulatedClock('2024-02-28T00:00:00Z');
    expect(clock.dateAtDayOffset(1)).toBe('2024-02-29');
    expect(clock.dateAtDayOffset(2)).toBe('2024-03-01');
  });

  it('refuses a malformed or impossible epoch', () => {
    expect(() => createSimulatedClock('2026-01-01')).toThrow(/ISO-8601 UTC instant/);
    expect(() => createSimulatedClock('2026-01-01T00:00:00+02:00')).toThrow(/ISO-8601 UTC instant/);
    // Date.parse rolls 2026-02-30 over to March 2 rather than rejecting it; a
    // pinned epoch that silently becomes a different instant is worse than one
    // that fails loudly.
    expect(() => createSimulatedClock('2026-02-30T00:00:00Z')).toThrow(/not a real instant/);
    expect(() => createSimulatedClock('2025-02-29T00:00:00Z')).toThrow(/not a real instant/);
    expect(() => createSimulatedClock('2026-13-01T00:00:00Z')).toThrow(/not a real instant/);
  });

  it('refuses a fractional offset rather than silently truncating', () => {
    const clock = createSimulatedClock(epoch);
    expect(() => clock.dateAtDayOffset(1.5)).toThrow(/integer offset/);
    expect(() => clock.instantAtMinuteOffset(0.5)).toThrow(/integer offset/);
  });
});

describe('birthDateForAge', () => {
  it('places a cohort at its age relative to the epoch, not to today', () => {
    const clock = createSimulatedClock(epoch);
    const born = birthDateForAge(clock, 40, 0);
    expect(born.slice(0, 4)).toBe('1986');
  });

  it('is stable under regeneration for the same inputs', () => {
    const clock = createSimulatedClock(epoch);
    expect(birthDateForAge(clock, 33, 120)).toBe(birthDateForAge(clock, 33, 120));
  });

  it('refuses an implausible age instead of emitting a nonsense date', () => {
    const clock = createSimulatedClock(epoch);
    expect(() => birthDateForAge(clock, -1, 0)).toThrow(/\[0, 120\]/);
    expect(() => birthDateForAge(clock, 200, 0)).toThrow(/\[0, 120\]/);
  });
});
