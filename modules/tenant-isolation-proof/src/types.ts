export interface WhiteLabelProfile {
  readonly tenantId: string;
  readonly brandName: string;
  readonly jurisdiction: string;
  readonly paletteRef: string;
}

export interface IsolatedRecord {
  readonly tenantId: string;
  readonly recordId: string;
  readonly kind: string;
}

export class IsolationError extends Error {
  public constructor(public readonly code: 'UNKNOWN_TENANT' | 'CROSS_TENANT' | 'NOT_FOUND') {
    super(code);
    this.name = 'IsolationError';
  }
}
