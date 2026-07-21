/**
 * Channel endpoints (WP-013, REQ-ID-017). The gate property of this package:
 * a shared phone or email is NEVER a person. An endpoint carries no person
 * reference; people attach to endpoints through associations, any number of
 * people may share one endpoint, and nothing derivable from endpoint equality
 * can resolve, merge, or transfer anything between the people behind it.
 */

import type { PersonId, TenantId } from '@practicehub/contracts';

import { IdentityInvariantError, assertIdentityId } from './identity.js';
import type { FactVerification } from './identity.js';

export type EndpointKind = 'phone' | 'email';

/** Structurally person-free: the shape has nowhere to put a person id. */
export interface ChannelEndpoint {
  readonly endpointId: string;
  readonly tenantId: TenantId;
  readonly kind: EndpointKind;
  readonly endpointValue: string;
  readonly synthetic: boolean;
}

export type EndpointRelationship = 'self' | 'household' | 'proxy' | 'guarantor' | 'unknown';

export interface EndpointAssociation {
  readonly tenantId: TenantId;
  readonly endpointId: string;
  readonly personId: PersonId;
  readonly relationship: EndpointRelationship;
  readonly verification: FactVerification;
  readonly evidenceRef?: string;
  /** Attribution stays per person: consent/purpose/source never pool on the endpoint. */
  readonly source: string;
  readonly consentRef?: string;
  readonly synthetic: boolean;
}

export function assertEndpointAssociationWellFormed(association: EndpointAssociation): void {
  assertIdentityId(association.tenantId, 'tenantId');
  assertIdentityId(association.endpointId, 'endpointId');
  if (association.verification === 'verified' && !association.evidenceRef) {
    throw new IdentityInvariantError(
      `endpoint association ${association.endpointId}→${association.personId} is verified ` +
        'without evidence (asserted vs verified facts carry evidence)',
    );
  }
  if (!association.source) {
    throw new IdentityInvariantError(
      `endpoint association ${association.endpointId}→${association.personId} must carry ` +
        'its own source attribution (REQ-ID-017 AC-1)',
    );
  }
}

/** The people sharing an endpoint — always a candidate SET, never an identity. */
export function personsSharingEndpoint(
  associations: readonly EndpointAssociation[],
  endpointId: string,
): readonly PersonId[] {
  const persons = new Set<PersonId>();
  for (const association of associations) {
    if (association.endpointId === endpointId) {
      persons.add(association.personId);
    }
  }
  return [...persons].sort();
}

export type OutreachIdentityResolution =
  | {
      readonly kind: 'resolved';
      readonly personId: PersonId;
      readonly basis: 'verified-sole-association';
    }
  | { readonly kind: 'ambiguous'; readonly personIds: readonly PersonId[] }
  | { readonly kind: 'unknown' };

/**
 * Outreach attribution from an endpoint alone resolves ONLY when exactly one
 * person is associated AND that association is verified. Everything else is
 * ambiguous or unknown — each person's consent, purpose, and source stay in
 * their own record until a human resolves ownership (REQ-ID-017 AC-1).
 */
export function resolveOutreachIdentity(
  associations: readonly EndpointAssociation[],
  endpointId: string,
): OutreachIdentityResolution {
  const matching = associations.filter((association) => association.endpointId === endpointId);
  const personIds = personsSharingEndpoint(matching, endpointId);
  if (personIds.length === 0) {
    return { kind: 'unknown' };
  }
  const solePerson = personIds.length === 1 ? personIds[0] : undefined;
  if (
    solePerson !== undefined &&
    matching.every((association) => association.verification === 'verified')
  ) {
    return { kind: 'resolved', personId: solePerson, basis: 'verified-sole-association' };
  }
  return { kind: 'ambiguous', personIds };
}

export interface EndpointOwnershipDispute {
  readonly tenantId: TenantId;
  readonly endpointId: string;
  readonly disputedPersonId: PersonId;
  readonly reportedBy: string;
}

export interface EndpointDisputeDirective {
  readonly suppressOutreachPersonIds: readonly PersonId[];
  readonly endpointId: string;
  readonly resumeRequires: 'human-endpoint-ownership-resolution';
}

/**
 * Wrong-person outreach report (REQ-ID-017 AC-3): the campaign stops for the
 * disputed identity and stays stopped until a human resolves endpoint
 * ownership. The directive is data for the comms consumers; nothing here
 * mutates the associations.
 */
export function disputeEndpointOwnership(
  dispute: EndpointOwnershipDispute,
): EndpointDisputeDirective {
  if (!dispute.reportedBy) {
    throw new IdentityInvariantError('an endpoint-ownership dispute must name its reporter');
  }
  return {
    suppressOutreachPersonIds: [dispute.disputedPersonId],
    endpointId: dispute.endpointId,
    resumeRequires: 'human-endpoint-ownership-resolution',
  };
}
