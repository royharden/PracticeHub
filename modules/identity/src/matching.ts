/**
 * Candidate detection and merge-authorization basis (WP-013, REQ-ID-003).
 * Detection may USE endpoint signals (a shared phone raises a candidate);
 * merge AUTHORIZATION may not rest on them (REQ-ID-017 exception: endpoint
 * equality, conversational similarity, or a household address can never
 * authorize an identity merge or transfer consent). Merge EXECUTION —
 * cases, reversible merge/unmerge, lineage — is WP-016; this module exports
 * only the basis guard WP-016 must pass.
 */

import type { PersonId, TenantId } from '@practicehub/contracts';

import { IdentityInvariantError } from './identity.js';
import type { IdentityProvenance, Person } from './identity.js';
import type { PersonName } from './names.js';

export const identityMatchAttributes = [
  'given-name',
  'family-name',
  'birth-date',
  'phone',
  'email',
  'postal-address',
] as const;
export type IdentityMatchAttribute = (typeof identityMatchAttributes)[number];

/**
 * Attributes that can carry a merge decision. Endpoint and household facts
 * are structurally excluded: they detect, they never authorize.
 */
export const mergeSufficientAttributes = ['given-name', 'family-name', 'birth-date'] as const;

export interface IdentityAttributeSet {
  readonly givenName?: string;
  readonly familyName?: string;
  readonly birthDate?: string;
  readonly phone?: string;
  readonly email?: string;
  readonly postalAddress?: string;
}

export interface MatchablePerson {
  readonly person: Person;
  readonly names: readonly PersonName[];
  readonly attributes: IdentityAttributeSet;
}

export interface MatchCandidate {
  readonly personId: PersonId;
  /** Attribute NAMES only — candidate record values are never exposed to the inquirer (REQ-ID-003 exception 1). */
  readonly matchedAttributes: readonly IdentityMatchAttribute[];
  /** True when the match includes at least one non-endpoint, non-household attribute. */
  readonly strong: boolean;
}

const normalize = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : value.trim().toLowerCase() || undefined;

/**
 * A person matches on names through EVERY name record they carry — affirmed
 * or legal. A person presenting either name resolves to their one identity;
 * a name difference alone can never create a second patient (REQ-ID-015
 * exception 1).
 */
function nameMatches(
  candidate: MatchablePerson,
  attribute: 'given-name' | 'family-name',
  value: string,
): boolean {
  const attributeValue =
    attribute === 'given-name'
      ? normalize(candidate.attributes.givenName)
      : normalize(candidate.attributes.familyName);
  if (attributeValue === value) {
    return true;
  }
  return candidate.names.some((name) => {
    const part = attribute === 'given-name' ? name.givenName : name.familyName;
    return normalize(part) === value;
  });
}

export function findIdentityCandidates(
  attributes: IdentityAttributeSet,
  existing: readonly MatchablePerson[],
): readonly MatchCandidate[] {
  const candidates: MatchCandidate[] = [];
  for (const candidate of existing) {
    const matched: IdentityMatchAttribute[] = [];
    const given = normalize(attributes.givenName);
    if (given !== undefined && nameMatches(candidate, 'given-name', given)) {
      matched.push('given-name');
    }
    const family = normalize(attributes.familyName);
    if (family !== undefined && nameMatches(candidate, 'family-name', family)) {
      matched.push('family-name');
    }
    if (
      attributes.birthDate !== undefined &&
      normalize(candidate.attributes.birthDate) === normalize(attributes.birthDate)
    ) {
      matched.push('birth-date');
    }
    if (
      attributes.phone !== undefined &&
      normalize(candidate.attributes.phone) === normalize(attributes.phone)
    ) {
      matched.push('phone');
    }
    if (
      attributes.email !== undefined &&
      normalize(candidate.attributes.email) === normalize(attributes.email)
    ) {
      matched.push('email');
    }
    if (
      attributes.postalAddress !== undefined &&
      normalize(candidate.attributes.postalAddress) === normalize(attributes.postalAddress)
    ) {
      matched.push('postal-address');
    }
    if (matched.length >= 2) {
      const strong = matched.some((attribute) =>
        (mergeSufficientAttributes as readonly string[]).includes(attribute),
      );
      candidates.push({ personId: candidate.person.personId, matchedAttributes: matched, strong });
    }
  }
  return candidates;
}

export type IdentityInquiryOutcome =
  | { readonly outcome: 'provisional-created'; readonly person: Person }
  | {
      readonly outcome: 'possible-match-queue';
      readonly candidates: readonly MatchCandidate[];
      readonly quarantined: true;
      readonly newRecordCreated: false;
    }
  | {
      readonly outcome: 'downtime-hold';
      readonly queuedForReconciliation: true;
      readonly newRecordCreated: false;
    };

export interface IdentityInquiry {
  readonly tenantId: TenantId;
  readonly proposedPersonId: PersonId;
  readonly attributes: IdentityAttributeSet;
  readonly provenance: IdentityProvenance;
}

export interface IdentityInquiryOptions {
  /** When identity resolution is degraded, hold for reconciliation rather than creating an unreviewed duplicate (REQ-ID-005 exception 2). */
  readonly resolverAvailable?: boolean;
}

/**
 * REQ-ID-003: an inquiry yields exactly one of — a single provisional
 * identity (no match), a staff-visible possible-match queue entry (matches
 * exist; neither record is exposed; nothing merges), or a downtime hold.
 */
export function registerIdentityInquiry(
  inquiry: IdentityInquiry,
  existing: readonly MatchablePerson[],
  options: IdentityInquiryOptions = {},
): IdentityInquiryOutcome {
  if (options.resolverAvailable === false) {
    return { outcome: 'downtime-hold', queuedForReconciliation: true, newRecordCreated: false };
  }
  const candidates = findIdentityCandidates(inquiry.attributes, existing);
  if (candidates.length > 0) {
    return {
      outcome: 'possible-match-queue',
      candidates,
      quarantined: true,
      newRecordCreated: false,
    };
  }
  return {
    outcome: 'provisional-created',
    person: {
      personId: inquiry.proposedPersonId,
      tenantId: inquiry.tenantId,
      status: 'provisional',
      provenance: inquiry.provenance,
      synthetic: true,
    },
  };
}

export class MergeGovernanceError extends IdentityInvariantError {
  public constructor(message: string) {
    super(message);
    this.name = 'MergeGovernanceError';
  }
}

export interface MergeAuthorizationBasis {
  readonly comparedAttributes: readonly IdentityMatchAttribute[];
  readonly decidedBy: string;
}

/**
 * REQ-ID-003 AC-2 + REQ-ID-017 exception: a merge decision requires at least
 * two compared identity attributes, an attributed decision maker, and at
 * least one compared attribute from the merge-sufficient set — endpoint
 * equality (phone/email) and household address can never carry the decision,
 * no matter how many of them agree. WP-016 (merge execution) must pass this
 * guard on every merge case.
 */
export function assertMergeAuthorizationBasis(basis: MergeAuthorizationBasis): void {
  if (!basis.decidedBy) {
    throw new MergeGovernanceError('a merge decision must be attributed to its decision maker');
  }
  if (basis.comparedAttributes.length < 2) {
    throw new MergeGovernanceError(
      'a merge decision requires at least two compared identity attributes ' +
        `(received ${String(basis.comparedAttributes.length)})`,
    );
  }
  const sufficient = basis.comparedAttributes.filter((attribute) =>
    (mergeSufficientAttributes as readonly string[]).includes(attribute),
  );
  if (sufficient.length === 0) {
    throw new MergeGovernanceError(
      'endpoint equality or household-address agreement can never authorize an identity ' +
        `merge (compared: ${basis.comparedAttributes.join(', ')})`,
    );
  }
}
