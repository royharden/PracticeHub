/**
 * Event envelope construction + validation (WP-021). Contract:
 * docs/contracts/event-spine.md (FROZEN); shape frozen in
 * `@practicehub/contracts` (`EventEnvelope`). Architecture: ADR-009 Decision 1.
 *
 * Pure over caller-supplied values: `buildEventEnvelope` validates every field
 * and returns the frozen envelope, and `canonicalEnvelope` is the stable
 * serialization the outbox hashes and replay-equivalence compares. Ids are
 * ULIDs; timestamps are UTC instants; refs are grammar-checked so prose (and
 * with it raw PHI) has no field to land in outside the classified `payload`.
 */

import type {
  AggregateRef,
  EventEnvelope,
  EventId,
  EventSource,
  LegalEntityId,
  PhiClass,
  TenantId,
} from '@practicehub/contracts';

import { isUlid } from './ulid.js';

const phiClasses: readonly PhiClass[] = ['none', 'demographic', 'PHI', 'PHI-restricted', 'secret'];

/** Ref grammar (shared with the audit store): lower-case ids/refs, never prose. */
const refPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const typePattern = /^[a-z0-9][a-z0-9.-]{0,127}$/;
const aggregateTypePattern = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const idempotencyKeyPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
// UTC instants, whole-second or millisecond precision — a round-trip through a
// timestamptz reproduces one of these forms exactly.
const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

export class EventEnvelopeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EventEnvelopeError';
  }
}

/** A build input carries the same fields as the envelope minus the guarantees. */
export interface EventEnvelopeInput<TPayload> {
  readonly eventId: string;
  readonly tenantId: string;
  readonly legalEntityId?: string;
  readonly type: string;
  readonly aggregate: AggregateRef;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly effectiveAt?: string;
  readonly source: EventSource;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly idempotencyKey: string;
  readonly dataClassification: PhiClass;
  readonly retentionClass?: string;
  readonly supersedesEventId?: string;
  readonly reversalOfEventId?: string;
  readonly externalReceiptRef?: string;
  readonly payload: TPayload;
  readonly synthetic: true;
}

function assertUlid(value: string, label: string): void {
  if (!isUlid(value)) {
    throw new EventEnvelopeError(`${label} must be a ULID; received ${JSON.stringify(value)}`);
  }
}

function assertMatch(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) {
    throw new EventEnvelopeError(
      `${label} must match ${pattern.source}; received ${JSON.stringify(value)}`,
    );
  }
}

function assertInstant(value: string, label: string): void {
  if (!isoInstantPattern.test(value)) {
    throw new EventEnvelopeError(
      `${label} must be a UTC instant (YYYY-MM-DDTHH:MM:SS[.mmm]Z); received ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Validate every field of a would-be envelope. Fails closed (throws) before any
 * envelope is produced — an event that cannot be validated is never emitted.
 */
export function validateEventEnvelope<TPayload>(input: EventEnvelopeInput<TPayload>): void {
  assertUlid(input.eventId, 'eventId');
  assertMatch(input.tenantId, idPattern, 'tenantId');
  if (input.legalEntityId !== undefined) {
    assertMatch(input.legalEntityId, idPattern, 'legalEntityId');
  }
  assertMatch(input.type, typePattern, 'type');
  assertMatch(input.aggregate.type, aggregateTypePattern, 'aggregate.type');
  assertMatch(input.aggregate.id, refPattern, 'aggregate.id');
  if (!Number.isInteger(input.aggregate.version) || input.aggregate.version < 0) {
    throw new EventEnvelopeError(
      `aggregate.version must be a non-negative integer; received ${input.aggregate.version}`,
    );
  }
  assertInstant(input.occurredAt, 'occurredAt');
  assertInstant(input.recordedAt, 'recordedAt');
  if (input.effectiveAt !== undefined) {
    assertInstant(input.effectiveAt, 'effectiveAt');
  }
  assertMatch(input.source.module, idPattern, 'source.module');
  if (input.source.actorRef !== undefined) {
    assertMatch(input.source.actorRef, refPattern, 'source.actorRef');
  }
  if (input.correlationId !== undefined) {
    assertMatch(input.correlationId, refPattern, 'correlationId');
  }
  if (input.causationId !== undefined) {
    assertUlid(input.causationId, 'causationId');
  }
  assertMatch(input.idempotencyKey, idempotencyKeyPattern, 'idempotencyKey');
  if (!(phiClasses as readonly string[]).includes(input.dataClassification)) {
    throw new EventEnvelopeError(
      `dataClassification must be one of ${phiClasses.join('/')}; received ${JSON.stringify(input.dataClassification)}`,
    );
  }
  if (input.retentionClass !== undefined) {
    assertMatch(input.retentionClass, idPattern, 'retentionClass');
  }
  if (input.supersedesEventId !== undefined) {
    assertUlid(input.supersedesEventId, 'supersedesEventId');
  }
  if (input.reversalOfEventId !== undefined) {
    assertUlid(input.reversalOfEventId, 'reversalOfEventId');
  }
  if (input.externalReceiptRef !== undefined) {
    assertMatch(input.externalReceiptRef, refPattern, 'externalReceiptRef');
  }
  if (input.payload === undefined) {
    throw new EventEnvelopeError(
      'envelope payload must be present (use null for an empty payload)',
    );
  }
  if (input.synthetic !== true) {
    throw new EventEnvelopeError(
      'event envelopes carry the synthetic watermark in this environment',
    );
  }
}

/**
 * Build a frozen envelope from a validated input. `exactOptionalPropertyTypes`
 * requires optional fields to be omitted rather than set to undefined, so each
 * is spread in only when present.
 */
export function buildEventEnvelope<TPayload>(
  input: EventEnvelopeInput<TPayload>,
): EventEnvelope<TPayload> {
  validateEventEnvelope(input);
  return {
    eventId: input.eventId as EventId,
    tenantId: input.tenantId as TenantId,
    ...(input.legalEntityId !== undefined
      ? { legalEntityId: input.legalEntityId as LegalEntityId }
      : {}),
    type: input.type,
    aggregate: input.aggregate,
    occurredAt: input.occurredAt,
    recordedAt: input.recordedAt,
    ...(input.effectiveAt !== undefined ? { effectiveAt: input.effectiveAt } : {}),
    source: input.source,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    ...(input.causationId !== undefined ? { causationId: input.causationId as EventId } : {}),
    idempotencyKey: input.idempotencyKey,
    dataClassification: input.dataClassification,
    ...(input.retentionClass !== undefined ? { retentionClass: input.retentionClass } : {}),
    ...(input.supersedesEventId !== undefined
      ? { supersedesEventId: input.supersedesEventId as EventId }
      : {}),
    ...(input.reversalOfEventId !== undefined
      ? { reversalOfEventId: input.reversalOfEventId as EventId }
      : {}),
    ...(input.externalReceiptRef !== undefined
      ? { externalReceiptRef: input.externalReceiptRef }
      : {}),
    payload: input.payload,
    synthetic: true,
  };
}

/**
 * Stable serialization of the envelope's identity + routing fields (payload is
 * hashed by value at the end). Two envelopes with the same fields serialize
 * identically regardless of key order — the surface the outbox hashes and
 * replay-equivalence compares.
 */
export function canonicalEnvelope<TPayload>(envelope: EventEnvelope<TPayload>): string {
  return JSON.stringify([
    envelope.eventId,
    envelope.tenantId,
    envelope.legalEntityId ?? null,
    envelope.type,
    [envelope.aggregate.type, envelope.aggregate.id, envelope.aggregate.version],
    envelope.occurredAt,
    envelope.recordedAt,
    envelope.effectiveAt ?? null,
    [envelope.source.module, envelope.source.actorRef ?? null],
    envelope.correlationId ?? null,
    envelope.causationId ?? null,
    envelope.idempotencyKey,
    envelope.dataClassification,
    envelope.retentionClass ?? null,
    envelope.supersedesEventId ?? null,
    envelope.reversalOfEventId ?? null,
    envelope.externalReceiptRef ?? null,
    envelope.payload ?? null,
  ]);
}
