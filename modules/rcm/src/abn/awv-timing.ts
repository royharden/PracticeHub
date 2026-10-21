/**
 * AWV / IPPE timing windows and displacement warnings (R6-REQ-025; REQ-RCM-081 AC3).
 *
 * - IPPE: once in a lifetime, within the first 12 months of Part B coverage.
 * - AWV: not in the first 12 months of Part B, not within 12 months of an
 *   IPPE, and only after 11 full months have passed following the month of
 *   the last AWV (so a January AWV makes the next one eligible from the
 *   following January 1st).
 * Unknown history never blocks the visit: it flags manual eligibility
 * confirmation before the claim is submitted.
 */

export type CoveredVisitKind = 'awv' | 'ippe';

export interface CoveredVisitHistoryEntry {
  readonly kind: CoveredVisitKind;
  /** YYYY-MM-DD. */
  readonly date: string;
  readonly status: 'completed' | 'scheduled';
}

export type CoveredVisitStatus =
  'eligible' | 'already-used' | 'too-early' | 'outside-ippe-window' | 'unknown-history';

export interface CoveredVisitWindow {
  readonly kind: CoveredVisitKind;
  readonly status: CoveredVisitStatus;
  /** First eligible date (YYYY-MM-DD), or null when never eligible again or unknown. */
  readonly earliestEligible: string | null;
  readonly manualConfirmationRequired: boolean;
  readonly warnings: readonly string[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parse(date: string): { y: number; m: number; d: number } {
  if (!DATE.test(date)) throw new Error(`date must be YYYY-MM-DD: ${date}`);
  const [y, m, d] = date.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) throw new Error('bad date');
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new Error(`date is not a calendar date: ${date}`);
  }
  return { y, m, d };
}

const format = (y: number, m: number, d: number): string =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Same day-of-month N months later, clamped to the month's last day. */
function addMonths(date: string, months: number): string {
  const { y, m, d } = parse(date);
  const index = y * 12 + (m - 1) + months;
  const ny = Math.floor(index / 12);
  const nm = (index % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return format(ny, nm, Math.min(d, last));
}

/** First day of the month that follows 11 full months after `date`'s month. */
function awvReeligibleFrom(date: string): string {
  const { y, m } = parse(date);
  const index = y * 12 + (m - 1) + 12;
  return format(Math.floor(index / 12), (index % 12) + 1, 1);
}

const later = (left: string, right: string): string => (left > right ? left : right);

export function evaluateCoveredVisit(input: {
  readonly kind: CoveredVisitKind;
  readonly serviceDate: string;
  readonly partBEffectiveDate: string | null;
  /** null when no eligibility history is on file. */
  readonly history: readonly CoveredVisitHistoryEntry[] | null;
}): CoveredVisitWindow {
  parse(input.serviceDate);
  if (input.partBEffectiveDate === null || input.history === null) {
    return {
      kind: input.kind,
      status: 'unknown-history',
      earliestEligible: null,
      manualConfirmationRequired: true,
      warnings: ['manual-eligibility-confirmation-before-claim'],
    };
  }
  const partB = input.partBEffectiveDate;
  parse(partB);
  for (const entry of input.history) parse(entry.date);
  // Drop only the scheduled entry that is this visit; a completed same-day visit still counts.
  const history = input.history.filter(
    (entry) =>
      !(
        entry.status === 'scheduled' &&
        entry.date === input.serviceDate &&
        entry.kind === input.kind
      ),
  );
  const completed = history.filter(
    (entry) => entry.status === 'completed' && entry.date <= input.serviceDate,
  );
  const warnings: string[] = [];
  const firstYearEnds = addMonths(partB, 12);

  let status: CoveredVisitStatus;
  let earliest: string | null;
  if (input.kind === 'ippe') {
    const priorIppe = completed.some((entry) => entry.kind === 'ippe');
    if (priorIppe) {
      status = 'already-used';
      earliest = null;
    } else if (input.serviceDate < partB) {
      status = 'too-early';
      earliest = partB;
    } else if (input.serviceDate >= firstYearEnds) {
      status = 'outside-ippe-window';
      earliest = null;
    } else {
      status = 'eligible';
      earliest = partB;
    }
  } else {
    let from = firstYearEnds;
    const lastIppe = completed
      .filter((entry) => entry.kind === 'ippe')
      .map((entry) => entry.date)
      .sort()
      .at(-1);
    // One counting rule for both: 11 full months after the month of the last IPPE or AWV.
    if (lastIppe !== undefined) from = later(from, awvReeligibleFrom(lastIppe));
    const lastAwv = completed
      .filter((entry) => entry.kind === 'awv')
      .map((entry) => entry.date)
      .sort()
      .at(-1);
    if (lastAwv !== undefined) from = later(from, awvReeligibleFrom(lastAwv));
    earliest = from;
    status =
      input.serviceDate >= from
        ? 'eligible'
        : lastAwv !== undefined && awvReeligibleFrom(lastAwv) > input.serviceDate
          ? 'already-used'
          : 'too-early';
  }

  // Displacement: a covered visit scheduled later that this visit would make ineligible.
  for (const entry of history) {
    if (entry.status !== 'scheduled' || entry.date <= input.serviceDate) continue;
    if (
      input.kind === 'awv' &&
      entry.kind === 'awv' &&
      entry.date < awvReeligibleFrom(input.serviceDate)
    ) {
      warnings.push(`displaces-scheduled-awv:${entry.date}`);
    }
    if (input.kind === 'ippe' && entry.kind === 'ippe') {
      warnings.push(`duplicates-scheduled-ippe:${entry.date}`);
    }
    if (
      input.kind === 'ippe' &&
      entry.kind === 'awv' &&
      entry.date < addMonths(input.serviceDate, 12)
    ) {
      warnings.push(`displaces-scheduled-awv:${entry.date}`);
    }
  }
  if (status !== 'eligible') warnings.unshift(`covered-visit-${status}`);
  return {
    kind: input.kind,
    status,
    earliestEligible: earliest,
    manualConfirmationRequired: false,
    warnings,
  };
}
