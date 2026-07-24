/**
 * Synthetic documents seed data of record (WP-024). The committed seed file
 * `infra/postgres/seed/017-documents-seed.sql` embeds `renderDocumentsSeedSection`
 * output between the documents markers — a drift test compares the file against
 * a fresh emission, and the DB suite re-folds the seeded events against the
 * seeded projection.
 *
 * Standing proofs this seed carries (Northwind), each a distinct owned surface:
 * - a FILED inbound fax matched to a chart (authority-bearing filing at rest);
 * - a QUARANTINED wrong-patient unsolicited record — reason + observed attribute
 *   NAMES only, no PHI value in the queue (REQ-DOC-006);
 * - an UNMATCHED portal upload still WITHIN its hold period (REQ-DOC-010);
 * - an UNMATCHED inbound fax whose hold EXPIRED and was disposed by return to
 *   sender (REQ-DOC-011 — the unknown-patient timer at rest).
 * Riverbend carries an unmatched inbound fax as the standing cross-tenant
 * negative and opposite posture.
 *
 * Only the content-address (blob ref) and sha-256 hash are persisted — the
 * document bytes never enter Postgres. The synthetic content strings below
 * exist only to compute deterministic hashes.
 */

import { blobRefFor, contentByteLength, hashContent } from './blob.js';
import {
  appendDocumentEvent,
  foldDocumentState,
  holdDeadline,
  type DocumentEvent,
  type DocumentEventInput,
  type DocumentSource,
  type DocumentStateRow,
  type ObservableAttributeName,
  type PartitionTag,
} from './document.js';

const northwind = 'northwind-synthetic';
const riverbend = 'riverbend-synthetic';

interface ReceivedSpec {
  readonly eventId: string;
  readonly documentId: string;
  readonly tenantId: string;
  readonly source: DocumentSource;
  readonly content: string;
  readonly mediaType: string;
  readonly pageCount: number;
  readonly occurredAt: string;
  readonly actorRef: string;
  readonly partitionTags?: readonly PartitionTag[];
}

function received(spec: ReceivedSpec): DocumentEventInput {
  const contentHash = hashContent(spec.content);
  return {
    documentEventId: spec.eventId,
    tenantId: spec.tenantId,
    documentId: spec.documentId,
    eventType: 'received',
    actorRef: spec.actorRef,
    occurredAt: spec.occurredAt,
    source: spec.source,
    blobRef: blobRefFor(contentHash),
    contentHash,
    contentBytes: contentByteLength(spec.content),
    mediaType: spec.mediaType,
    pageCount: spec.pageCount,
    ...(spec.partitionTags !== undefined ? { partitionTags: spec.partitionTags } : {}),
    synthetic: true,
  };
}

const seedEventInputs: readonly DocumentEventInput[] = [
  // (1) A filed inbound fax matched to np-sam-porter's chart.
  received({
    eventId: 'nde-0001',
    documentId: 'nd-0001',
    tenantId: northwind,
    source: 'inbound_fax',
    content: 'synthetic-document-bytes:nd-0001:referral-summary',
    mediaType: 'application/pdf',
    pageCount: 3,
    occurredAt: '2026-03-01T09:00:00Z',
    actorRef: 'synthetic-fax-gateway',
  }),
  {
    documentEventId: 'nde-0002',
    tenantId: northwind,
    documentId: 'nd-0001',
    eventType: 'filed',
    actorRef: 'synthetic-staff:records-clerk-001',
    occurredAt: '2026-03-01T10:15:00Z',
    matchedPersonRef: 'np-sam-porter',
    evidenceRef: 'synthetic-doc-evidence:nd-0001-verified-match',
    synthetic: true,
  },
  // (2) A quarantined wrong-patient unsolicited record — attribute NAMES only.
  received({
    eventId: 'nde-0003',
    documentId: 'nd-0002',
    tenantId: northwind,
    source: 'partner_exchange',
    content: 'synthetic-document-bytes:nd-0002:unsolicited-external-records',
    mediaType: 'application/pdf',
    pageCount: 5,
    occurredAt: '2026-03-02T14:00:00Z',
    actorRef: 'synthetic-partner-gateway',
  }),
  {
    documentEventId: 'nde-0004',
    tenantId: northwind,
    documentId: 'nd-0002',
    eventType: 'quarantined',
    actorRef: 'synthetic-staff:records-clerk-001',
    occurredAt: '2026-03-02T14:30:00Z',
    quarantineReason: 'wrong-patient',
    observedAttributeNames: [
      'patient-name',
      'date-of-birth',
      'sender-fax',
    ] as readonly ObservableAttributeName[],
    synthetic: true,
  },
  // (3) An unmatched portal upload still within its hold period.
  received({
    eventId: 'nde-0005',
    documentId: 'nd-0003',
    tenantId: northwind,
    source: 'portal_upload',
    content: 'synthetic-document-bytes:nd-0003:portal-upload-no-match',
    mediaType: 'image/tiff',
    pageCount: 1,
    occurredAt: '2026-03-10T08:00:00Z',
    actorRef: 'synthetic-portal-intake',
  }),
  {
    documentEventId: 'nde-0006',
    tenantId: northwind,
    documentId: 'nd-0003',
    eventType: 'auto_match_failed',
    actorRef: 'synthetic-match-engine',
    occurredAt: '2026-03-10T08:05:00Z',
    holdUntil: holdDeadline('2026-03-10T08:05:00Z'),
    synthetic: true,
  },
  // (4) An unmatched inbound fax whose hold EXPIRED — disposed by return.
  received({
    eventId: 'nde-0007',
    documentId: 'nd-0004',
    tenantId: northwind,
    source: 'inbound_fax',
    content: 'synthetic-document-bytes:nd-0004:overheld-unmatched-fax',
    mediaType: 'application/pdf',
    pageCount: 2,
    occurredAt: '2026-01-05T07:00:00Z',
    actorRef: 'synthetic-fax-gateway',
  }),
  {
    documentEventId: 'nde-0008',
    tenantId: northwind,
    documentId: 'nd-0004',
    eventType: 'auto_match_failed',
    actorRef: 'synthetic-match-engine',
    occurredAt: '2026-01-05T07:05:00Z',
    holdUntil: holdDeadline('2026-01-05T07:05:00Z'),
    synthetic: true,
  },
  {
    documentEventId: 'nde-0009',
    tenantId: northwind,
    documentId: 'nd-0004',
    eventType: 'disposition_decided',
    actorRef: 'synthetic-records-sweep',
    occurredAt: '2026-02-05T07:05:00Z',
    disposition: 'returned',
    evidenceRef: 'synthetic-doc-evidence:nd-0004-return-to-sender',
    synthetic: true,
  },
  // (5) Riverbend cross-tenant negative: an unmatched inbound fax.
  received({
    eventId: 'rde-0001',
    documentId: 'rd-0001',
    tenantId: riverbend,
    source: 'inbound_fax',
    content: 'synthetic-document-bytes:rd-0001:riverbend-unmatched',
    mediaType: 'application/pdf',
    pageCount: 1,
    occurredAt: '2026-03-04T11:00:00Z',
    actorRef: 'synthetic-fax-gateway',
  }),
  {
    documentEventId: 'rde-0002',
    tenantId: riverbend,
    documentId: 'rd-0001',
    eventType: 'auto_match_failed',
    actorRef: 'synthetic-match-engine',
    occurredAt: '2026-03-04T11:05:00Z',
    holdUntil: holdDeadline('2026-03-04T11:05:00Z'),
    synthetic: true,
  },
];

function buildSeedRecords(): readonly DocumentEvent[] {
  let log: readonly DocumentEvent[] = [];
  for (const input of seedEventInputs) {
    ({ log } = appendDocumentEvent(log, input));
  }
  return log;
}

function buildProjection(records: readonly DocumentEvent[]): readonly DocumentStateRow[] {
  return [...foldDocumentState(records).values()].sort((left, right) =>
    `${left.tenantId}|${left.documentId}`.localeCompare(`${right.tenantId}|${right.documentId}`),
  );
}

export interface DocumentsSeed {
  readonly records: readonly DocumentEvent[];
  readonly projection: readonly DocumentStateRow[];
}

const seedRecords = buildSeedRecords();

export const syntheticDocumentsSeedV1: DocumentsSeed = {
  records: seedRecords,
  projection: buildProjection(seedRecords),
};

export const documentsSeedBeginMarker = '-- documents:generated:begin';
export const documentsSeedEndMarker = '-- documents:generated:end';

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sqlOptional = (value: string | undefined): string =>
  value === undefined ? 'NULL' : sqlLiteral(value);
const sqlNumber = (value: number | undefined): string =>
  value === undefined ? 'NULL' : String(value);
const sqlTextArray = (values: readonly string[] | undefined): string =>
  values === undefined
    ? 'NULL'
    : values.length === 0
      ? `'{}'::text[]`
      : `ARRAY[${values.map((value) => sqlLiteral(value)).join(', ')}]::text[]`;

/**
 * Render the synthetic seed as idempotent SQL. Events insert with ON CONFLICT
 * DO NOTHING (the append-only log is never rewritten by a re-seed); the
 * projection upserts — it is the fold of the events, one data source,
 * drift-tested in the unit suite and re-proven against the database by the DB
 * suite's projection-sync test.
 */
export function renderDocumentsSeedSection(seed: DocumentsSeed): string {
  const eventRows = seed.records.map(
    (record) =>
      `  (${sqlLiteral(record.tenantId)}, ${sqlLiteral(record.documentEventId)}, ` +
      `${sqlLiteral(record.documentId)}, ${sqlLiteral(record.eventType)}, ` +
      `${sqlLiteral(record.actorRef)}, ${sqlOptional(record.source)}, ` +
      `${sqlOptional(record.blobRef)}, ${sqlOptional(record.contentHash)}, ` +
      `${sqlNumber(record.contentBytes)}, ${sqlOptional(record.mediaType)}, ` +
      `${sqlNumber(record.pageCount)}, ${sqlTextArray(record.partitionTags ?? [])}, ` +
      `${sqlOptional(record.holdUntil)}, ${sqlOptional(record.matchedPersonRef)}, ` +
      `${sqlOptional(record.quarantineReason)}, ${sqlTextArray(record.observedAttributeNames)}, ` +
      `${sqlOptional(record.disposition)}, ${sqlOptional(record.redirectTarget)}, ` +
      `${sqlOptional(record.evidenceRef)}, ${sqlLiteral(record.occurredAt)}, true)`,
  );
  const stateRows = seed.projection.map(
    (row) =>
      `  (${sqlLiteral(row.tenantId)}, ${sqlLiteral(row.documentId)}, ` +
      `${sqlLiteral(row.status)}, ${sqlLiteral(row.source)}, ` +
      `${sqlLiteral(row.blobRef)}, ${sqlLiteral(row.contentHash)}, ` +
      `${sqlNumber(row.contentBytes)}, ${sqlLiteral(row.mediaType)}, ` +
      `${sqlNumber(row.pageCount)}, ${sqlTextArray(row.partitionTags)}, ` +
      `${sqlLiteral(row.receivedAt)}, ${sqlOptional(row.holdUntil)}, ` +
      `${sqlOptional(row.matchedPersonRef)}, ${sqlOptional(row.quarantineReason)}, ` +
      `${sqlTextArray(row.observedAttributeNames)}, ` +
      `${sqlOptional(row.disposition)}, ${sqlOptional(row.redirectTarget)}, ` +
      `${sqlLiteral(row.lastEventId)}, true)`,
  );
  return [
    documentsSeedBeginMarker,
    '-- Generated by @practicehub/documents renderDocumentsSeedSection from',
    '-- syntheticDocumentsSeedV1. Regenerate on any seed change; the drift test and',
    '-- the DB projection-sync test fail on divergence.',
    'INSERT INTO documents.document_event',
    '  (tenant_id, document_event_id, document_id, event_type, actor_ref, source,',
    '   blob_ref, content_hash, content_bytes, media_type, page_count, partition_tags,',
    '   hold_until, matched_person_ref, quarantine_reason, observed_attribute_names,',
    '   disposition, redirect_target, evidence_ref, occurred_at, synthetic)',
    'VALUES',
    eventRows.join(',\n'),
    'ON CONFLICT (tenant_id, document_event_id) DO NOTHING;',
    '',
    'INSERT INTO documents.document_state',
    '  (tenant_id, document_id, status, source, blob_ref, content_hash, content_bytes,',
    '   media_type, page_count, partition_tags, received_at, hold_until,',
    '   matched_person_ref, quarantine_reason, observed_attribute_names, disposition,',
    '   redirect_target, last_event_id, synthetic)',
    'VALUES',
    stateRows.join(',\n'),
    'ON CONFLICT (tenant_id, document_id) DO UPDATE',
    'SET status = EXCLUDED.status,',
    '    source = EXCLUDED.source,',
    '    blob_ref = EXCLUDED.blob_ref,',
    '    content_hash = EXCLUDED.content_hash,',
    '    content_bytes = EXCLUDED.content_bytes,',
    '    media_type = EXCLUDED.media_type,',
    '    page_count = EXCLUDED.page_count,',
    '    partition_tags = EXCLUDED.partition_tags,',
    '    received_at = EXCLUDED.received_at,',
    '    hold_until = EXCLUDED.hold_until,',
    '    matched_person_ref = EXCLUDED.matched_person_ref,',
    '    quarantine_reason = EXCLUDED.quarantine_reason,',
    '    observed_attribute_names = EXCLUDED.observed_attribute_names,',
    '    disposition = EXCLUDED.disposition,',
    '    redirect_target = EXCLUDED.redirect_target,',
    '    last_event_id = EXCLUDED.last_event_id,',
    '    synthetic = EXCLUDED.synthetic;',
    documentsSeedEndMarker,
  ].join('\n');
}

/** Extract the generated section from the committed seed file's contents. */
export function extractDocumentsSeedSection(seedSql: string): string | null {
  const begin = seedSql.indexOf(documentsSeedBeginMarker);
  const end = seedSql.indexOf(documentsSeedEndMarker);
  if (begin === -1 || end === -1 || end < begin) {
    return null;
  }
  return seedSql.slice(begin, end + documentsSeedEndMarker.length);
}
