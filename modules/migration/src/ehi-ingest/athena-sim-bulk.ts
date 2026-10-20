import { athenaSimBulkSourceRef, EhiIngestError, sha256 } from './shapes.js';
import {
  ehiResourceKinds,
  type EhiBulkExport,
  type EhiBulkPage,
  type EhiResourceKind,
  type EhiSourceRecord,
} from './types.js';

/**
 * Placeholder for the Athena bulk + delta source (EW-ATH-01, external wait; WP-114
 * replaces it through FWD-MIG-114-ATHENA-PARITY). Deterministic, synthetic-only and
 * in-process: it makes no network call and holds no real vendor data.
 */
export interface AthenaSimBulkOptions {
  readonly tenantId: string;
  readonly patientCount: number;
  /** Kinds whose bulk pages are emitted structurally unreadable. */
  readonly corruptKinds?: readonly EhiResourceKind[];
  /** Drift mutations injected on each successive tick until the schedule runs out. */
  readonly driftSchedule?: readonly number[];
}

function pad(value: number): string {
  return String(value).padStart(4, '0');
}

function recordKey(kind: EhiResourceKind, sourceRecordRef: string): string {
  return `${kind}|${sourceRecordRef}`;
}

export class AthenaSimBulk {
  public readonly sourceSystemRef = athenaSimBulkSourceRef;
  readonly #tenantId: string;
  readonly #records = new Map<string, EhiSourceRecord>();
  readonly #corruptKinds: ReadonlySet<EhiResourceKind>;
  readonly #driftSchedule: readonly number[];
  #tick = 0;
  #mutation = 0;
  #frozen = false;

  public constructor(options: AthenaSimBulkOptions) {
    if (!Number.isInteger(options.patientCount) || options.patientCount < 1) {
      throw new EhiIngestError('athena-sim-bulk needs a positive integer patient count');
    }
    this.#tenantId = options.tenantId;
    this.#corruptKinds = new Set(options.corruptKinds ?? []);
    this.#driftSchedule = options.driftSchedule ?? [];
    for (let index = 1; index <= options.patientCount; index += 1) {
      this.#seedPatient(index);
    }
  }

  public get tenantId(): string {
    return this.#tenantId;
  }

  public get frozen(): boolean {
    return this.#frozen;
  }

  #put(kind: EhiResourceKind, sourceRecordRef: string, values: Record<string, string>): void {
    this.#records.set(recordKey(kind, sourceRecordRef), {
      tenantId: this.#tenantId,
      kind,
      sourceRecordRef,
      values,
      synthetic: true,
    });
  }

  #seedPatient(index: number): void {
    const patient = `ath-pt-${pad(index)}`;
    this.#put('patient', patient, {
      'patient-id': patient,
      'given-name': `Synth${pad(index)}`,
      'family-name': 'Testpatient',
      'birth-date': `19${String(50 + (index % 45)).padStart(2, '0')}-0${1 + (index % 9)}-1${index % 9}`,
      sex: index % 2 === 0 ? 'F' : 'M',
      'legacy-chart-note': `synthetic note ${pad(index)}`,
    });
    const encounter = `ath-enc-${pad(index)}-1`;
    this.#put('encounter', encounter, {
      'encounter-id': encounter,
      'patient-id': patient,
      'start-date': '2025-03-14',
      'encounter-type': 'office-visit',
      'rendering-provider-ref': 'prov:synthetic-001',
    });
    const problem = `ath-prob-${pad(index)}-1`;
    this.#put('problem', problem, {
      'problem-id': problem,
      'patient-id': patient,
      code: 'SYN-I10',
      'onset-date': '2020-01-01',
      status: 'active',
    });
    const medication = `ath-med-${pad(index)}-1`;
    this.#put('medication', medication, {
      'medication-id': medication,
      'patient-id': patient,
      'rx-code': 'SYN-RX-314',
      'start-date': '2021-06-01',
      status: 'active',
    });
  }

  /** A frozen source is immutable: every mutation path refuses (cutover freeze is binding). */
  #assertMutable(operation: string): void {
    if (this.#frozen) {
      throw new EhiIngestError(`athena-sim-bulk is frozen for cutover; ${operation} refused`);
    }
  }

  /** Overwrites one record's values (test hook for bad-data and drift vectors). Refused once frozen. */
  public setRecord(
    kind: EhiResourceKind,
    sourceRecordRef: string,
    values: Record<string, string>,
  ): void {
    this.#assertMutable('setRecord');
    this.#put(kind, sourceRecordRef, values);
  }

  /** Removes one record. Refused once frozen. */
  public removeRecord(kind: EhiResourceKind, sourceRecordRef: string): void {
    this.#assertMutable('removeRecord');
    this.#records.delete(recordKey(kind, sourceRecordRef));
  }

  /** Live source read used by the delta harness. Sorted for determinism. */
  public currentRecords(): readonly EhiSourceRecord[] {
    return [...this.#records.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, record]) => record);
  }

  public exportBulk(exportRef: string, pageSize = 25): EhiBulkExport {
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new EhiIngestError('page size must be a positive integer');
    }
    const records = this.currentRecords();
    const pages: EhiBulkPage[] = [];
    for (const kind of ehiResourceKinds) {
      const ofKind = records.filter((record) => record.kind === kind);
      for (let start = 0; start < ofKind.length; start += pageSize) {
        pages.push({
          pageRef: `${exportRef}:${kind}:${start / pageSize + 1}`,
          kind,
          structurallyReadable: !this.#corruptKinds.has(kind),
          records: ofKind.slice(start, start + pageSize),
        });
      }
    }
    return {
      tenantId: this.#tenantId,
      sourceSystemRef: this.sourceSystemRef,
      exportRef,
      exportHash: sha256(records),
      pages,
      synthetic: true,
    };
  }

  /**
   * Simulates source activity between delta passes. Returns the number of
   * mutations injected; zero once the schedule is spent or the source is frozen.
   */
  public tick(): number {
    const planned = this.#frozen ? 0 : (this.#driftSchedule[this.#tick] ?? 0);
    this.#tick += 1;
    for (let count = 0; count < planned; count += 1) {
      this.#mutate();
    }
    return planned;
  }

  #mutate(): void {
    this.#mutation += 1;
    const step = this.#mutation;
    const patients = this.currentRecords().filter((record) => record.kind === 'patient');
    const target = patients[step % Math.max(1, patients.length)];
    if (target === undefined) {
      return;
    }
    const patientRef = target.sourceRecordRef;
    switch (step % 3) {
      case 0: {
        this.#put('patient', patientRef, {
          ...target.values,
          'family-name': `Testpatient-r${step}`,
        });
        return;
      }
      case 1: {
        const encounter = `ath-enc-drift-${pad(step)}`;
        this.#put('encounter', encounter, {
          'encounter-id': encounter,
          'patient-id': patientRef,
          'start-date': '2026-01-02',
          'encounter-type': 'telehealth',
        });
        return;
      }
      default: {
        const problem = this.currentRecords().find(
          (record) => record.kind === 'problem' && record.values['patient-id'] === patientRef,
        );
        if (problem !== undefined) {
          this.#records.delete(recordKey('problem', problem.sourceRecordRef));
        }
      }
    }
  }

  /** Cutover freeze: the source stops changing, so a delta pass can reach zero. */
  public freeze(): void {
    this.#frozen = true;
  }
}
