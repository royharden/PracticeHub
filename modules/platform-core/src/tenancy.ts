import type { LegalEntityId, LocationId, TenantId } from '@practicehub/contracts';

export type TenantStatus = 'active' | 'suspended';
export type LegalEntityType = 'PC' | 'PLLC' | 'LLC' | 'MSO' | 'other';
export type LocationKind = 'physical' | 'virtual';

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const statePattern = /^[A-Z]{2}$/;

export interface Tenant {
  readonly tenantId: TenantId;
  readonly displayName: string;
  readonly status: TenantStatus;
  readonly synthetic: boolean;
}

/**
 * Billing/CPOM entity inside a tenant. A row that declares a `cpomState` is a
 * counsel-ratified config record (R6-SR-110): it must carry a counsel
 * ratification reference before any capability activation keys on it.
 */
export interface LegalEntity {
  readonly legalEntityId: LegalEntityId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly entityType: LegalEntityType;
  readonly cpomState?: string;
  readonly counselRatificationRef?: string;
  readonly synthetic: boolean;
}

export interface Location {
  readonly locationId: LocationId;
  readonly tenantId: TenantId;
  readonly legalEntityId: LegalEntityId;
  readonly name: string;
  readonly stateCode: string;
  readonly kind: LocationKind;
  readonly synthetic: boolean;
}

export class TenancyInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TenancyInvariantError';
  }
}

export function assertTenancyId(value: string, label: string): void {
  if (!idPattern.test(value)) {
    throw new TenancyInvariantError(
      `${label} must match ${idPattern.source}; received ${JSON.stringify(value)}`,
    );
  }
}

export function assertLegalEntityWellFormed(entity: LegalEntity): void {
  assertTenancyId(entity.tenantId, 'tenantId');
  assertTenancyId(entity.legalEntityId, 'legalEntityId');
  if (entity.cpomState !== undefined) {
    if (!statePattern.test(entity.cpomState)) {
      throw new TenancyInvariantError(
        `cpomState must be a two-letter state code; received ${JSON.stringify(entity.cpomState)}`,
      );
    }
    if (!entity.counselRatificationRef) {
      throw new TenancyInvariantError(
        `legal entity ${entity.legalEntityId} declares cpomState ${entity.cpomState} ` +
          'without a counsel ratification reference (R6-SR-110 fails closed)',
      );
    }
  }
}

export function assertLocationWellFormed(location: Location): void {
  assertTenancyId(location.tenantId, 'tenantId');
  assertTenancyId(location.legalEntityId, 'legalEntityId');
  assertTenancyId(location.locationId, 'locationId');
  if (!statePattern.test(location.stateCode)) {
    throw new TenancyInvariantError(
      `stateCode must be a two-letter state code; received ${JSON.stringify(location.stateCode)}`,
    );
  }
}

/**
 * A location belongs to exactly one legal entity in the same tenant. Cross-
 * tenant or cross-entity attachment is a tenancy invariant violation; the
 * database enforces the same rule with a composite foreign key.
 */
export function assertLocationBelongsTo(location: Location, entity: LegalEntity): void {
  if (location.tenantId !== entity.tenantId) {
    throw new TenancyInvariantError(
      `location ${location.locationId} (tenant ${location.tenantId}) cannot attach to ` +
        `legal entity ${entity.legalEntityId} (tenant ${entity.tenantId})`,
    );
  }
  if (location.legalEntityId !== entity.legalEntityId) {
    throw new TenancyInvariantError(
      `location ${location.locationId} references legal entity ${location.legalEntityId}, ` +
        `not ${entity.legalEntityId}`,
    );
  }
}
