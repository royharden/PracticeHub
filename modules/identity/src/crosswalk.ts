/**
 * Source-identifier crosswalk (WP-013, REQ-ID-004 / REQ-ID-005). External
 * systems (athena, Podium-class, HubSpot-class, Stripe, acquired-clinic
 * legacy) reference one enterprise person through governed identifiers; each
 * source id resolves to at most one person, every source id is preserved,
 * and payment-rail references are opaque by construction — the payment
 * processor never carries clinical detail (REQ-ID-004 AC-1; standing Stripe
 * PHI invariant).
 */

import type { PatientRecordId, PersonId, TenantId } from '@practicehub/contracts';

import { IdentityInvariantError, assertIdentityId } from './identity.js';
import type { FactVerification } from './identity.js';

export const sourceSystemPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Systems whose identifiers cross the payment boundary: opaque refs only. */
export const paymentRailSystems: readonly string[] = ['stripe'];

const opaqueReferencePattern = /^[A-Za-z0-9_-]{8,128}$/;
const dateLikePattern = /\d{4}-\d{2}-\d{2}/;

export interface SourceIdentifier {
  readonly tenantId: TenantId;
  readonly sourceSystem: string;
  readonly sourceValue: string;
  readonly personId: PersonId;
  readonly patientRecordId?: PatientRecordId;
  readonly verification: FactVerification;
  readonly evidenceRef?: string;
  readonly provenanceSource: string;
  readonly ingestRef?: string;
  readonly synthetic: boolean;
}

export function assertOpaqueExternalReference(system: string, value: string): void {
  if (!paymentRailSystems.includes(system)) {
    return;
  }
  if (!opaqueReferencePattern.test(value) || dateLikePattern.test(value) || value.includes('@')) {
    throw new IdentityInvariantError(
      `${system} reference must be an opaque token (no names, dates, or contact detail); ` +
        `received ${JSON.stringify(value)}`,
    );
  }
}

export function assertSourceIdentifierWellFormed(identifier: SourceIdentifier): void {
  assertIdentityId(identifier.tenantId, 'tenantId');
  if (!sourceSystemPattern.test(identifier.sourceSystem)) {
    throw new IdentityInvariantError(
      `sourceSystem must match ${sourceSystemPattern.source}; received ` +
        JSON.stringify(identifier.sourceSystem),
    );
  }
  if (!identifier.sourceValue) {
    throw new IdentityInvariantError('sourceValue must be non-empty');
  }
  assertOpaqueExternalReference(identifier.sourceSystem, identifier.sourceValue);
  if (identifier.verification === 'verified' && !identifier.evidenceRef) {
    throw new IdentityInvariantError(
      `source identifier ${identifier.sourceSystem}:${identifier.sourceValue} is verified ` +
        'without evidence',
    );
  }
  if (!identifier.provenanceSource) {
    throw new IdentityInvariantError(
      `source identifier ${identifier.sourceSystem}:${identifier.sourceValue} must carry ` +
        'ingestion provenance',
    );
  }
}

export type SourceLinkOutcome =
  | { readonly outcome: 'linked'; readonly link: SourceIdentifier }
  | {
      /**
       * Payment-to-patient (or any source-to-person) mismatch: the same
       * external id already resolves to a DIFFERENT person. The link is
       * refused, the existing link stays intact for recovery, and the
       * conflict is quarantined for owned reconciliation (REQ-ID-004
       * exception 1) — fulfillment consumers treat this as a block.
       */
      readonly outcome: 'conflict-quarantined';
      readonly existingLink: SourceIdentifier;
      readonly refusedLink: SourceIdentifier;
      readonly existingLinkRetained: true;
    }
  | {
      /**
       * Duplicate arrival of an id already linked to the SAME person: held
       * for staff refund-or-apply review; never a second attachment
       * (REQ-ID-004 exception 2).
       */
      readonly outcome: 'duplicate-held';
      readonly existingLink: SourceIdentifier;
      readonly heldForReview: true;
    };

export function linkSourceIdentifier(
  existingLinks: readonly SourceIdentifier[],
  link: SourceIdentifier,
): SourceLinkOutcome {
  assertSourceIdentifierWellFormed(link);
  const existing = existingLinks.find(
    (candidate) =>
      candidate.tenantId === link.tenantId &&
      candidate.sourceSystem === link.sourceSystem &&
      candidate.sourceValue === link.sourceValue,
  );
  if (existing === undefined) {
    return { outcome: 'linked', link };
  }
  if (existing.personId !== link.personId) {
    return {
      outcome: 'conflict-quarantined',
      existingLink: existing,
      refusedLink: link,
      existingLinkRetained: true,
    };
  }
  return { outcome: 'duplicate-held', existingLink: existing, heldForReview: true };
}

/** REQ-ID-005 AC-1: any preserved source identifier resolves to its one person. */
export function resolvePersonBySourceId(
  links: readonly SourceIdentifier[],
  tenantId: TenantId,
  sourceSystem: string,
  sourceValue: string,
): PersonId | null {
  const link = links.find(
    (candidate) =>
      candidate.tenantId === tenantId &&
      candidate.sourceSystem === sourceSystem &&
      candidate.sourceValue === sourceValue,
  );
  return link?.personId ?? null;
}

/**
 * REQ-ID-004 AC-2: after a buyer converts to a patient identity, the
 * entitlement, payment state, lead source, and communication consent remain
 * SEPARATELY attributable — four distinct references, never one collapsed
 * blob. Fulfillment/entitlement semantics live with their owning modules;
 * this shape is the identity-side attribution record.
 */
export interface BuyerConversionAttribution {
  readonly entitlementRef: string;
  readonly paymentStateRef: string;
  readonly leadSourceRef: string;
  readonly communicationConsentRef: string;
}

export interface BuyerConversion {
  readonly personId: PersonId;
  readonly transactionLink: SourceIdentifier;
  readonly attribution: BuyerConversionAttribution;
}

export function recordBuyerConversion(
  personId: PersonId,
  transactionLink: SourceIdentifier,
  attribution: BuyerConversionAttribution,
): BuyerConversion {
  assertSourceIdentifierWellFormed(transactionLink);
  if (transactionLink.personId !== personId) {
    throw new IdentityInvariantError(
      `conversion for ${personId} references a transaction linked to ${transactionLink.personId}`,
    );
  }
  for (const [field, value] of Object.entries(attribution)) {
    if (!value) {
      throw new IdentityInvariantError(
        `buyer conversion must attribute ${field} distinctly (REQ-ID-004 AC-2)`,
      );
    }
  }
  return { personId, transactionLink, attribution };
}
