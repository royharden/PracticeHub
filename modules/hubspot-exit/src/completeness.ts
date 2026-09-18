import {
  HubspotExitError,
  objectKinds,
  phiGradeFields,
  type CompletenessReport,
  type ExitRecord,
  type ObjectKind,
} from './contracts.js';

export function verifyCompleteness(records: readonly ExitRecord[]): CompletenessReport {
  const counts = {
    objects: 0,
    owners: 0,
    sequences: 0,
    notes: 0,
  } satisfies Record<ObjectKind, number>;
  const missingPhi: string[] = [];
  for (const record of records) {
    counts[record.kind] += 1;
    for (const field of phiGradeFields) {
      if (record[field].trim() === '') {
        missingPhi.push(`${record.kind}:${record.recordId}:${field}`);
      }
    }
  }
  const complete =
    objectKinds.every((kind) => counts[kind] > 0) && missingPhi.length === 0;
  return { counts, missingPhi, complete };
}

export function assertComplete(report: CompletenessReport): void {
  if (report.complete !== true) {
    throw new HubspotExitError('INCOMPLETE_EXPORT', report.missingPhi.join(',') || 'empty-kind');
  }
}
