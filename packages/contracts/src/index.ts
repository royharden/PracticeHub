export type TenantId = string & { readonly __tenantId: unique symbol };
export type EventId = string & { readonly __eventId: unique symbol };
export type LegalEntityId = string & { readonly __legalEntityId: unique symbol };
export type LocationId = string & { readonly __locationId: unique symbol };

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
