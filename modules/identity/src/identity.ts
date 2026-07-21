/**
 * Identity model of record (WP-013). Contract: docs/contracts/identity-types.md
 * (FROZEN). Architecture: ADR-005 Decision 3, adopted from the CDX normative
 * identity contracts near-verbatim:
 *
 *   Person (a human) ≠ role (PatientRecord / StaffAccount / GuarantorRole /
 *   ProxyGrant) ≠ ChannelEndpoint (a shared phone or email is never a person)
 *   ≠ SourceIdentifier (external-system ids in a governed crosswalk).
 *
 * Asserted vs verified facts carry evidence: anything `verified` must name
 * its evidence reference, enforced here and by DB CHECK constraints in
 * modules/identity/migrations/0004-identity.sql.
 */

import type {
  LegalEntityId,
  LocationId,
  PatientRecordId,
  PersonId,
  TenantId,
} from '@practicehub/contracts';

export class IdentityInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'IdentityInvariantError';
  }
}

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export function assertIdentityId(value: string, label: string): void {
  if (!idPattern.test(value)) {
    throw new IdentityInvariantError(
      `${label} must match ${idPattern.source}; received ${JSON.stringify(value)}`,
    );
  }
}

export type PersonStatus = 'provisional' | 'verified';
export type FactVerification = 'asserted' | 'verified';

/**
 * Provenance every identity fact carries (REQ-ID-003 AC-3): where the fact
 * came from, who captured it, and the consent context it arrived under.
 * Timestamps are database-stamped on the persisted rows.
 */
export interface IdentityProvenance {
  readonly source: string;
  readonly capturedBy: string;
  readonly consentRef?: string;
}

export interface Person {
  readonly personId: PersonId;
  readonly tenantId: TenantId;
  readonly status: PersonStatus;
  /** Identity-proofing evidence; required whenever status is `verified`. */
  readonly verificationEvidenceRef?: string;
  readonly birthDate?: string;
  readonly provenance: IdentityProvenance;
  readonly synthetic: boolean;
}

export function assertPersonWellFormed(person: Person): void {
  assertIdentityId(person.tenantId, 'tenantId');
  assertIdentityId(person.personId, 'personId');
  if (person.status === 'verified' && !person.verificationEvidenceRef) {
    throw new IdentityInvariantError(
      `person ${person.personId} is verified without identity-proofing evidence ` +
        '(asserted vs verified facts carry evidence; ADR-005 Decision 3)',
    );
  }
  if (person.birthDate !== undefined && !isoDatePattern.test(person.birthDate)) {
    throw new IdentityInvariantError(
      `person ${person.personId} birthDate must be an ISO date; received ` +
        JSON.stringify(person.birthDate),
    );
  }
  if (!person.provenance.source || !person.provenance.capturedBy) {
    throw new IdentityInvariantError(
      `person ${person.personId} must retain source and capture provenance (REQ-ID-003 AC-3)`,
    );
  }
}

/**
 * A person's patient role inside one tenant. One patient record per person
 * per tenant — the longitudinal identity across locations (REQ-ID-005);
 * acquisitions that surface the same human twice create duplicate PERSONS
 * for governed merge review (WP-016), never a second record on one person.
 */
export interface PatientRecord {
  readonly patientRecordId: PatientRecordId;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly legalEntityId: LegalEntityId;
  readonly homeLocationId?: LocationId;
  readonly status: 'active' | 'inactive';
  readonly synthetic: boolean;
}

export interface StaffAccount {
  readonly staffAccountId: string;
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly status: 'active' | 'suspended' | 'offboarded';
  readonly synthetic: boolean;
}

/**
 * Financial-responsibility role (guarantor ≠ patient ≠ person). Scoped and
 * evidenced; granting or changing it never merges the people involved.
 */
export interface GuarantorRole {
  readonly guarantorRoleId: string;
  readonly tenantId: TenantId;
  readonly guarantorPersonId: PersonId;
  readonly patientRecordId: PatientRecordId;
  readonly scope: readonly string[];
  readonly evidenceRef: string;
  readonly status: 'active' | 'ended';
  readonly endedReason?: string;
  readonly synthetic: boolean;
}

export function assertGuarantorRoleWellFormed(role: GuarantorRole): void {
  assertIdentityId(role.tenantId, 'tenantId');
  assertIdentityId(role.guarantorRoleId, 'guarantorRoleId');
  if (role.scope.length === 0) {
    throw new IdentityInvariantError(
      `guarantor role ${role.guarantorRoleId} must declare a non-empty scope`,
    );
  }
  if (!role.evidenceRef) {
    throw new IdentityInvariantError(
      `guarantor role ${role.guarantorRoleId} requires an evidence reference`,
    );
  }
  if (role.status === 'ended' && !role.endedReason) {
    throw new IdentityInvariantError(
      `guarantor role ${role.guarantorRoleId} ended without a recorded reason`,
    );
  }
}

/**
 * Proxy authority is scoped AND expiring by construction (ADR-005 Decision 3)
 * — an unbounded proxy grant is unrepresentable.
 */
export interface ProxyGrant {
  readonly proxyGrantId: string;
  readonly tenantId: TenantId;
  readonly granteePersonId: PersonId;
  readonly subjectPersonId: PersonId;
  readonly scope: readonly string[];
  readonly expiresOn: string;
  readonly evidenceRef: string;
  readonly status: 'active' | 'revoked' | 'expired';
  readonly synthetic: boolean;
}

export function assertProxyGrantWellFormed(grant: ProxyGrant): void {
  assertIdentityId(grant.tenantId, 'tenantId');
  assertIdentityId(grant.proxyGrantId, 'proxyGrantId');
  if (grant.granteePersonId === grant.subjectPersonId) {
    throw new IdentityInvariantError(
      `proxy grant ${grant.proxyGrantId} cannot grant a person authority over themselves`,
    );
  }
  if (grant.scope.length === 0) {
    throw new IdentityInvariantError(
      `proxy grant ${grant.proxyGrantId} must declare a non-empty scope`,
    );
  }
  if (!isoDatePattern.test(grant.expiresOn)) {
    throw new IdentityInvariantError(
      `proxy grant ${grant.proxyGrantId} must carry an ISO expiry date; received ` +
        JSON.stringify(grant.expiresOn),
    );
  }
  if (!grant.evidenceRef) {
    throw new IdentityInvariantError(
      `proxy grant ${grant.proxyGrantId} requires an evidence reference`,
    );
  }
}

/**
 * Demographic reconciliation never overwrites (REQ-ID-005 exception 1):
 * conflicting incoming values open a review with both values retained; a
 * correction is a staff decision, not an ingest side effect.
 */
export interface DemographicConflict {
  readonly field: string;
  readonly currentValue: string;
  readonly incomingValue: string;
}

export type DemographicReconciliation =
  | { readonly outcome: 'no-conflict' }
  | {
      readonly outcome: 'review-required';
      readonly conflicts: readonly DemographicConflict[];
      readonly sourceValuesRetained: true;
    };

export function reconcileDemographics(
  current: Readonly<Record<string, string | undefined>>,
  incoming: Readonly<Record<string, string | undefined>>,
): DemographicReconciliation {
  const conflicts: DemographicConflict[] = [];
  for (const [field, incomingValue] of Object.entries(incoming)) {
    const currentValue = current[field];
    if (
      currentValue !== undefined &&
      incomingValue !== undefined &&
      currentValue !== incomingValue
    ) {
      conflicts.push({ field, currentValue, incomingValue });
    }
  }
  if (conflicts.length === 0) {
    return { outcome: 'no-conflict' };
  }
  return { outcome: 'review-required', conflicts, sourceValuesRetained: true };
}
