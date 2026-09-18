export type FindingCode = 'CORRUPTED_BASELINE' | 'COHORT_PRICE_DRIFT' | 'MISSING_KEY';

export type FindingSeverity = 'blocking' | 'warning';

export interface VintageRow {
  readonly recordRef: string;
  readonly memberRef: string;
  readonly vintageId: string;
  readonly offerRef: string;
  readonly cohortRef: string;
  readonly priceMinor: number;
  readonly currency: string;
}

export interface CohortBaseline {
  readonly cohortRef: string;
  readonly offerRef: string;
  readonly priceMinor: number;
  readonly currency: string;
}

export interface ImportFinding {
  readonly findingRef: string;
  readonly tenantId: string;
  readonly code: FindingCode;
  readonly severity: FindingSeverity;
  readonly recordRef: string | null;
  readonly synthetic: true;
}

export interface MembershipVintageDouble {
  apply(input: {
    readonly tenantId: string;
    readonly batchRef: string;
    readonly row: VintageRow;
  }): void;
  rollback(input: { readonly tenantId: string; readonly batchRef: string }): number;
}

export interface WorkbenchSnapshotDouble {
  freeze(input: { readonly tenantId: string; readonly bytes: Uint8Array }): string;
}

export class VintageImportError extends Error {
  public constructor(
    public readonly code: 'APPLY_BLOCKED' | 'UNKNOWN_BATCH' | 'BASELINE_REQUIRED',
  ) {
    super(code);
    this.name = 'VintageImportError';
  }
}
