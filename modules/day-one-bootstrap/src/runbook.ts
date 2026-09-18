import {
  DayOneError,
  RUNBOOK_IDENTITY,
  requiredSurfaces,
  type RunbookResult,
  type SurfaceRecord,
} from './contracts.js';

export function evaluateRunbook(records: readonly SurfaceRecord[]): RunbookResult {
  const present: Array<(typeof requiredSurfaces)[number]> = [];
  for (const record of records) {
    if (record.synthetic !== true) {
      throw new DayOneError('NON_SYNTHETIC', record.surface);
    }
    if (record.ready === true && !present.includes(record.surface)) {
      present.push(record.surface);
    }
  }
  const missing = requiredSurfaces.filter((surface) => !present.includes(surface));
  return {
    identity: RUNBOOK_IDENTITY,
    present,
    missing,
    complete: missing.length === 0,
  };
}

export function assertComplete(result: RunbookResult): void {
  if (result.complete !== true) {
    throw new DayOneError('MISSING_SURFACE', result.missing.join(','));
  }
}
