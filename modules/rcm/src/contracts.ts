/** Stands for package WP-056, the M19 double-entry ledger. */
export const WP056_PACKAGE_ID = 'WP-056' as const;

export const WP056_FIXTURE_RELATIVE = 'fixtures/wp-056-ledger.json';

/** Stands for package WP-066, the eRx vendor embed. */
export const WP066_PACKAGE_ID = 'WP-066' as const;

export const WP066_FIXTURE_RELATIVE = 'fixtures/wp-066-medication.json';

/** Stands for package WP-062, the encounter charge source. Not rebuilt here. */
export const WP062_PACKAGE_ID = 'WP-062' as const;

export const WP062_FIXTURE_RELATIVE = 'fixtures/wp-062-charges.json';

export const CONTINUITY_GAP_THRESHOLD_DAYS = 3;

/** Stands for package WP-040, the scheduling core. */
export const WP040_PACKAGE_ID = 'WP-040' as const;

export const WP040_FIXTURE_RELATIVE = 'fixtures/wp-040-coverage.json';

export type EligibilityCheckpoint = 'booking' | 't48' | 'day-of';

export type MirrorKind = '835' | '837';

export class RcmShadowError extends Error {
  public constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RcmShadowError';
  }
}

export interface MirrorBody {
  readonly tenantId: string;
  readonly kind: MirrorKind;
  readonly controlNumber: string;
  readonly amountMinor: number;
  readonly currency: 'USD';
  readonly payload: string;
}

export interface ShadowCredential {
  readonly class: 'shadow';
  readonly credentialId: string;
}

export interface LiveRailCredential {
  readonly class: 'live';
  readonly credentialId: string;
  readonly railId: string;
}

export type PresentedCredential = ShadowCredential | LiveRailCredential;

export interface Wp056LedgerPosting {
  readonly packageId: typeof WP056_PACKAGE_ID;
  readonly postingId: string;
  readonly tenantId: string;
  readonly amountMinor: number;
  readonly currency: 'USD';
  readonly sourceSeal: string;
}

export interface Wp056LedgerFixture {
  readonly packageId: typeof WP056_PACKAGE_ID;
  readonly standsFor: string;
  readonly postings: readonly Wp056LedgerPosting[];
}

export interface Wp056LedgerPort {
  readonly packageId: typeof WP056_PACKAGE_ID;
  record(posting: Wp056LedgerPosting): Wp056LedgerPosting;
  postings(): readonly Wp056LedgerPosting[];
}

export interface Wp040CoverageAnswer {
  readonly packageId: typeof WP040_PACKAGE_ID;
  readonly appointmentId: string;
  readonly tenantId: string;
  readonly checkpoint: EligibilityCheckpoint;
  readonly serviceAt: string;
}

export interface Wp040CoverageFixture {
  readonly packageId: typeof WP040_PACKAGE_ID;
  readonly standsFor: string;
  readonly answers: readonly Wp040CoverageAnswer[];
}

export interface Wp066MedicationSource {
  readonly packageId: typeof WP066_PACKAGE_ID;
  readonly medicationId: string;
  readonly tenantId: string;
  readonly daysOfSupplyRemaining: number;
  readonly nextFillInDays: number;
  readonly interimSource: string | null;
}

export interface Wp066MedicationFixture {
  readonly packageId: typeof WP066_PACKAGE_ID;
  readonly standsFor: string;
  readonly sources: readonly Wp066MedicationSource[];
}

export interface Wp062EncounterCharge {
  readonly packageId: typeof WP062_PACKAGE_ID;
  readonly encounterId: string;
  readonly tenantId: string;
  readonly chargeId: string;
  readonly amountMinor: number;
  readonly currency: 'USD';
}

export interface Wp062ChargeFixture {
  readonly packageId: typeof WP062_PACKAGE_ID;
  readonly standsFor: string;
  readonly expected: readonly Wp062EncounterCharge[];
}

export interface SealedMirror {
  readonly seal: string;
  readonly canonical: string;
  readonly body: MirrorBody;
  readonly credential: ShadowCredential;
  readonly ledgerPosting: Wp056LedgerPosting | null;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function assertMirrorBody(body: MirrorBody): void {
  if (!TOKEN.test(body.tenantId)) {
    throw new RcmShadowError('INVALID_TENANT', 'tenantId must be a token');
  }
  if (body.kind !== '835' && body.kind !== '837') {
    throw new RcmShadowError('INVALID_KIND', 'kind must be 835 or 837');
  }
  if (!TOKEN.test(body.controlNumber)) {
    throw new RcmShadowError('INVALID_CONTROL', 'controlNumber must be a token');
  }
  if (!Number.isSafeInteger(body.amountMinor) || body.amountMinor < 0) {
    throw new RcmShadowError('INVALID_AMOUNT', 'amountMinor must be a non-negative safe integer');
  }
  if (body.currency !== 'USD') {
    throw new RcmShadowError('INVALID_CURRENCY', 'currency must be USD');
  }
  if (body.payload.length === 0 || body.payload.length > 4000) {
    throw new RcmShadowError('INVALID_PAYLOAD', 'payload must be a non-empty synthetic string');
  }
}

export function mirrorKey(body: Pick<MirrorBody, 'tenantId' | 'kind' | 'controlNumber'>): string {
  return `${body.tenantId}\u001f${body.kind}\u001f${body.controlNumber}`;
}
