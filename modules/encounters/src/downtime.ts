/**
 * Downtime kit (WP-063; REQ-ADM-025). A declared outage activates the paper
 * capture kit and a cached read-only snapshot. Online writes are refused while
 * down; paper captures become a back-entry queue on recovery, and recovery is
 * not complete until every capture is reconciled.
 */

export class DowntimeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DowntimeError';
  }
}

export interface SnapshotRecord {
  readonly kind: 'result' | 'note' | 'medication' | 'appointment';
  readonly recordId: string;
  readonly personId: string;
  readonly summary: string;
}

export const paperForms = [
  'downtime-encounter-note',
  'downtime-medication-administration',
  'downtime-order-requisition',
  'downtime-result-callback-log',
] as const;
export type PaperForm = (typeof paperForms)[number];

export interface PaperCapture {
  readonly captureId: string;
  readonly form: PaperForm;
  readonly personId: string;
  readonly content: string;
  readonly capturedBy: string;
  readonly capturedAt: string;
  readonly backEnteredRef: string | null;
}

export interface Outage {
  readonly outageId: string;
  readonly declaredBy: string;
  readonly reason: string;
  readonly declaredAt: string;
  readonly snapshotTakenAt: string;
  readonly recoveredAt: string | null;
}

export type DowntimeMode = 'online' | 'downtime' | 'recovering';

/**
 * The guard every online write path calls first. The DowntimeKit implements
 * it; EncounterNoteService and MedicationList take it as an optional
 * dependency.
 */
export interface DowntimeWriteGuard {
  assertWritable(): void;
}

function freezeSnapshot(records: readonly SnapshotRecord[]): readonly SnapshotRecord[] {
  return Object.freeze(records.map((record) => Object.freeze({ ...record })));
}

export class DowntimeKit implements DowntimeWriteGuard {
  private mode: DowntimeMode = 'online';
  private outage: Outage | null = null;
  private snapshot: readonly SnapshotRecord[] = [];
  private readonly captures = new Map<string, PaperCapture>();
  private seq = 0;
  /** The capture being back-entered right now; recovering-mode writes are allowed only inside it. */
  private activeBackEntry: string | null = null;

  public constructor(
    public readonly tenantId: string,
    private readonly source: () => readonly SnapshotRecord[],
  ) {}

  public get currentMode(): DowntimeMode {
    return this.mode;
  }

  public declareOutage(declaredBy: string, reason: string, at: string): Outage {
    if (this.mode !== 'online') {
      throw new DowntimeError(`cannot declare an outage while ${this.mode}`);
    }
    if (declaredBy.trim() === '' || reason.trim() === '') {
      throw new DowntimeError('an outage declaration needs a declarer and a reason');
    }
    this.snapshot = freezeSnapshot(this.source());
    this.outage = {
      outageId: `outage-${++this.seq}`,
      declaredBy,
      reason,
      declaredAt: at,
      snapshotTakenAt: at,
      recoveredAt: null,
    };
    this.mode = 'downtime';
    return this.outage;
  }

  /** Read-only cached snapshot for one patient; only available while down. */
  public readSnapshot(personId: string): readonly SnapshotRecord[] {
    if (this.mode !== 'downtime') {
      throw new DowntimeError('the cached snapshot is only served during a declared outage');
    }
    return Object.freeze(this.snapshot.filter((record) => record.personId === personId));
  }

  public availableForms(): readonly PaperForm[] {
    return this.mode === 'downtime' ? paperForms : [];
  }

  /**
   * Guard for every online write path. Refused while down. While recovering,
   * only the back-entry of a paper capture (inside `backEnter`) may write.
   */
  public assertWritable(): void {
    if (this.mode === 'online') {
      return;
    }
    if (this.mode === 'recovering' && this.activeBackEntry !== null) {
      return;
    }
    throw new DowntimeError(`online writes are refused while ${this.mode}; use the paper kit`);
  }

  /**
   * Back-enter one paper capture during recovery: `write` performs the real
   * write (the guard lets it through) and returns the record it created, which
   * reconciles the capture.
   */
  public backEnter(captureId: string, write: () => string): PaperCapture {
    if (this.mode !== 'recovering') {
      throw new DowntimeError('back-entry happens during recovery');
    }
    const capture = this.captures.get(captureId);
    if (capture === undefined) {
      throw new DowntimeError(`unknown paper capture ${captureId}`);
    }
    if (capture.backEnteredRef !== null) {
      throw new DowntimeError(`paper capture ${captureId} is already back-entered`);
    }
    if (this.activeBackEntry !== null) {
      throw new DowntimeError('one back-entry at a time');
    }
    this.activeBackEntry = captureId;
    let ref: string;
    try {
      ref = write();
    } finally {
      this.activeBackEntry = null;
    }
    return this.reconcile(captureId, ref);
  }

  public capturePaper(
    form: PaperForm,
    personId: string,
    content: string,
    capturedBy: string,
    at: string,
  ): PaperCapture {
    if (this.mode !== 'downtime') {
      throw new DowntimeError('paper capture is only open during a declared outage');
    }
    if (content.trim() === '') {
      throw new DowntimeError('a paper capture needs content');
    }
    const capture: PaperCapture = {
      captureId: `paper-${++this.seq}`,
      form,
      personId,
      content,
      capturedBy,
      capturedAt: at,
      backEnteredRef: null,
    };
    this.captures.set(capture.captureId, capture);
    return capture;
  }

  /** End the outage; returns the back-entry queue that must be reconciled. */
  public beginRecovery(at: string): readonly PaperCapture[] {
    if (this.mode !== 'downtime' || this.outage === null) {
      throw new DowntimeError('no declared outage to recover from');
    }
    this.outage = { ...this.outage, recoveredAt: at };
    this.mode = 'recovering';
    this.snapshot = [];
    return this.backEntryQueue();
  }

  public backEntryQueue(): readonly PaperCapture[] {
    return [...this.captures.values()].filter((capture) => capture.backEnteredRef === null);
  }

  public reconcile(captureId: string, backEnteredRef: string): PaperCapture {
    if (this.mode !== 'recovering') {
      throw new DowntimeError('back-entry happens during recovery');
    }
    const capture = this.captures.get(captureId);
    if (capture === undefined) {
      throw new DowntimeError(`unknown paper capture ${captureId}`);
    }
    if (typeof backEnteredRef !== 'string' || backEnteredRef.trim() === '') {
      throw new DowntimeError('reconciliation needs the reference of the back-entered record');
    }
    const next: PaperCapture = { ...capture, backEnteredRef };
    this.captures.set(captureId, next);
    return next;
  }

  /** Return online only when every paper capture has been back-entered. */
  public completeRecovery(): Outage {
    if (this.mode !== 'recovering' || this.outage === null) {
      throw new DowntimeError('not recovering');
    }
    const open = this.backEntryQueue().length;
    if (open > 0) {
      throw new DowntimeError(`${open} paper capture(s) still await back-entry`);
    }
    this.mode = 'online';
    return this.outage;
  }
}

export interface DrillStep {
  readonly step: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface DrillReport {
  readonly passed: boolean;
  readonly steps: readonly DrillStep[];
}

/**
 * Scripted downtime drill against synthetic data: declare, read the snapshot,
 * refuse an online write, capture on paper, recover, back-enter, go online.
 */
export function runDowntimeDrill(kit: DowntimeKit, personId: string, at: string): DrillReport {
  const steps: DrillStep[] = [];
  const attempt = (step: string, fn: () => string): void => {
    try {
      steps.push({ step, ok: true, detail: fn() });
    } catch (error) {
      steps.push({
        step,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };
  attempt(
    'declare',
    () => kit.declareOutage('drill-lead', 'scheduled downtime drill', at).outageId,
  );
  attempt('snapshot', () => {
    const rows = kit.readSnapshot(personId);
    if (rows.length === 0) {
      throw new DowntimeError('snapshot has no rows for the drill patient');
    }
    if (!Object.isFrozen(rows[0])) {
      throw new DowntimeError('snapshot rows are writable');
    }
    return `${rows.length} read-only row(s)`;
  });
  attempt('online-write-refused', () => {
    try {
      kit.assertWritable();
    } catch {
      return 'refused';
    }
    throw new DowntimeError('an online write was accepted during downtime');
  });
  let captureId = '';
  attempt('paper-capture', () => {
    captureId = kit.capturePaper(
      'downtime-encounter-note',
      personId,
      'drill vitals',
      'drill-nurse',
      at,
    ).captureId;
    return captureId;
  });
  attempt('recover', () => `${kit.beginRecovery(at).length} to back-enter`);
  attempt('back-entry', () => kit.reconcile(captureId, `drill-entry-${captureId}`).captureId);
  attempt('online', () => {
    kit.completeRecovery();
    return kit.currentMode;
  });
  return { passed: steps.every((s) => s.ok), steps };
}
