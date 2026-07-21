export type TenantId = string & { readonly __tenantId: unique symbol };
export type EventId = string & { readonly __eventId: unique symbol };
export type LegalEntityId = string & { readonly __legalEntityId: unique symbol };
export type LocationId = string & { readonly __locationId: unique symbol };

/**
 * Identity ids frozen by WP-013 (docs/contracts/identity-types.md). A Person
 * is a human; roles, endpoints, and source identifiers are distinct objects
 * that reference persons — cross-module references always pair the id with
 * its tenant id, exactly like the tenancy ids above.
 */
export type PersonId = string & { readonly __personId: unique symbol };
export type PatientRecordId = string & { readonly __patientRecordId: unique symbol };

/**
 * The only shape module APIs accept for tenancy scoping — frozen by WP-010
 * (docs/contracts/tenancy-types.md). Cross-module references to tenancy rows
 * always pair the id with its tenant id.
 */
export interface TenancyContext {
  readonly tenantId: TenantId;
  readonly legalEntityId?: LegalEntityId;
  readonly locationId?: LocationId;
}

export type PhiClass = 'none' | 'demographic' | 'PHI' | 'PHI-restricted' | 'secret';

export interface EventEnvelope<TPayload> {
  readonly eventId: EventId;
  readonly tenantId: TenantId;
  readonly type: string;
  readonly payload: TPayload;
  readonly synthetic: true;
}
