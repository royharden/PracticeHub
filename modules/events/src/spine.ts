/**
 * Event-spine domain types + envelope<->row mapping (WP-021, M05). Contract:
 * docs/contracts/event-spine.md (FROZEN). Architecture: ADR-009.
 *
 * The pure seam between the frozen `EventEnvelope` (packages/contracts) and the
 * `events.outbox` row shape (migrations/0010-events.sql). No IO here — the
 * async repository (store.ts) uses these mappers so the column order lives in
 * exactly one place and a claimed row round-trips back to an envelope.
 */

import type { EventEnvelope } from '@practicehub/contracts';
import { buildEventEnvelope, type EventEnvelopeInput } from '@practicehub/platform';

export class EventSpineError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EventSpineError';
  }
}

/** The `events.outbox` insert columns, in order (the single source of order). */
export const outboxColumns = [
  'tenant_id',
  'event_id',
  'legal_entity_id',
  'type',
  'aggregate_type',
  'aggregate_id',
  'aggregate_version',
  'occurred_at',
  'recorded_at',
  'effective_at',
  'source_module',
  'source_actor_ref',
  'correlation_id',
  'causation_id',
  'idempotency_key',
  'data_classification',
  'retention_class',
  'supersedes_event_id',
  'reversal_of_event_id',
  'external_receipt_ref',
  'payload',
  'synthetic',
] as const;

/**
 * Ordered parameter values for an `events.outbox` INSERT of one envelope.
 * `recorded_at` is carried explicitly (not left to the DB default) so an
 * enqueue is fully reproducible; the payload is passed as a JSON string for the
 * jsonb column. Absent optional fields are null.
 */
export function outboxInsertParams<TPayload>(envelope: EventEnvelope<TPayload>): unknown[] {
  return [
    envelope.tenantId,
    envelope.eventId,
    envelope.legalEntityId ?? null,
    envelope.type,
    envelope.aggregate.type,
    envelope.aggregate.id,
    envelope.aggregate.version,
    envelope.occurredAt,
    envelope.recordedAt,
    envelope.effectiveAt ?? null,
    envelope.source.module,
    envelope.source.actorRef ?? null,
    envelope.correlationId ?? null,
    envelope.causationId ?? null,
    envelope.idempotencyKey,
    envelope.dataClassification,
    envelope.retentionClass ?? null,
    envelope.supersedesEventId ?? null,
    envelope.reversalOfEventId ?? null,
    envelope.externalReceiptRef ?? null,
    JSON.stringify(envelope.payload ?? null),
    envelope.synthetic,
  ];
}

/** The columns a drain claim reads back (envelope fields + delivery state). */
export interface ClaimedDeliveryRow {
  readonly tenant_id: string;
  readonly event_id: string;
  readonly legal_entity_id: string | null;
  readonly type: string;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly occurred_at_iso: string;
  readonly recorded_at_iso: string;
  readonly effective_at_iso: string | null;
  readonly source_module: string;
  readonly source_actor_ref: string | null;
  readonly correlation_id: string | null;
  readonly causation_id: string | null;
  readonly idempotency_key: string;
  readonly data_classification: string;
  readonly retention_class: string | null;
  readonly supersedes_event_id: string | null;
  readonly reversal_of_event_id: string | null;
  readonly external_receipt_ref: string | null;
  readonly payload: unknown;
  readonly status: string;
  readonly attempts: number;
}

/**
 * Rebuild the frozen envelope from a claimed row (`buildEventEnvelope`
 * re-validates, so a row that somehow violated a grammar is caught on read).
 * The DB returns UTC instants pre-formatted (the `*_iso` columns).
 */
export function envelopeFromClaim(row: ClaimedDeliveryRow): EventEnvelope<unknown> {
  const input: EventEnvelopeInput<unknown> = {
    eventId: row.event_id,
    tenantId: row.tenant_id,
    ...(row.legal_entity_id !== null ? { legalEntityId: row.legal_entity_id } : {}),
    type: row.type,
    aggregate: { type: row.aggregate_type, id: row.aggregate_id, version: row.aggregate_version },
    occurredAt: row.occurred_at_iso,
    recordedAt: row.recorded_at_iso,
    ...(row.effective_at_iso !== null ? { effectiveAt: row.effective_at_iso } : {}),
    source: {
      module: row.source_module,
      ...(row.source_actor_ref !== null ? { actorRef: row.source_actor_ref } : {}),
    },
    ...(row.correlation_id !== null ? { correlationId: row.correlation_id } : {}),
    ...(row.causation_id !== null ? { causationId: row.causation_id } : {}),
    idempotencyKey: row.idempotency_key,
    dataClassification:
      row.data_classification as EventEnvelopeInput<unknown>['dataClassification'],
    ...(row.retention_class !== null ? { retentionClass: row.retention_class } : {}),
    ...(row.supersedes_event_id !== null ? { supersedesEventId: row.supersedes_event_id } : {}),
    ...(row.reversal_of_event_id !== null ? { reversalOfEventId: row.reversal_of_event_id } : {}),
    ...(row.external_receipt_ref !== null ? { externalReceiptRef: row.external_receipt_ref } : {}),
    payload: row.payload,
    synthetic: true,
  };
  return buildEventEnvelope(input);
}
