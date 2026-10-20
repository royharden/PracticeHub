/**
 * Instants in WP-115 are compared as epoch milliseconds, never as strings:
 * two valid ISO 8601 instants with different precision or offset do not sort
 * lexically. Anything that is not a full ISO 8601 date-time with a `Z` or
 * numeric offset is unparseable, and every caller fails closed on it.
 *
 * Hardening H-10:
 * - NR-139: the date and time must exist on the calendar (no 2026-02-30,
 *   hour 24, minute 60); `Date.parse` would silently roll them over.
 * - NR-138: fractional seconds are held to millisecond precision explicitly.
 *   More than three fractional digits would be truncated by epoch
 *   milliseconds, so they are refused rather than silently altered.
 */

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** Epoch milliseconds, or null when the value is not a parseable ISO 8601 instant. */
export function parseInstant(value: string): number | null {
  const match = ISO_INSTANT.exec(value);
  if (match === null) return null;
  const part = (index: number): number => Number(match[index] ?? '0');
  const [year, month, day, hour, minute, second] = [
    part(1),
    part(2),
    part(3),
    part(4),
    part(5),
    part(6),
  ];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    part(8) > 23 ||
    part(9) > 59
  ) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Epoch milliseconds, throwing when the value is not a parseable instant. */
export function requireInstant(value: string, field: string): number {
  const ms = parseInstant(value);
  if (ms === null) throw new Error(`${field} is not an ISO 8601 instant: ${value}`);
  return ms;
}
