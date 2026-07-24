/**
 * Synthetic documents-records seed data of record (WP-025). The committed seed
 * file `infra/postgres/seed/018-documents-records-seed.sql` embeds
 * `renderDocumentsRecordsSeedSection` output between the markers — a drift test
 * compares the file against a fresh emission.
 *
 * Standing proofs this seed carries (Northwind), each a distinct owned surface:
 * - a VERSION lineage with a superseding correction — the source version is
 *   PRESERVED beside the correction (REQ-DOC-003, HIPAA §164.526);
 * - a DENIED correction that lands the patient's statement of disagreement while
 *   the source stays the current version (REQ-DOC-003 exception);
 * - an E-SIGN executed version carrying a signature evidence chain (D5.4);
 * - a GENETIC-tagged search-index row that a non-genetic-cleared search never
 *   surfaces (REQ-DOC-013/016 partition-scoped-search negative);
 * - a completed records DISCLOSURE whose accounting excludes the genetic artifact
 *   (no send-time authorization) and is CLOSED with delivery evidence
 *   (REQ-DOC-002 disclosure proof + REQ-DOC-013 accounting + REQ-DOC-016 scope).
 * Riverbend carries a version, a search row, and a still-transmitting disclosure
 * as the standing cross-tenant negatives and opposite posture.
 *
 * Only content-addresses (blob refs) and sha-256 hashes are persisted — document
 * bytes never enter Postgres. The synthetic content strings exist only to
 * compute deterministic hashes.
 */

import { blobRefFor, contentByteLength, hashContent } from './blob.js';
import {
  appendDocumentVersion,
  type DocumentVersion,
  type DocumentVersionInput,
  type DocumentVersionKind,
  type RecordsDisclosure,
  type SearchIndexEntry,
} from './records.js';
import type { SignatureEvidence, SignatureMethod } from './esign-port.js';

const northwind = 'northwind-synthetic';
const riverbend = 'riverbend-synthetic';

interface VersionSpec {
  readonly eventId: string;
  readonly tenantId: string;
  readonly documentId: string;
  readonly versionNo: number;
  readonly kind: DocumentVersionKind;
  readonly content: string;
  readonly mediaType: string;
  readonly occurredAt: string;
  readonly actorRef: string;
  readonly supersedesVersionNo?: number;
  readonly concernsVersionNo?: number;
  readonly reasonRef?: string;
  readonly signature?: SignatureEvidence;
}

function versionInput(spec: VersionSpec): DocumentVersionInput {
  const contentHash = hashContent(spec.content);
  return {
    versionEventId: spec.eventId,
    tenantId: spec.tenantId,
    documentId: spec.documentId,
    versionNo: spec.versionNo,
    kind: spec.kind,
    blobRef: blobRefFor(contentHash),
    contentHash,
    contentBytes: contentByteLength(spec.content),
    mediaType: spec.mediaType,
    ...(spec.supersedesVersionNo !== undefined
      ? { supersedesVersionNo: spec.supersedesVersionNo }
      : {}),
    ...(spec.concernsVersionNo !== undefined ? { concernsVersionNo: spec.concernsVersionNo } : {}),
    ...(spec.reasonRef !== undefined ? { reasonRef: spec.reasonRef } : {}),
    ...(spec.signature !== undefined ? { signature: spec.signature } : {}),
    actorRef: spec.actorRef,
    occurredAt: spec.occurredAt,
    synthetic: true,
  };
}

function signedEvidence(spec: {
  readonly requestId: string;
  readonly documentId: string;
  readonly versionNo: number;
  readonly content: string;
  readonly signerRefs: readonly string[];
  readonly method: SignatureMethod;
  readonly signedAt: string;
}): SignatureEvidence {
  return {
    requestId: spec.requestId,
    tenantId: northwind,
    documentId: spec.documentId,
    versionNo: spec.versionNo,
    status: 'signed',
    signerRefs: spec.signerRefs,
    method: spec.method,
    certificateHash: hashContent(`synthetic-esign-cert:${spec.requestId}:${spec.content}`),
    signedAt: spec.signedAt,
    evidenceRef: `synthetic-esign-evidence:${spec.requestId}`,
    synthetic: true,
  };
}

const versionSpecs: readonly VersionSpec[] = [
  // (1) nd-0001 (a filed inbound fax): original then an accepted correction that
  // supersedes it — the source (v1) stays preserved in the lineage.
  {
    eventId: 'ndv-0001',
    tenantId: northwind,
    documentId: 'nd-0001',
    versionNo: 1,
    kind: 'original',
    content: 'synthetic-document-bytes:nd-0001-v1:referral-summary',
    mediaType: 'application/pdf',
    occurredAt: '2026-03-01T10:20:00Z',
    actorRef: 'synthetic-staff:records-clerk-001',
  },
  {
    eventId: 'ndv-0002',
    tenantId: northwind,
    documentId: 'nd-0001',
    versionNo: 2,
    kind: 'correction',
    content: 'synthetic-document-bytes:nd-0001-v2:referral-summary-corrected',
    mediaType: 'application/pdf',
    occurredAt: '2026-03-05T11:00:00Z',
    actorRef: 'synthetic-staff:records-clerk-001',
    supersedesVersionNo: 1,
    reasonRef: 'synthetic-correction-request:nd-0001-wrong-dob',
  },
  // (2) nd-0005 (a records document): original then a DENIED correction — the
  // patient's statement of disagreement is appended and the source stays current.
  {
    eventId: 'ndv-0003',
    tenantId: northwind,
    documentId: 'nd-0005',
    versionNo: 1,
    kind: 'original',
    content: 'synthetic-document-bytes:nd-0005-v1:visit-note',
    mediaType: 'application/pdf',
    occurredAt: '2026-03-08T09:00:00Z',
    actorRef: 'synthetic-provider:dr-lee',
  },
  {
    eventId: 'ndv-0004',
    tenantId: northwind,
    documentId: 'nd-0005',
    versionNo: 2,
    kind: 'statement-of-disagreement',
    content: 'synthetic-document-bytes:nd-0005-v2:patient-statement-of-disagreement',
    mediaType: 'application/pdf',
    occurredAt: '2026-03-12T14:00:00Z',
    actorRef: 'synthetic-patient:np-sam-porter',
    concernsVersionNo: 1,
  },
  // (3) nd-0006 (a consent form): original then an e-sign execution carrying its
  // signature evidence chain (transmission-is-not-closure — only a signed
  // outcome becomes a version).
  {
    eventId: 'ndv-0005',
    tenantId: northwind,
    documentId: 'nd-0006',
    versionNo: 1,
    kind: 'original',
    content: 'synthetic-document-bytes:nd-0006-v1:consent-form-unsigned',
    mediaType: 'application/pdf',
    occurredAt: '2026-03-09T08:00:00Z',
    actorRef: 'synthetic-portal-intake',
  },
  {
    eventId: 'ndv-0006',
    tenantId: northwind,
    documentId: 'nd-0006',
    versionNo: 2,
    kind: 'esign-execution',
    content: 'synthetic-document-bytes:nd-0006-v2:consent-form-signed',
    mediaType: 'application/pdf',
    occurredAt: '2026-03-09T08:30:00Z',
    actorRef: 'synthetic-esign-rail',
    supersedesVersionNo: 1,
    signature: signedEvidence({
      requestId: 'nesr-0001',
      documentId: 'nd-0006',
      versionNo: 2,
      content: 'synthetic-document-bytes:nd-0006-v2:consent-form-signed',
      signerRefs: ['synthetic-patient:np-sam-porter'],
      method: 'click-to-sign',
      signedAt: '2026-03-09T08:30:00Z',
    }),
  },
  // (4) nd-0007 (a genetic result): original, partition-tagged genetic — the
  // subject of the partition-scoped-search negative.
  {
    eventId: 'ndv-0007',
    tenantId: northwind,
    documentId: 'nd-0007',
    versionNo: 1,
    kind: 'original',
    content: 'synthetic-document-bytes:nd-0007-v1:genetic-panel-result',
    mediaType: 'application/pdf',
    occurredAt: '2026-03-11T10:00:00Z',
    actorRef: 'synthetic-lab-gateway',
  },
  // (5) Riverbend cross-tenant negative: an original version.
  {
    eventId: 'rdv-0001',
    tenantId: riverbend,
    documentId: 'rd-0002',
    versionNo: 1,
    kind: 'original',
    content: 'synthetic-document-bytes:rd-0002-v1:riverbend-record',
    mediaType: 'application/pdf',
    occurredAt: '2026-03-04T12:00:00Z',
    actorRef: 'synthetic-staff:rb-clerk-001',
  },
];

function buildVersions(): readonly DocumentVersion[] {
  let versions: readonly DocumentVersion[] = [];
  for (const spec of versionSpecs) {
    ({ versions } = appendDocumentVersion(versions, versionInput(spec)));
  }
  return versions;
}

const searchEntries: readonly SearchIndexEntry[] = [
  {
    tenantId: northwind,
    documentId: 'nd-0001',
    versionNo: 2,
    docType: 'referral-summary',
    searchTerms: 'cardiology referral consult summary specialist',
    partitionTags: [],
    segments: ['clinical'],
  },
  {
    tenantId: northwind,
    documentId: 'nd-0005',
    versionNo: 1,
    docType: 'visit-note',
    searchTerms: 'annual physical visit note progress',
    partitionTags: [],
    segments: ['clinical'],
  },
  {
    tenantId: northwind,
    documentId: 'nd-0006',
    versionNo: 2,
    docType: 'consent-form',
    searchTerms: 'treatment consent authorization signed',
    partitionTags: [],
    segments: ['consent'],
  },
  {
    // The genetic doc: only a genetic-cleared caller surfaces it.
    tenantId: northwind,
    documentId: 'nd-0007',
    versionNo: 1,
    docType: 'genetic-panel-result',
    searchTerms: 'hereditary panel genetic sequencing report',
    partitionTags: ['gipa-genetic'],
    segments: ['clinical'],
  },
  {
    tenantId: riverbend,
    documentId: 'rd-0002',
    versionNo: 1,
    docType: 'visit-note',
    searchTerms: 'riverbend visit note record',
    partitionTags: [],
    segments: ['clinical'],
  },
];

const disclosures: readonly RecordsDisclosure[] = [
  {
    // A subpoena/audit export: referral summary + consent form released; the
    // genetic panel EXCLUDED (no valid send-time authorization); closed with
    // the receiving auditor's delivery receipt.
    disclosureId: 'ndd-0001',
    tenantId: northwind,
    subjectPersonRef: 'np-sam-porter',
    recipientRef: 'synthetic-auditor:state-board-0007',
    purpose: 'subpoena-audit',
    requestedBy: 'synthetic-staff:compliance-officer-001',
    includedArtifactRefs: [
      blobRefFor(hashContent('synthetic-document-bytes:nd-0001-v2:referral-summary-corrected')),
      blobRefFor(hashContent('synthetic-document-bytes:nd-0006-v2:consent-form-signed')),
    ],
    excludedOutOfScopeRefs: [],
    excludedGeneticRefs: [
      blobRefFor(hashContent('synthetic-document-bytes:nd-0007-v1:genetic-panel-result')),
    ],
    disclosedAt: '2026-03-15T00:00:00Z',
    closureStatus: 'closed-with-evidence',
    closureEvidenceRef: 'synthetic-disclosure-receipt:ndd-0001-auditor-ack',
    synthetic: true,
  },
  {
    // Riverbend: a still-transmitting disclosure (opposite posture — not yet
    // closed; transmission is not closure).
    disclosureId: 'rdd-0001',
    tenantId: riverbend,
    subjectPersonRef: 'rp-jordan-vale',
    recipientRef: 'synthetic-partner:rb-referral-0002',
    purpose: 'treatment',
    requestedBy: 'synthetic-staff:rb-clerk-001',
    includedArtifactRefs: [
      blobRefFor(hashContent('synthetic-document-bytes:rd-0002-v1:riverbend-record')),
    ],
    excludedOutOfScopeRefs: [],
    excludedGeneticRefs: [],
    disclosedAt: '2026-03-16T00:00:00Z',
    closureStatus: 'transmitted',
    synthetic: true,
  },
];

export interface DocumentsRecordsSeed {
  readonly versions: readonly DocumentVersion[];
  readonly searchEntries: readonly SearchIndexEntry[];
  readonly disclosures: readonly RecordsDisclosure[];
}

export const syntheticDocumentsRecordsSeedV1: DocumentsRecordsSeed = {
  versions: buildVersions(),
  searchEntries,
  disclosures,
};

export const documentsRecordsSeedBeginMarker = '-- documents-records:generated:begin';
export const documentsRecordsSeedEndMarker = '-- documents-records:generated:end';

const sqlLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const sqlOptional = (value: string | undefined): string =>
  value === undefined ? 'NULL' : sqlLiteral(value);
const sqlNumberOptional = (value: number | undefined): string =>
  value === undefined ? 'NULL' : String(value);
const sqlTextArray = (values: readonly string[]): string =>
  values.length === 0
    ? `'{}'::text[]`
    : `ARRAY[${values.map((v) => sqlLiteral(v)).join(', ')}]::text[]`;
const sqlOptionalTextArray = (values: readonly string[] | undefined): string =>
  values === undefined ? 'NULL' : sqlTextArray(values);

/**
 * Render the synthetic seed as idempotent SQL. Every INSERT is ON CONFLICT DO
 * NOTHING (the append-only logs are never rewritten by a re-seed); the search
 * index and the disclosure closure are the only rows that can advance, so they
 * upsert their mutable columns.
 */
export function renderDocumentsRecordsSeedSection(seed: DocumentsRecordsSeed): string {
  const versionRows = seed.versions.map(
    (v) =>
      `  (${sqlLiteral(v.tenantId)}, ${sqlLiteral(v.versionEventId)}, ${sqlLiteral(v.documentId)}, ` +
      `${String(v.versionNo)}, ${sqlLiteral(v.kind)}, ${sqlLiteral(v.blobRef)}, ` +
      `${sqlLiteral(v.contentHash)}, ${String(v.contentBytes)}, ${sqlLiteral(v.mediaType)}, ` +
      `${sqlNumberOptional(v.supersedesVersionNo)}, ${sqlNumberOptional(v.concernsVersionNo)}, ` +
      `${sqlOptional(v.reasonRef)}, ${sqlOptionalTextArray(v.signature?.signerRefs)}, ` +
      `${sqlOptional(v.signature?.method)}, ${sqlOptional(v.signature?.certificateHash)}, ` +
      `${sqlOptional(v.signature?.signedAt)}, ${sqlOptional(v.signature?.evidenceRef)}, ` +
      `${sqlLiteral(v.actorRef)}, ${sqlLiteral(v.occurredAt)}, true)`,
  );
  const indexRows = seed.searchEntries.map(
    (e) =>
      `  (${sqlLiteral(e.tenantId)}, ${sqlLiteral(e.documentId)}, ${String(e.versionNo)}, ` +
      `${sqlLiteral(e.docType)}, ${sqlLiteral(e.searchTerms)}, ${sqlTextArray(e.partitionTags)}, ` +
      `${sqlTextArray(e.segments)}, true)`,
  );
  const disclosureRows = seed.disclosures.map(
    (d) =>
      `  (${sqlLiteral(d.tenantId)}, ${sqlLiteral(d.disclosureId)}, ${sqlLiteral(d.subjectPersonRef)}, ` +
      `${sqlLiteral(d.recipientRef)}, ${sqlLiteral(d.purpose)}, ${sqlLiteral(d.requestedBy)}, ` +
      `${sqlTextArray(d.includedArtifactRefs)}, ${sqlTextArray(d.excludedOutOfScopeRefs)}, ` +
      `${sqlTextArray(d.excludedGeneticRefs)}, ${sqlOptional(d.geneticIncludedUnder?.authorizationRef)}, ` +
      `${sqlOptional(d.geneticIncludedUnder?.writtenEvidenceRef)}, ${sqlLiteral(d.disclosedAt)}, ` +
      `${sqlLiteral(d.closureStatus)}, ${sqlOptional(d.closureEvidenceRef)}, true)`,
  );
  return [
    documentsRecordsSeedBeginMarker,
    '-- Generated by @practicehub/documents renderDocumentsRecordsSeedSection from',
    '-- syntheticDocumentsRecordsSeedV1. Regenerate on any seed change; the drift test',
    '-- fails on divergence.',
    'INSERT INTO documents.document_version',
    '  (tenant_id, version_event_id, document_id, version_no, kind, blob_ref, content_hash,',
    '   content_bytes, media_type, supersedes_version_no, concerns_version_no, reason_ref,',
    '   esign_signer_refs, esign_method, esign_certificate_hash, esign_signed_at,',
    '   esign_evidence_ref, actor_ref, occurred_at, synthetic)',
    'VALUES',
    versionRows.join(',\n'),
    'ON CONFLICT (tenant_id, version_event_id) DO NOTHING;',
    '',
    'INSERT INTO documents.document_search_index',
    '  (tenant_id, document_id, version_no, doc_type, search_terms, partition_tags, segments, synthetic)',
    'VALUES',
    indexRows.join(',\n'),
    'ON CONFLICT (tenant_id, document_id, version_no) DO UPDATE',
    'SET doc_type = EXCLUDED.doc_type,',
    '    search_terms = EXCLUDED.search_terms,',
    '    partition_tags = EXCLUDED.partition_tags,',
    '    segments = EXCLUDED.segments,',
    '    synthetic = EXCLUDED.synthetic;',
    '',
    'INSERT INTO documents.records_disclosure',
    '  (tenant_id, disclosure_id, subject_person_ref, recipient_ref, purpose, requested_by,',
    '   included_artifact_refs, excluded_out_of_scope_refs, excluded_genetic_refs,',
    '   genetic_authorization_ref, genetic_written_evidence_ref, disclosed_at, closure_status,',
    '   closure_evidence_ref, synthetic)',
    'VALUES',
    disclosureRows.join(',\n'),
    'ON CONFLICT (tenant_id, disclosure_id) DO UPDATE',
    'SET closure_status = EXCLUDED.closure_status,',
    '    closure_evidence_ref = EXCLUDED.closure_evidence_ref,',
    '    synthetic = EXCLUDED.synthetic;',
    documentsRecordsSeedEndMarker,
  ].join('\n');
}

/** Extract the generated section from the committed seed file's contents. */
export function extractDocumentsRecordsSeedSection(seedSql: string): string | null {
  const begin = seedSql.indexOf(documentsRecordsSeedBeginMarker);
  const end = seedSql.indexOf(documentsRecordsSeedEndMarker);
  if (begin === -1 || end === -1 || end < begin) {
    return null;
  }
  return seedSql.slice(begin, end + documentsRecordsSeedEndMarker.length);
}
