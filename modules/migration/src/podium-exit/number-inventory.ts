/**
 * Number inventory and LOA tooling (REQ-MIG-004 exception: no number ports,
 * and Podium is not cancelled, without owner-of-record evidence).
 *
 * `assessLoa` checks one letter of authorization against the inventory and
 * the owner-of-record evidence, number by number, and reports which numbers
 * are portable and why each of the others is not.
 */

import type {
  BusinessNumber,
  LetterOfAuthorization,
  NumberServiceProfile,
  OwnerOfRecordEvidence,
} from './types.js';

export interface NumberBlock {
  readonly numberRef: string;
  readonly reasons: readonly string[];
}

export interface LoaAssessment {
  readonly tenantId: string;
  readonly loaRef: string;
  readonly portableNumberRefs: readonly string[];
  readonly blocked: readonly NumberBlock[];
}

const syntheticNumber = /^\+1[2-9][0-9]{2}55501[0-9]{2}$/;

export function assessLoa(
  loa: LetterOfAuthorization,
  inventory: readonly BusinessNumber[],
  evidence: readonly OwnerOfRecordEvidence[],
  profiles: readonly NumberServiceProfile[],
): LoaAssessment {
  if (loa.synthetic !== true) throw new Error('LOA lacks the synthetic watermark');
  const inventoryByRef = new Map<string, BusinessNumber>();
  for (const number of inventory) {
    if (number.synthetic !== true) throw new Error(`${number.numberRef} is not synthetic`);
    if (inventoryByRef.has(number.numberRef)) {
      throw new Error(`number ${number.numberRef} appears twice in the inventory`);
    }
    inventoryByRef.set(number.numberRef, number);
  }
  const counts = new Map<string, number>();
  for (const numberRef of loa.numberRefs) counts.set(numberRef, (counts.get(numberRef) ?? 0) + 1);

  const portable: string[] = [];
  const blocked: NumberBlock[] = [];
  for (const numberRef of [...counts.keys()].sort()) {
    const reasons: string[] = [];
    if (!syntheticNumber.test(numberRef)) reasons.push('number-not-synthetic-fiction-range');
    if ((counts.get(numberRef) ?? 0) > 1) reasons.push('duplicate-number-on-loa');
    const inInventory = inventoryByRef.get(numberRef);
    if (inInventory === undefined) {
      reasons.push('number-not-in-inventory');
    } else if (inInventory.tenantId !== loa.tenantId) {
      reasons.push('number-belongs-to-another-tenant');
    }
    if (loa.signedAt === null) reasons.push('loa-unsigned');
    const owner = evidence.filter((item) => item.numberRef === numberRef);
    if (owner.length === 0) {
      reasons.push('owner-of-record-evidence-missing');
    } else if (owner.length > 1) {
      reasons.push('owner-of-record-evidence-ambiguous');
    } else {
      const [record] = owner;
      if (record !== undefined) {
        if (record.carrierAccountRef !== loa.carrierAccountRef) {
          reasons.push('carrier-account-mismatch');
        }
        if (record.billingNameOnAccount !== loa.billingName) reasons.push('billing-name-mismatch');
        if (record.authorizedSignerRef !== loa.signerRef) reasons.push('signer-not-authorized');
      }
    }
    const profile = profiles.find((item) => item.numberRef === numberRef);
    if (profile === undefined) {
      reasons.push('service-profile-missing');
    } else {
      if (profile.e911AddressRef === null) reasons.push('e911-address-missing');
      if (profile.tenDlcCampaignRef === null) reasons.push('10dlc-campaign-missing');
      if (profile.inboundRouteRef === null) reasons.push('inbound-route-missing');
      if (profile.forwardingFallbackRef === null) reasons.push('rollback-fallback-missing');
    }
    if (reasons.length === 0) {
      portable.push(numberRef);
    } else {
      blocked.push({ numberRef, reasons });
    }
  }
  return { tenantId: loa.tenantId, loaRef: loa.loaRef, portableNumberRefs: portable, blocked };
}
