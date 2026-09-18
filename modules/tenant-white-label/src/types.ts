export interface WhiteLabelBrand {
  readonly wordmark: string;
  readonly primaryColor: string;
}

export interface WhiteLabelHours {
  readonly timezone: string;
  readonly windows: readonly {
    readonly day: string;
    readonly open: string;
    readonly close: string;
  }[];
}

export interface WhiteLabelProfile {
  readonly tenantId: string;
  readonly brand: WhiteLabelBrand;
  readonly hours: WhiteLabelHours;
  readonly templates: { readonly faxCoverRef: string; readonly letterheadRef: string };
  readonly printers: readonly string[];
  readonly faxNumberRef: string;
  readonly synthetic: true;
}

export class WhiteLabelError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WhiteLabelError';
  }
}

export function requireSynthetic(synthetic: boolean): void {
  if (synthetic !== true) {
    throw new WhiteLabelError('white-label facts must be synthetic');
  }
}
