import {
  evaluateEgress,
  type EgressDecision,
  type EgressRequest,
  type VendorRegistryRow,
} from '@practicehub/platform-integration';

const deniedMetadataKeys = new Set([
  'name',
  'email',
  'phone',
  'ssn',
  'dob',
  'diagnosis',
  'note',
  'patient',
  'patientname',
  'mrn',
  'address',
  'clinical',
]);

const opaqueSku = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const skuClinicalToken = /(patient|diagnosis|icd|mrn|phi|ssn)/i;

export interface StripeChargeDraft {
  readonly sku: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly payloadRef: string;
}

export type StripeLintBlock = {
  readonly allow: false;
  readonly reason: 'sku-not-opaque' | 'metadata-denied' | 'egress-blocked';
  readonly detail: string;
  readonly egress: EgressDecision | null;
};

export type StripeLintAllow = {
  readonly allow: true;
  readonly reason: 'permitted';
  readonly egress: EgressDecision;
};

export type StripeLintDecision = StripeLintAllow | StripeLintBlock;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Stripe-specific PHI interceptor. Opaque SKUs + metadata denylist, then the
 * WP-026 vendor-BAA egress guard. Does not replace evaluateEgress.
 */
export function lintStripeCharge(
  draft: StripeChargeDraft,
  row: VendorRegistryRow | null,
  request: EgressRequest,
): StripeLintDecision {
  if (!opaqueSku.test(draft.sku) || skuClinicalToken.test(draft.sku)) {
    return {
      allow: false,
      reason: 'sku-not-opaque',
      detail: 'sku must be an opaque token with no clinical text',
      egress: null,
    };
  }
  for (const key of Object.keys(draft.metadata)) {
    if (deniedMetadataKeys.has(normalizeKey(key))) {
      return {
        allow: false,
        reason: 'metadata-denied',
        detail: `metadata key ${JSON.stringify(key)} is on the Stripe PHI denylist`,
        egress: null,
      };
    }
  }
  if (draft.payloadRef.trim() === '') {
    return {
      allow: false,
      reason: 'sku-not-opaque',
      detail: 'payloadRef is required; clinical content does not travel in metadata',
      egress: null,
    };
  }
  const egress = evaluateEgress(row, request);
  if (!egress.allow) {
    return {
      allow: false,
      reason: 'egress-blocked',
      detail: egress.reason,
      egress,
    };
  }
  return { allow: true, reason: 'permitted', egress };
}
