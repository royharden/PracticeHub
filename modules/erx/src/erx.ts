/** Medication list owned by WP-062. This module does not rebuild it. */
export interface MedicationListPlaceholder {
  readonly packageId: 'WP-062';
  readonly typeName: 'MedicationList';
  readonly fixtureId: 'wp062-medication-list';
}

export const wp062MedicationListPlaceholder: MedicationListPlaceholder = {
  packageId: 'WP-062',
  typeName: 'MedicationList',
  fixtureId: 'wp062-medication-list',
};

export const fixtureVendorId = 'fixture-vendor';

export interface JurisdictionRule {
  readonly jurisdiction: string;
  readonly transmitLegal: boolean;
}

/** XX is the fixture jurisdiction that must block a transmit. */
export const jurisdictionFixture: readonly JurisdictionRule[] = [
  { jurisdiction: 'FL', transmitLegal: true },
  { jurisdiction: 'XX', transmitLegal: false },
];

export type ErxKind = 'new' | 'refill' | 'renewal';

export interface ErxQueueItem {
  readonly itemId: string;
  readonly kind: 'refill' | 'renewal';
  readonly medicationRef: string;
}

export class ErxError extends Error {
  public constructor(public readonly code: 'UNKNOWN_VENDOR') {
    super(code);
    this.name = 'ErxError';
  }
}

export class ErxEmbed {
  readonly refillQueue: ErxQueueItem[] = [];
  readonly renewalQueue: ErxQueueItem[] = [];

  public transmit(input: {
    readonly vendorId: string;
    readonly kind: ErxKind;
    readonly jurisdiction: string;
    readonly itemId: string;
    readonly medicationRef: string;
  }):
    { readonly completed: true } | { readonly completed: false; readonly blocked: 'jurisdiction' } {
    if (input.vendorId !== fixtureVendorId) throw new ErxError('UNKNOWN_VENDOR');
    const rule = jurisdictionFixture.find((item) => item.jurisdiction === input.jurisdiction);
    if (rule === undefined || !rule.transmitLegal) {
      return { completed: false, blocked: 'jurisdiction' };
    }
    if (input.kind === 'refill') {
      this.refillQueue.push({
        itemId: input.itemId,
        kind: 'refill',
        medicationRef: input.medicationRef,
      });
    } else if (input.kind === 'renewal') {
      this.renewalQueue.push({
        itemId: input.itemId,
        kind: 'renewal',
        medicationRef: input.medicationRef,
      });
    }
    return { completed: true };
  }
}
