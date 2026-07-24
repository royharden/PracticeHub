/**
 * Document intake domain (WP-024, M06). Contract: docs/contracts/blob-api.md
 * (FROZEN). An append-only `document_event` log folds into a `document_state`
 * projection — the same event-sourced spine every authority/consent/audit
 * surface uses, because filing a document to a chart is an authority-bearing
 * write and quarantine/disposition are compliance-sensitive.
 *
 * Owned requirement slice (docs/requirements/canonical-requirements.csv):
 * - REQ-DOC-006 — quarantine unsolicited wrong-patient records (attribute NAMES
 *   only in the queue; a certified disposition; never auto-filed);
 * - REQ-DOC-010 — the unmatched-patient queue for documents that fail auto-match;
 * - REQ-DOC-011 — the hold-period timer that, on expiry, routes an unmatched
 *   document to a destruction/return disposition.
 * The auto-match/triage engine (REQ-DOC-009), versioning/e-sign/scoped-search/
 * destruction-EVIDENCE (REQ-DOC-002/003/013/016), and fax routing/misfile
 * lineage (REQ-DOC-001/007/020) are OTHER packages — see the contract's
 * ownership map and planning/forward-obligations.csv.
 *
 * PHI discipline: the queue carries the blob ref + content hash + partition
 * tags + the NAMES of observed attributes — never a raw value. Document bytes
 * live only in the object store (blob.ts).
 */

import { blobRefFor, contentByteLength, hashContent, isBlobRef, type BlobStore } from './blob.js';

const refPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export class DocumentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DocumentError';
  }
}

/** How a document entered the practice. Only faxes/partner exchanges can be returned. */
export const documentSources = [
  'inbound_fax',
  'portal_upload',
  'partner_exchange',
  'staff_scan',
  'api_import',
] as const;
export type DocumentSource = (typeof documentSources)[number];

/** Channels a document can be returned to its sender through (the rest destroy). */
export const returnableSources: readonly DocumentSource[] = ['inbound_fax', 'partner_exchange'];

export const documentEventTypes = [
  'received',
  'auto_match_failed',
  'quarantined',
  'filed',
  'disposition_decided',
  'redirected',
] as const;
export type DocumentEventType = (typeof documentEventTypes)[number];

export const documentStatuses = [
  'received',
  'unmatched',
  'quarantined',
  'filed',
  'disposed',
  'redirected',
] as const;
export type DocumentStatus = (typeof documentStatuses)[number];

/** At hold-expiry an unmatched/quarantined document is destroyed or returned. */
export const dispositions = ['destroyed', 'returned'] as const;
export type Disposition = (typeof dispositions)[number];

export const quarantineReasons = [
  'wrong-patient',
  'unknown-patient',
  'unsolicited',
  'no-matching-record',
  'suspected-misdirection',
] as const;
export type QuarantineReason = (typeof quarantineReasons)[number];

/**
 * Attribute NAMES a page appeared to contain — never their values. Used to
 * route/redirect a quarantined document without exposing PHI in the queue.
 */
export const observableAttributeNames = [
  'patient-name',
  'date-of-birth',
  'address',
  'phone',
  'mrn',
  'ssn-last4',
  'member-id',
  'sender-fax',
  'account-number',
] as const;
export type ObservableAttributeName = (typeof observableAttributeNames)[number];

export const partitionTags = ['gipa-genetic', 'chd', 'biometric', 'part2'] as const;
export type PartitionTag = (typeof partitionTags)[number];

/** A resulting status maps to exactly one event type (mirrored by a DB CHECK). */
const statusForEventType: Record<DocumentEventType, DocumentStatus> = {
  received: 'received',
  auto_match_failed: 'unmatched',
  quarantined: 'quarantined',
  filed: 'filed',
  disposition_decided: 'disposed',
  redirected: 'redirected',
};

const terminalStatuses: readonly DocumentStatus[] = ['filed', 'disposed', 'redirected'];

/** Which prior statuses each event type may follow (mirrored by fold legality). */
const legalPredecessors: Record<DocumentEventType, readonly (DocumentStatus | null)[]> = {
  received: [null],
  auto_match_failed: ['received'],
  quarantined: ['received'],
  filed: ['received', 'unmatched', 'quarantined'],
  disposition_decided: ['unmatched', 'quarantined'],
  redirected: ['unmatched', 'quarantined'],
};

export interface DocumentEventInput {
  readonly documentEventId: string;
  readonly tenantId: string;
  readonly documentId: string;
  readonly eventType: DocumentEventType;
  readonly actorRef: string;
  readonly occurredAt: string;
  // intake integrity — 'received' only
  readonly source?: DocumentSource;
  readonly blobRef?: string;
  readonly contentHash?: string;
  readonly contentBytes?: number;
  readonly mediaType?: string;
  readonly pageCount?: number;
  readonly partitionTags?: readonly PartitionTag[];
  // lifecycle
  readonly holdUntil?: string;
  readonly matchedPersonRef?: string;
  readonly quarantineReason?: QuarantineReason;
  readonly observedAttributeNames?: readonly ObservableAttributeName[];
  readonly disposition?: Disposition;
  readonly redirectTarget?: string;
  readonly evidenceRef?: string;
  readonly synthetic: true;
}

export interface DocumentEvent extends DocumentEventInput {
  readonly resultingStatus: DocumentStatus;
}

export interface DocumentStateRow {
  readonly tenantId: string;
  readonly documentId: string;
  readonly status: DocumentStatus;
  readonly source: DocumentSource;
  readonly blobRef: string;
  readonly contentHash: string;
  readonly contentBytes: number;
  readonly mediaType: string;
  readonly pageCount: number;
  readonly partitionTags: readonly PartitionTag[];
  readonly receivedAt: string;
  readonly holdUntil?: string;
  readonly matchedPersonRef?: string;
  readonly quarantineReason?: QuarantineReason;
  /** The NAMES a quarantined page appeared to contain — never values (§3). */
  readonly observedAttributeNames?: readonly ObservableAttributeName[];
  readonly disposition?: Disposition;
  readonly redirectTarget?: string;
  readonly lastEventId: string;
  readonly synthetic: true;
}

function assertId(value: string, label: string): void {
  if (!idPattern.test(value)) {
    throw new DocumentError(
      `${label} must match ${idPattern.source}; received ${JSON.stringify(value)}`,
    );
  }
}

function assertRef(value: string, label: string): void {
  if (!refPattern.test(value)) {
    throw new DocumentError(
      `${label} must be a reference (lower-case ref grammar, never prose or raw values); ` +
        `received ${JSON.stringify(value)}`,
    );
  }
}

function assertInstant(value: string, label: string): void {
  if (!isoInstantPattern.test(value)) {
    throw new DocumentError(
      `${label} must be an ISO-8601 UTC instant; received ${JSON.stringify(value)}`,
    );
  }
}

function priorStatus(
  log: readonly DocumentEvent[],
  tenantId: string,
  documentId: string,
): DocumentStatus | null {
  let status: DocumentStatus | null = null;
  for (const event of log) {
    if (event.tenantId === tenantId && event.documentId === documentId) {
      status = event.resultingStatus;
    }
  }
  return status;
}

/**
 * Append a lifecycle event, validating structure the same way the DB CHECKs do
 * (so a bad shape is unrepresentable in code AND in Postgres) and computing the
 * resulting status. A terminal document accepts no further events.
 */
export function appendDocumentEvent(
  log: readonly DocumentEvent[],
  input: DocumentEventInput,
): { readonly event: DocumentEvent; readonly log: readonly DocumentEvent[] } {
  if (input.synthetic !== true) {
    throw new DocumentError('document events are synthetic-only in this environment');
  }
  assertId(input.documentEventId, 'documentEventId');
  assertId(input.documentId, 'documentId');
  if (!idPattern.test(input.tenantId)) {
    throw new DocumentError(`tenantId must match ${idPattern.source}`);
  }
  assertRef(input.actorRef, 'actorRef');
  assertInstant(input.occurredAt, 'occurredAt');

  const from = priorStatus(log, input.tenantId, input.documentId);
  if (from !== null && terminalStatuses.includes(from)) {
    throw new DocumentError(
      `document ${input.documentId} is ${from} (terminal); no further events`,
    );
  }
  if (!legalPredecessors[input.eventType].includes(from)) {
    throw new DocumentError(
      `a ${input.eventType} event cannot follow status ${JSON.stringify(from)} ` +
        `for document ${input.documentId}`,
    );
  }

  switch (input.eventType) {
    case 'received': {
      if (
        input.source === undefined ||
        input.blobRef === undefined ||
        input.contentHash === undefined ||
        input.contentBytes === undefined ||
        input.mediaType === undefined ||
        input.pageCount === undefined
      ) {
        throw new DocumentError('a received event must carry the full intake integrity anchor');
      }
      if (!documentSources.includes(input.source)) {
        throw new DocumentError(`unknown document source ${JSON.stringify(input.source)}`);
      }
      if (!isBlobRef(input.blobRef)) {
        throw new DocumentError(
          `blobRef must be a blob:// ref; received ${JSON.stringify(input.blobRef)}`,
        );
      }
      if (!sha256Pattern.test(input.contentHash)) {
        throw new DocumentError('contentHash must be sha-256 hex');
      }
      if (input.contentBytes <= 0 || !Number.isInteger(input.contentBytes)) {
        throw new DocumentError('contentBytes must be a positive integer');
      }
      if (input.pageCount <= 0 || !Number.isInteger(input.pageCount)) {
        throw new DocumentError('pageCount must be a positive integer');
      }
      break;
    }
    case 'auto_match_failed': {
      if (input.holdUntil === undefined) {
        throw new DocumentError(
          'an unmatched document must carry a hold-until deadline (REQ-DOC-011)',
        );
      }
      assertInstant(input.holdUntil, 'holdUntil');
      break;
    }
    case 'quarantined': {
      if (input.quarantineReason === undefined) {
        throw new DocumentError('a quarantined document must carry a reason (REQ-DOC-006)');
      }
      if (!quarantineReasons.includes(input.quarantineReason)) {
        throw new DocumentError(
          `unknown quarantine reason ${JSON.stringify(input.quarantineReason)}`,
        );
      }
      const names = input.observedAttributeNames ?? [];
      if (names.length === 0) {
        throw new DocumentError(
          'a quarantined document records the NAMES of observed attributes (never values)',
        );
      }
      for (const name of names) {
        if (!observableAttributeNames.includes(name)) {
          throw new DocumentError(
            `${JSON.stringify(name)} is not an attribute NAME — the quarantine queue never holds raw values`,
          );
        }
      }
      break;
    }
    case 'filed': {
      if (input.matchedPersonRef === undefined || input.evidenceRef === undefined) {
        throw new DocumentError(
          'filing to a chart is authority-bearing: it must name the matched person and its evidence',
        );
      }
      assertRef(input.matchedPersonRef, 'matchedPersonRef');
      assertRef(input.evidenceRef, 'evidenceRef');
      break;
    }
    case 'disposition_decided': {
      if (input.disposition === undefined || input.evidenceRef === undefined) {
        throw new DocumentError(
          'a disposition must name its outcome and carry destruction/return evidence',
        );
      }
      if (!dispositions.includes(input.disposition)) {
        throw new DocumentError(`unknown disposition ${JSON.stringify(input.disposition)}`);
      }
      assertRef(input.evidenceRef, 'evidenceRef');
      break;
    }
    case 'redirected': {
      if (input.redirectTarget === undefined) {
        throw new DocumentError('a redirected document must name its redirect target');
      }
      assertRef(input.redirectTarget, 'redirectTarget');
      break;
    }
    default: {
      throw new DocumentError(
        `unrecognized document event type ${JSON.stringify(input.eventType)}`,
      );
    }
  }

  const event: DocumentEvent = { ...input, resultingStatus: statusForEventType[input.eventType] };
  return { event, log: [...log, event] };
}

/**
 * Fold the append-only log into one current-state row per document. The
 * projection is a materialized read model — rebuildable from the log alone,
 * never a second source of truth (a DB test folds the stored log and asserts
 * field equality against the stored projection).
 */
export function foldDocumentState(events: readonly DocumentEvent[]): Map<string, DocumentStateRow> {
  const byDocument = new Map<string, DocumentStateRow>();
  for (const event of events) {
    const key = `${event.tenantId}|${event.documentId}`;
    if (event.eventType === 'received') {
      byDocument.set(key, {
        tenantId: event.tenantId,
        documentId: event.documentId,
        status: 'received',
        source: event.source as DocumentSource,
        blobRef: event.blobRef as string,
        contentHash: event.contentHash as string,
        contentBytes: event.contentBytes as number,
        mediaType: event.mediaType as string,
        pageCount: event.pageCount as number,
        partitionTags: event.partitionTags ?? [],
        receivedAt: event.occurredAt,
        lastEventId: event.documentEventId,
        synthetic: true,
      });
      continue;
    }
    const current = byDocument.get(key);
    if (current === undefined) {
      throw new DocumentError(
        `document ${event.documentId} has a lifecycle event with no received event`,
      );
    }
    byDocument.set(key, {
      ...current,
      status: event.resultingStatus,
      lastEventId: event.documentEventId,
      ...(event.holdUntil !== undefined ? { holdUntil: event.holdUntil } : {}),
      ...(event.matchedPersonRef !== undefined ? { matchedPersonRef: event.matchedPersonRef } : {}),
      ...(event.quarantineReason !== undefined ? { quarantineReason: event.quarantineReason } : {}),
      ...(event.observedAttributeNames !== undefined
        ? { observedAttributeNames: event.observedAttributeNames }
        : {}),
      ...(event.disposition !== undefined ? { disposition: event.disposition } : {}),
      ...(event.redirectTarget !== undefined ? { redirectTarget: event.redirectTarget } : {}),
    });
  }
  return byDocument;
}

export function resolveDocumentState(
  events: readonly DocumentEvent[],
  tenantId: string,
  documentId: string,
): DocumentStateRow | null {
  return foldDocumentState(events).get(`${tenantId}|${documentId}`) ?? null;
}

// ---------------------------------------------------------------------------
// Intake — store the bytes, anchor the integrity, emit the received event
// ---------------------------------------------------------------------------

export interface ReceiveDocumentInput {
  readonly documentEventId: string;
  readonly tenantId: string;
  readonly documentId: string;
  readonly source: DocumentSource;
  readonly bytes: string;
  readonly mediaType: string;
  readonly pageCount: number;
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly partitionTags?: readonly PartitionTag[];
  readonly synthetic: true;
}

/**
 * Store synthetic bytes in the blob store and produce the received event whose
 * hash IS the object's content address — the integrity anchor Postgres records.
 */
export function receiveDocument(
  store: BlobStore,
  log: readonly DocumentEvent[],
  input: ReceiveDocumentInput,
): {
  readonly event: DocumentEvent;
  readonly log: readonly DocumentEvent[];
  readonly blobRef: string;
} {
  const stat = store.put({ bytes: input.bytes, mediaType: input.mediaType, synthetic: true });
  const { event, log: next } = appendDocumentEvent(log, {
    documentEventId: input.documentEventId,
    tenantId: input.tenantId,
    documentId: input.documentId,
    eventType: 'received',
    actorRef: input.actorRef,
    occurredAt: input.occurredAt,
    source: input.source,
    blobRef: stat.ref,
    contentHash: stat.contentHash,
    contentBytes: stat.contentBytes,
    mediaType: input.mediaType,
    pageCount: input.pageCount,
    ...(input.partitionTags !== undefined ? { partitionTags: input.partitionTags } : {}),
    synthetic: true,
  });
  return { event, log: next, blobRef: stat.ref };
}

// ---------------------------------------------------------------------------
// Hold-period timer (REQ-DOC-011) — the "unknown-patient timer"
// ---------------------------------------------------------------------------

/** Default synthetic hold period before an unmatched document is disposed. */
export const defaultHoldPeriodDays = 30;

const dayMs = 24 * 60 * 60 * 1000;

/** Deadline = receipt + hold period, computed as a whole-second UTC instant. */
export function holdDeadline(
  receivedAt: string,
  holdPeriodDays: number = defaultHoldPeriodDays,
): string {
  if (!isoInstantPattern.test(receivedAt)) {
    throw new DocumentError('receivedAt must be an ISO-8601 UTC instant');
  }
  if (!Number.isInteger(holdPeriodDays) || holdPeriodDays <= 0) {
    throw new DocumentError('holdPeriodDays must be a positive integer');
  }
  const deadline = new Date(new Date(receivedAt).getTime() + holdPeriodDays * dayMs);
  return `${deadline.toISOString().slice(0, 19)}Z`;
}

export type HoldStatus = 'within-hold' | 'expired';

/** Whether an unmatched document's hold has expired as of a given instant. */
export function computeHoldStatus(row: DocumentStateRow, asOf: string): HoldStatus {
  if (!isoInstantPattern.test(asOf)) {
    throw new DocumentError('asOf must be an ISO-8601 UTC instant');
  }
  if (row.holdUntil === undefined) {
    throw new DocumentError(`document ${row.documentId} carries no hold deadline`);
  }
  // Inclusive boundary: at exactly the deadline the hold is over (fail toward
  // disposition — an over-held unmatched document is the compliance risk).
  return new Date(asOf).getTime() >= new Date(row.holdUntil).getTime() ? 'expired' : 'within-hold';
}

export interface HoldExpiryDecision {
  readonly expired: boolean;
  readonly recommendedDisposition: Disposition;
}

/**
 * At (or past) the hold deadline, decide destroy vs return: a document received
 * on a returnable channel (fax/partner exchange) goes back to its sender;
 * anything else is destroyed with evidence. The actual destruction-evidence
 * emission runs over the WP-020/WP-025 retention engine — FWD-DOC-025-DESTRUCTION.
 */
export function dispositionAtHoldExpiry(row: DocumentStateRow, asOf: string): HoldExpiryDecision {
  const expired = computeHoldStatus(row, asOf) === 'expired';
  const recommendedDisposition: Disposition = returnableSources.includes(row.source)
    ? 'returned'
    : 'destroyed';
  return { expired, recommendedDisposition };
}

// ---------------------------------------------------------------------------
// Audit — the authority-bearing filing decision is auditable
// ---------------------------------------------------------------------------

/** Structurally an @practicehub/audit-evidence AuditEmitInput without its id. */
export interface DocumentAuditInput {
  readonly tenantId: string;
  readonly stream: 'access';
  readonly action: string;
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly subjectRef: string;
  readonly decision: 'allow' | 'deny';
  readonly reason: 'operations';
  readonly detail: Readonly<Record<string, string>>;
  readonly partitionTags?: readonly PartitionTag[];
  readonly synthetic: true;
}

/**
 * The access-stream audit input for a filing decision (allow or deny map
 * identically — a denied filing must be recordable, the audit-store precedent).
 * subjectRef is the matched person; detail carries the document id and content
 * hash as refs — never a raw value.
 */
export function documentFiledAuditInput(
  event: DocumentEvent,
  decision: 'allow' | 'deny',
): DocumentAuditInput {
  if (event.eventType !== 'filed') {
    throw new DocumentError('only a filed event yields a filing audit input');
  }
  return {
    tenantId: event.tenantId,
    stream: 'access',
    action: 'document-filed',
    actorRef: event.actorRef,
    occurredAt: event.occurredAt,
    subjectRef: event.matchedPersonRef as string,
    decision,
    reason: 'operations',
    detail: {
      'document-id': event.documentId,
      'content-hash': event.contentHash ?? 'blob:unknown',
    },
    ...(event.partitionTags !== undefined ? { partitionTags: event.partitionTags } : {}),
    synthetic: true,
  };
}

// ---------------------------------------------------------------------------
// WorkItem descriptor (WP-022 integration point; live creation is forward)
// ---------------------------------------------------------------------------

/**
 * A quarantine review / unmatched-resolution surfaces as owned work. WP-024
 * produces the descriptor over the FROZEN WP-022 origin taxonomy (using the
 * generic `admin` origin — extending the taxonomy with a `document` origin is
 * WP-022's data+CHECK change, never a downstream widening); the LIVE WorkItem
 * creation over the outbox spine is FWD-DOC-030-WORKITEMS.
 */
export interface DocumentWorkItemDescriptor {
  readonly origin: 'admin';
  readonly subjectRef: string;
  readonly tenantId: string;
  readonly summary: string;
}

export function documentReviewDescriptor(row: DocumentStateRow): DocumentWorkItemDescriptor {
  if (row.status !== 'quarantined' && row.status !== 'unmatched') {
    throw new DocumentError(
      `only a quarantined or unmatched document opens review work; got ${row.status}`,
    );
  }
  return {
    origin: 'admin',
    subjectRef: row.documentId,
    tenantId: row.tenantId,
    summary: row.status === 'quarantined' ? 'quarantine-review' : 'unmatched-patient-resolution',
  };
}

export { blobRefFor, contentByteLength, hashContent };
