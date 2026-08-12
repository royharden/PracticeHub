/**
 * Synthea import (WP-029; synthetic-data-plan §3.2 "clinical backbone import",
 * §4 "schema mapping ... and a quarantine path for unmappable rows").
 *
 * A real Synthea run needs a Java toolchain and a pinned upstream release —
 * an acquisition this build has not made (`SRC acquisitions`). So the PORT is
 * declared here, by the consumer, and `sims/synthea-runner` implements it with
 * a deterministic in-repo stub. Swapping the stub for a real runner is a port
 * implementation, not a change to this file: the importer only ever sees export
 * ROWS, never a runner.
 *
 * The mapping fails closed. A row that does not resolve to a corpus subject, or
 * that is missing a required field, is QUARANTINED rather than partially
 * imported with a guessed mapping — and a quarantine record carries the
 * observed attribute NAMES only, never their values (the WP-024 discipline:
 * a value smuggled in as a name is refused).
 */

export interface SyntheaRunRequest {
  readonly seed: string;
  readonly populationSize: number;
  /** Subject ids the export must be keyed to; the runner emits one row set per id. */
  readonly subjectRefs: readonly string[];
  readonly simulatedClockEpoch: string;
  /** Structural: a runner that is not synthetic-only cannot be asked to run. */
  readonly synthetic: true;
}

export interface SyntheaPatientRow {
  readonly subjectRef: string;
  readonly birthDate: string;
  readonly residenceState: string;
  readonly city: string;
}

export interface SyntheaConditionRow {
  readonly subjectRef: string;
  readonly code: string;
  readonly description: string;
  readonly onsetDate: string;
}

export interface SyntheaMedicationRow {
  readonly subjectRef: string;
  readonly code: string;
  readonly description: string;
  readonly startDate: string;
}

export interface SyntheaEncounterRow {
  readonly subjectRef: string;
  readonly encounterRef: string;
  readonly encounterClass: string;
  readonly startDate: string;
}

export interface SyntheaExport {
  readonly generator: { readonly name: string; readonly version: string };
  readonly seed: string;
  readonly patients: readonly SyntheaPatientRow[];
  readonly conditions: readonly SyntheaConditionRow[];
  readonly medications: readonly SyntheaMedicationRow[];
  readonly encounters: readonly SyntheaEncounterRow[];
  readonly synthetic: true;
}

/** The replaceable clinical-backbone source. `sims/synthea-runner` implements it. */
export interface SyntheaRunnerPort {
  run(request: SyntheaRunRequest): SyntheaExport;
}

export interface ClinicalBackboneEntry {
  readonly subjectRef: string;
  readonly conditions: readonly { readonly code: string; readonly onsetDate: string }[];
  readonly medications: readonly { readonly code: string; readonly startDate: string }[];
  readonly encounters: readonly {
    readonly encounterRef: string;
    readonly encounterClass: string;
    readonly startDate: string;
  }[];
  readonly synthetic: true;
}

export type QuarantineReason =
  | 'unresolved-subject'
  | 'missing-required-field'
  | 'unmapped-code'
  | 'structurally-unreadable-export';

export interface ImportQuarantineRecord {
  readonly rowRef: string;
  readonly rowKind: 'patient' | 'condition' | 'medication' | 'encounter' | 'export';
  readonly reason: QuarantineReason;
  /**
   * Attribute NAMES that drove the quarantine. Never values — a quarantine
   * queue is a triage surface, not a second copy of the record.
   */
  readonly observedAttributeNames: readonly string[];
  readonly synthetic: true;
}

export interface SyntheaImportResult {
  readonly backbone: readonly ClinicalBackboneEntry[];
  readonly quarantine: readonly ImportQuarantineRecord[];
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Attribute names admissible in a quarantine record. A caller that passes a
 * VALUE where a name belongs is refused — the same structural rule the document
 * quarantine engine enforces, applied at the import boundary.
 */
const knownAttributeNames: ReadonlySet<string> = new Set([
  'subjectRef',
  'birthDate',
  'residenceState',
  'city',
  'code',
  'description',
  'onsetDate',
  'startDate',
  'encounterRef',
  'encounterClass',
  'patients',
  'conditions',
  'medications',
  'encounters',
]);

export function assertObservedAttributeNames(names: readonly string[]): void {
  if (names.length === 0) {
    throw new Error('a quarantine record must name at least one observed attribute');
  }
  const unknown = names.filter((name) => !knownAttributeNames.has(name));
  if (unknown.length > 0) {
    throw new Error(
      `quarantine records carry attribute NAMES only; ${JSON.stringify(unknown)} ` +
        'is not a known attribute name of a Synthea export row',
    );
  }
}

function quarantine(
  rowRef: string,
  rowKind: ImportQuarantineRecord['rowKind'],
  reason: QuarantineReason,
  observedAttributeNames: readonly string[],
): ImportQuarantineRecord {
  assertObservedAttributeNames(observedAttributeNames);
  return { rowRef, rowKind, reason, observedAttributeNames, synthetic: true };
}

/**
 * Map a Synthea export onto the corpus clinical backbone.
 *
 * `knownSubjectRefs` is the set of corpus subjects the export may attach to.
 * Anything outside it is quarantined: an orphaned clinical row is exactly the
 * acquired-clinic defect the migration dry-run has to surface, so the corpus
 * carries it on purpose rather than dropping it silently.
 */
export function importSyntheaExport(
  exported: SyntheaExport,
  knownSubjectRefs: readonly string[],
  permittedCodes: {
    readonly conditions: readonly string[];
    readonly medications: readonly string[];
  },
): SyntheaImportResult {
  const quarantined: ImportQuarantineRecord[] = [];

  if (exported.synthetic !== true) {
    throw new Error('importSyntheaExport: refuses an export without the synthetic watermark');
  }
  if (!Array.isArray(exported.patients)) {
    return {
      backbone: [],
      quarantine: [quarantine('export', 'export', 'structurally-unreadable-export', ['patients'])],
    };
  }

  const known = new Set(knownSubjectRefs);
  const conditionCodes = new Set(permittedCodes.conditions);
  const medicationCodes = new Set(permittedCodes.medications);

  const accepted = new Map<
    string,
    {
      conditions: { code: string; onsetDate: string }[];
      medications: { code: string; startDate: string }[];
      encounters: { encounterRef: string; encounterClass: string; startDate: string }[];
    }
  >();

  for (const patient of exported.patients) {
    if (!known.has(patient.subjectRef)) {
      quarantined.push(
        quarantine(patient.subjectRef, 'patient', 'unresolved-subject', ['subjectRef']),
      );
      continue;
    }
    const missing: string[] = [];
    if (!isoDatePattern.test(patient.birthDate)) {
      missing.push('birthDate');
    }
    if (patient.residenceState.length === 0) {
      missing.push('residenceState');
    }
    if (missing.length > 0) {
      quarantined.push(
        quarantine(patient.subjectRef, 'patient', 'missing-required-field', missing),
      );
      continue;
    }
    accepted.set(patient.subjectRef, { conditions: [], medications: [], encounters: [] });
  }

  for (const row of exported.conditions) {
    const target = accepted.get(row.subjectRef);
    if (!target) {
      quarantined.push(
        quarantine(`${row.subjectRef}/${row.code}`, 'condition', 'unresolved-subject', [
          'subjectRef',
        ]),
      );
      continue;
    }
    if (!conditionCodes.has(row.code)) {
      quarantined.push(
        quarantine(`${row.subjectRef}/${row.code}`, 'condition', 'unmapped-code', ['code']),
      );
      continue;
    }
    target.conditions.push({ code: row.code, onsetDate: row.onsetDate });
  }

  for (const row of exported.medications) {
    const target = accepted.get(row.subjectRef);
    if (!target) {
      quarantined.push(
        quarantine(`${row.subjectRef}/${row.code}`, 'medication', 'unresolved-subject', [
          'subjectRef',
        ]),
      );
      continue;
    }
    if (!medicationCodes.has(row.code)) {
      quarantined.push(
        quarantine(`${row.subjectRef}/${row.code}`, 'medication', 'unmapped-code', ['code']),
      );
      continue;
    }
    target.medications.push({ code: row.code, startDate: row.startDate });
  }

  for (const row of exported.encounters) {
    const target = accepted.get(row.subjectRef);
    if (!target) {
      quarantined.push(
        quarantine(row.encounterRef, 'encounter', 'unresolved-subject', ['subjectRef']),
      );
      continue;
    }
    target.encounters.push({
      encounterRef: row.encounterRef,
      encounterClass: row.encounterClass,
      startDate: row.startDate,
    });
  }

  const backbone: ClinicalBackboneEntry[] = [...accepted.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([subjectRef, rows]) => ({
      subjectRef,
      conditions: rows.conditions,
      medications: rows.medications,
      encounters: rows.encounters,
      synthetic: true,
    }));

  return { backbone, quarantine: quarantined };
}
