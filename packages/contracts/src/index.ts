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
 * Document ids frozen by WP-024 (docs/contracts/blob-api.md). A DocumentId
 * names a received artifact (fax page-set, portal upload, partner exchange);
 * its bytes live in the object store under a content-addressed BlobRef, and
 * cross-module references pair the id with its tenant id like every id above.
 */
export type DocumentId = string & { readonly __documentId: unique symbol };

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

/**
 * The aggregate an event belongs to. `version` is the aggregate version AFTER
 * this event — the sequence a projection replays in order (ADR-009 Decision 1).
 */
export interface AggregateRef {
  readonly type: string;
  readonly id: string;
  readonly version: number;
}

/** Who produced the event: the module/adapter, and an optional actor reference. */
export interface EventSource {
  readonly module: string;
  readonly actorRef?: string;
}

/**
 * The command/event envelope — FROZEN by WP-021 (docs/contracts/event-spine.md).
 * Architecture: ADR-009 Decision 1. The durable contract of the platform event
 * spine: transport is swappable later (outbox -> broker) without changing this
 * shape. Every field a producer sets is immutable once recorded; current state
 * is always a projection, and out-of-order arrivals reconcile through the
 * declared inbox + `effectiveAt`, never silently.
 *
 * - `eventId` is a ULID (lexicographically sortable by creation time) and the
 *   idempotency anchor consumers dedup on.
 * - `occurredAt`/`recordedAt`/`effectiveAt` separate domain time, system-record
 *   time, and effective-dating so a late or corrected event reconciles
 *   explicitly.
 * - `correlationId` threads a choreography; `causationId` names the event that
 *   caused this one.
 * - `idempotencyKey` is the producer-side key (a ret/replay of the same intent
 *   carries the same key).
 * - `dataClassification` drives egress guards (RSK-09); `retentionClass` maps to
 *   the audit-store record-class vocabulary.
 * - `supersedesEventId`/`reversalOfEventId` are the supersession/reversal
 *   pointers; `externalReceiptRef` records a vendor receipt where a rail
 *   evidenced the effect.
 */
export interface EventEnvelope<TPayload> {
  readonly eventId: EventId;
  readonly tenantId: TenantId;
  readonly legalEntityId?: LegalEntityId;
  readonly type: string;
  readonly aggregate: AggregateRef;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly effectiveAt?: string;
  readonly source: EventSource;
  readonly correlationId?: string;
  readonly causationId?: EventId;
  readonly idempotencyKey: string;
  readonly dataClassification: PhiClass;
  readonly retentionClass?: string;
  readonly supersedesEventId?: EventId;
  readonly reversalOfEventId?: EventId;
  readonly externalReceiptRef?: string;
  readonly payload: TPayload;
  readonly synthetic: true;
}
