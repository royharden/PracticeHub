import {
  WaitlistRehearsalError,
  type RehearsalKind,
  type RehearsalResult,
  type ScheduleSnapshot,
  type WaitlistEntry,
} from './contracts.js';

export function rehearse(
  kind: RehearsalKind,
  entry: WaitlistEntry,
  schedule: ScheduleSnapshot,
): RehearsalResult {
  if (entry.synthetic !== true) {
    throw new WaitlistRehearsalError('NON_SYNTHETIC', entry.patientId);
  }
  if (kind === 'late-accept' && entry.holdExpired) {
    return {
      kind,
      ok: false,
      scheduleUnchanged: true,
      priorityPreserved: true,
    };
  }
  if (kind === 'priority-hold' && entry.prerequisitePaused) {
    return {
      kind,
      ok: true,
      scheduleUnchanged: true,
      priorityPreserved: true,
    };
  }
  if (kind === 'offer' || kind === 'recall-noshow') {
    return {
      kind,
      ok: schedule.bookedPatientId === null,
      scheduleUnchanged: schedule.bookedPatientId !== entry.patientId,
      priorityPreserved: true,
    };
  }
  return { kind, ok: true, scheduleUnchanged: true, priorityPreserved: true };
}

export function assertNoLateMutation(result: RehearsalResult): void {
  if (result.kind === 'late-accept' && result.scheduleUnchanged !== true) {
    throw new WaitlistRehearsalError('LATE_ACCEPT_MUTATED', result.kind);
  }
}
