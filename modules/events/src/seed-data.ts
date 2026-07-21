/**
 * Synthetic event-spine seed data of record (WP-021). The committed seed file
 * `infra/postgres/seed/012-events-seed.sql` embeds `renderEventsSeedSection`
 * output between the events markers — a drift test compares the file against a
 * fresh emission, and the DB suite re-checks the posture against live Postgres.
 *
 * ULIDs are minted by the deterministic factory (fixed clock + fixed bytes) so
 * the seed reproduces byte-for-byte; the ids advance in mint order.
 *
 * Standing proofs this seed carries (Northwind):
 * - a PUBLISHED, consumed event (delivery published with published_at, one
 *   inbox row) — delivered exactly once (the recovery fence never re-sends it);
 * - a PENDING, unconsumed event awaiting a drain (no inbox row);
 * - a PUBLISHED event carrying an external receipt + correlation id.
 * Riverbend carries a single PENDING event as the standing cross-tenant negative
 * and opposite posture.
 */

import type { EventEnvelope } from '@practicehub/contracts';
import {
  buildEventEnvelope,
  createUlidFactory,
  type EventEnvelopeInput,
} from '@practicehub/platform';

const northwind = 'northwind-synthetic';
const riverbend = 'riverbend-synthetic';

// Deterministic ULID minting: a fixed clock advanced one second per event and a
// fixed random field make every seeded id stable across regenerations.
let seedClock = Date.parse('2026-03-01T00:00:00Z');
const seedFactory = createUlidFactory({
  now: () => seedClock,
  randomBytes: () => Uint8Array.from({ length: 16 }, (_unused, index) => (index * 7 + 3) & 0xff),
});
function mintEventId(): string {
  const id = seedFactory();
  seedClock += 1000;
  return id;
}

export type DeliveryStatusSeed = 'pending' | 'published';

export interface InboxSeed {
  readonly consumer: string;
  readonly outcome: 'processed' | 'skipped';
  readonly processedAt: string;
}

export interface EventsSeedRecord {
  readonly envelope: EventEnvelope<unknown>;
  readonly deliveryStatus: DeliveryStatusSeed;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly publishedAt: string | null;
  readonly inbox: readonly InboxSeed[];
}

interface SeedSpec {
  readonly input: Omit<EventEnvelopeInput<unknown>, 'eventId'>;
  readonly deliveryStatus: DeliveryStatusSeed;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly publishedAt: string | null;
  readonly inbox: readonly InboxSeed[];
}

const seedSpecs: readonly SeedSpec[] = [
  {
    input: {
      tenantId: northwind,
      type: 'consent.recorded',
      aggregate: { type: 'consent-ledger', id: 'np-sam-porter', version: 1 },
      occurredAt: '2026-03-01T00:00:00Z',
      recordedAt: '2026-03-01T00:00:00Z',
      source: { module: 'consent', actorRef: 'synthetic-staff:intake' },
      idempotencyKey: 'consent:np-sam-porter:recorded:0001',
      dataClassification: 'demographic',
      retentionClass: 'consent-artifact',
      payload: { scope: 'sms/treatment', state: 'opted_in' },
      synthetic: true,
    },
    deliveryStatus: 'published',
    attempts: 1,
    nextAttemptAt: '2026-03-01T00:00:00Z',
    publishedAt: '2026-03-01T00:00:05Z',
    inbox: [
      { consumer: 'thread-projector', outcome: 'processed', processedAt: '2026-03-01T00:00:05Z' },
    ],
  },
  {
    input: {
      tenantId: northwind,
      type: 'thread.message-received',
      aggregate: { type: 'thread', id: 'th-0001', version: 2 },
      occurredAt: '2026-03-02T00:00:00Z',
      recordedAt: '2026-03-02T00:00:00Z',
      source: { module: 'comms' },
      idempotencyKey: 'thread:th-0001:message:0002',
      dataClassification: 'PHI',
      payload: { channel: 'sms', direction: 'inbound' },
      synthetic: true,
    },
    deliveryStatus: 'pending',
    attempts: 0,
    nextAttemptAt: '2026-03-02T00:00:00Z',
    publishedAt: null,
    inbox: [],
  },
  {
    input: {
      tenantId: northwind,
      type: 'notification.dispatched',
      aggregate: { type: 'notification', id: 'ntf-0001', version: 1 },
      occurredAt: '2026-03-03T00:00:00Z',
      recordedAt: '2026-03-03T00:00:00Z',
      source: { module: 'comms', actorRef: 'synthetic-system:dispatcher' },
      correlationId: 'saga:onboarding:0001',
      idempotencyKey: 'notification:ntf-0001:dispatch:0001',
      dataClassification: 'demographic',
      externalReceiptRef: 'synthetic-receipt:cpaas-sim-0001',
      payload: { channel: 'sms', template: 'welcome' },
      synthetic: true,
    },
    deliveryStatus: 'published',
    attempts: 1,
    nextAttemptAt: '2026-03-03T00:00:00Z',
    publishedAt: '2026-03-03T00:00:02Z',
    inbox: [
      { consumer: 'audit-mirror', outcome: 'processed', processedAt: '2026-03-03T00:00:02Z' },
    ],
  },
  {
    input: {
      tenantId: riverbend,
      type: 'consent.revoked',
      aggregate: { type: 'consent-ledger', id: 'rb-taylor-quinn', version: 2 },
      occurredAt: '2026-03-01T00:00:00Z',
      recordedAt: '2026-03-01T00:00:00Z',
      source: { module: 'consent' },
      idempotencyKey: 'consent:rb-taylor-quinn:revoked:0001',
      dataClassification: 'demographic',
      payload: { scope: 'sms/marketing', state: 'opted_out' },
      synthetic: true,
    },
    deliveryStatus: 'pending',
    attempts: 0,
    nextAttemptAt: '2026-03-01T00:00:00Z',
    publishedAt: null,
    inbox: [],
  },
];

function buildSeedRecords(): readonly EventsSeedRecord[] {
  return seedSpecs.map((spec) => ({
    envelope: buildEventEnvelope({ ...spec.input, eventId: mintEventId() }),
    deliveryStatus: spec.deliveryStatus,
    attempts: spec.attempts,
    nextAttemptAt: spec.nextAttemptAt,
    publishedAt: spec.publishedAt,
    inbox: spec.inbox,
  }));
}

export interface EventsSeed {
  readonly records: readonly EventsSeedRecord[];
}

export const syntheticEventsSeedV1: EventsSeed = { records: buildSeedRecords() };

export const eventsSeedBeginMarker = '-- events:generated:begin';
export const eventsSeedEndMarker = '-- events:generated:end';

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sqlOptional = (value: string | null | undefined): string =>
  value === null || value === undefined ? 'NULL' : sqlLiteral(value);
const sqlJson = (value: unknown): string => `${sqlLiteral(JSON.stringify(value ?? null))}::jsonb`;

/**
 * Render the synthetic seed as idempotent SQL. Every table inserts with
 * ON CONFLICT DO NOTHING except the delivery projection, which upserts (it is
 * the fold of the drain state). Drift-tested in the unit suite; re-proven
 * against the database by the DB suite.
 */
export function renderEventsSeedSection(seed: EventsSeed): string {
  const outboxRows = seed.records.map((record) => {
    const e = record.envelope;
    return (
      `  (${sqlLiteral(e.tenantId)}, ${sqlLiteral(e.eventId)}, ${sqlOptional(e.legalEntityId)}, ` +
      `${sqlLiteral(e.type)}, ${sqlLiteral(e.aggregate.type)}, ${sqlLiteral(e.aggregate.id)}, ` +
      `${e.aggregate.version}, ${sqlLiteral(e.occurredAt)}, ${sqlLiteral(e.recordedAt)}, ` +
      `${sqlOptional(e.effectiveAt)}, ${sqlLiteral(e.source.module)}, ` +
      `${sqlOptional(e.source.actorRef)}, ${sqlOptional(e.correlationId)}, ` +
      `${sqlOptional(e.causationId)}, ${sqlLiteral(e.idempotencyKey)}, ` +
      `${sqlLiteral(e.dataClassification)}, ${sqlOptional(e.retentionClass)}, ` +
      `${sqlOptional(e.supersedesEventId)}, ${sqlOptional(e.reversalOfEventId)}, ` +
      `${sqlOptional(e.externalReceiptRef)}, ${sqlJson(e.payload)}, true)`
    );
  });
  const deliveryRows = seed.records.map(
    (record) =>
      `  (${sqlLiteral(record.envelope.tenantId)}, ${sqlLiteral(record.envelope.eventId)}, ` +
      `${sqlLiteral(record.deliveryStatus)}, ${record.attempts}, ` +
      `${sqlLiteral(record.nextAttemptAt)}, ${sqlOptional(record.publishedAt)}, true)`,
  );
  const inboxRows = seed.records.flatMap((record) =>
    record.inbox.map(
      (entry) =>
        `  (${sqlLiteral(record.envelope.tenantId)}, ${sqlLiteral(entry.consumer)}, ` +
        `${sqlLiteral(record.envelope.eventId)}, ${sqlLiteral(entry.processedAt)}, ` +
        `${sqlLiteral(entry.outcome)}, true)`,
    ),
  );
  return [
    eventsSeedBeginMarker,
    '-- Generated by @practicehub/events renderEventsSeedSection from',
    '-- syntheticEventsSeedV1. Regenerate on any seed change; the drift test and',
    '-- the DB suite fail on divergence.',
    'INSERT INTO events.outbox',
    '  (tenant_id, event_id, legal_entity_id, type, aggregate_type, aggregate_id,',
    '   aggregate_version, occurred_at, recorded_at, effective_at, source_module,',
    '   source_actor_ref, correlation_id, causation_id, idempotency_key,',
    '   data_classification, retention_class, supersedes_event_id, reversal_of_event_id,',
    '   external_receipt_ref, payload, synthetic)',
    'VALUES',
    outboxRows.join(',\n'),
    'ON CONFLICT (tenant_id, event_id) DO NOTHING;',
    '',
    'INSERT INTO events.outbox_delivery',
    '  (tenant_id, event_id, status, attempts, next_attempt_at, published_at, synthetic)',
    'VALUES',
    deliveryRows.join(',\n'),
    'ON CONFLICT (tenant_id, event_id) DO UPDATE',
    'SET status = EXCLUDED.status,',
    '    attempts = EXCLUDED.attempts,',
    '    next_attempt_at = EXCLUDED.next_attempt_at,',
    '    published_at = EXCLUDED.published_at,',
    '    synthetic = EXCLUDED.synthetic;',
    '',
    'INSERT INTO events.inbox',
    '  (tenant_id, consumer, event_id, processed_at, outcome, synthetic)',
    'VALUES',
    inboxRows.join(',\n'),
    'ON CONFLICT (tenant_id, consumer, event_id) DO NOTHING;',
    eventsSeedEndMarker,
  ].join('\n');
}

/** Extract the generated section from the committed seed file's contents. */
export function extractEventsSeedSection(seedSql: string): string | null {
  const begin = seedSql.indexOf(eventsSeedBeginMarker);
  const end = seedSql.indexOf(eventsSeedEndMarker);
  if (begin === -1 || end === -1 || end < begin) {
    return null;
  }
  return seedSql.slice(begin, end + eventsSeedEndMarker.length);
}
