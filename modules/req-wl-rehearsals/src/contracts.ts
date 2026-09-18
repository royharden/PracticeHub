export const REHEARSAL_IDENTITY = 'WP-133/REQ-WL';

export class WaitlistRehearsalError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WaitlistRehearsalError';
  }
}

export type RehearsalKind = 'offer' | 'late-accept' | 'priority-hold' | 'recall-noshow';

export interface WaitlistEntry {
  readonly patientId: string;
  readonly priority: number;
  readonly holdExpired: boolean;
  readonly prerequisitePaused: boolean;
  readonly synthetic: true;
}

export interface ScheduleSnapshot {
  readonly slotId: string;
  readonly bookedPatientId: string | null;
  readonly version: number;
}

export interface RehearsalResult {
  readonly kind: RehearsalKind;
  readonly ok: boolean;
  readonly scheduleUnchanged: boolean;
  readonly priorityPreserved: boolean;
}
