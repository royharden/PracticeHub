export class UnattributedReportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'UnattributedReportError';
  }
}

export interface WrongPersonReport {
  readonly tenantId: string;
  readonly endpointId: string;
  readonly disputedPersonId: string;
  readonly reportedBy: string | null;
}

/**
 * NR-024 rehearsal: an unattributed wrong-person report is refused.
 * Does not rewrite modules/identity fixtures.
 */
export function acceptWrongPersonReport(report: WrongPersonReport): {
  readonly suppressed: readonly string[];
} {
  if (report.reportedBy === null || report.reportedBy.trim() === '') {
    throw new UnattributedReportError('unattributed report refused');
  }
  return { suppressed: [report.disputedPersonId] };
}
