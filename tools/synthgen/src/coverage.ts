/**
 * Persona x story coverage floor (WP-029 verification gate, clause 1).
 *
 * `docs/requirements/persona-story-matrix.csv` is the ONE persona x story
 * artifact (docs/contracts/persona-story-matrix.md). WP-005 proved the matrix
 * regenerates deterministically and that every row carries the four-class
 * fixture floor. What it did NOT check is whether the CORPUS actually contains
 * anyone to play those parts — a matrix can be complete over a world that is
 * empty.
 *
 * The floor closed here: every persona the matrix names must be instantiated by
 * at least one corpus subject, and every journey it names must be carried by at
 * least one subject. An uncovered persona or journey is named individually, not
 * summarised as a count — a floor that reports "12 missing" is a floor nobody
 * can discharge.
 *
 * The matrix may RAISE a row's fixture floor above the four classes; it can
 * never lower one (contract §Floor semantics). This module re-checks that
 * direction too, because the corpus is generated against the floor the matrix
 * states.
 */
import { requiredFixtureClasses } from '@practicehub/testkit';
import type { PersonaStoryRow } from '@practicehub/testkit';

export interface CoverageSubject {
  readonly subjectId: string;
  readonly personaSlug: string;
  readonly journeys: readonly string[];
}

export interface PersonaStoryCoverageReport {
  readonly requiredPersonaSlugs: readonly string[];
  readonly coveredPersonaSlugs: readonly string[];
  readonly missingPersonaSlugs: readonly string[];
  readonly requiredJourneys: readonly string[];
  readonly coveredJourneys: readonly string[];
  readonly missingJourneys: readonly string[];
  readonly rowsBelowFloor: readonly string[];
  readonly subjectCount: number;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function evaluatePersonaStoryCoverage(
  rows: readonly PersonaStoryRow[],
  subjects: readonly CoverageSubject[],
): PersonaStoryCoverageReport {
  const requiredPersonaSlugs = sortedUnique(rows.map((row) => row.personaSlug));
  const requiredJourneys = sortedUnique(
    rows.map((row) => row.journey).filter((journey) => journey.length > 0),
  );

  const coveredPersonaSlugs = sortedUnique(subjects.map((subject) => subject.personaSlug));
  const coveredJourneys = sortedUnique(subjects.flatMap((subject) => subject.journeys));

  const coveredPersonaSet = new Set(coveredPersonaSlugs);
  const coveredJourneySet = new Set(coveredJourneys);

  const rowsBelowFloor: string[] = [];
  for (const row of rows) {
    const declared = new Set(row.requiredFixtureClasses);
    const missing = requiredFixtureClasses.filter((fixtureClass) => !declared.has(fixtureClass));
    if (missing.length > 0) {
      rowsBelowFloor.push(
        `${row.canonicalId}/${row.personaSlug} declares ${row.requiredFixtureClasses.join(';')} ` +
          `— below the floor, missing ${missing.join(', ')}`,
      );
    }
  }

  return {
    requiredPersonaSlugs,
    coveredPersonaSlugs,
    missingPersonaSlugs: requiredPersonaSlugs.filter((slug) => !coveredPersonaSet.has(slug)),
    requiredJourneys,
    coveredJourneys,
    missingJourneys: requiredJourneys.filter((journey) => !coveredJourneySet.has(journey)),
    rowsBelowFloor,
    subjectCount: subjects.length,
  };
}

/** One message per uncovered persona, uncovered journey, and lowered floor. */
export function personaStoryCoverageErrors(report: PersonaStoryCoverageReport): string[] {
  const errors: string[] = [];
  for (const slug of report.missingPersonaSlugs) {
    errors.push(
      `persona "${slug}" is named by the persona x story matrix but no corpus subject plays it`,
    );
  }
  for (const journey of report.missingJourneys) {
    errors.push(
      `journey "${journey}" is named by the persona x story matrix but no corpus subject carries it`,
    );
  }
  errors.push(...report.rowsBelowFloor);
  return errors;
}
