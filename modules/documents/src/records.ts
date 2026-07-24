/**
 * Records domain (WP-025, M06). Contract: docs/contracts/records-search-api.md
 * (FROZEN). Builds four surfaces on top of the WP-024 document-intake spine:
 *
 *  - VERSIONING / supersession (REQ-DOC-003): a correction or amendment adds a
 *    NEW version that supersedes the prior — the source version is preserved,
 *    never overwritten (ADR-010 Decision 3, HIPAA §164.526). A denied correction
 *    still appends the patient's statement of disagreement; the source stands.
 *  - E-SIGN artifacts (D5.4 integrate-never-build): an `esign-execution` version
 *    records a signature evidence chain returned by the e-sign rail (esign-port).
 *    Transmission is not closure — a version lands only on the signed outcome.
 *  - SCOPED SEARCH (REQ-DOC-013/016): Postgres FTS (ADR-010 Decision 4) over
 *    non-PHI descriptor terms, scoped by tenant (RLS), partition-tag clearance
 *    (a caller must hold EVERY partition tag a document carries), and PDP data
 *    segments. PHI never leaves the DB for indexing by construction.
 *  - RECORDS EXPORT + disclosure accounting (REQ-DOC-002/013/016): a records
 *    request selects a scope, compiles the current versions in scope, re-checks
 *    genetic content at SEND time through the injected `RecordsExportGuard`
 *    (WP-015 assembleRecordsExport, FWD-PDP-025-EXPORT), and produces a
 *    disclosure-accounting record. Transmission is not closure.
 *  - DESTRUCTION over the retention engine (FWD-DOC-025-DESTRUCTION /
 *    FWD-AUD-025-DOCS): a document's destruction composes the WP-020 retention
 *    engine (`destruction_evidence` shared shape) — legal hold suspends, a
 *    running clock refuses, evidence carries what/why/authority/manifest hash.
 *
 * PHI discipline (WP-024 precedent): every ref field is grammar-checked; there
 * is no free-text column, so a raw PHI value is unrepresentable. Document bytes
 * live only in the blob store; Postgres holds the `blob://` ref + content hash.
 */

import {
  destructionManifestHash,
  evaluateDestructionEligibility,
  executeDestruction,
  resolveRetentionClock,
  type DestructionCandidate,
  type DestructionOutcome,
  type LegalHold,
  type RetentionRecordClass,
  type RetentionSchedule,
} from '@practicehub/audit-evidence';
import type { JurisdictionBasis, JurisdictionRulePack } from '@practicehub/platform-core';

import { isBlobRef } from './blob.js';
import { DocumentError, type PartitionTag } from './document.js';
import type { SignatureEvidence } from './esign-port.js';

const refPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

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
      `${label} must be a reference (ref grammar, never prose or raw values); received ${JSON.stringify(value)}`,
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

// ---------------------------------------------------------------------------
// Versioning + supersession (REQ-DOC-003) + e-sign artifacts (D5.4)
// ---------------------------------------------------------------------------

/**
 * A version's kind. `original` is version 1. `amendment`/`correction` supersede
 * the current head; a `statement-of-disagreement` is appended when a correction
 * is DENIED (the source stands and is NOT superseded). `esign-execution` records
 * a signed artifact's evidence chain.
 */
export const documentVersionKinds = [
  'original',
  'amendment',
  'correction',
  'statement-of-disagreement',
  'esign-execution',
] as const;
export type DocumentVersionKind = (typeof documentVersionKinds)[number];

/** Kinds that supersede the current head (the head becomes a prior version). */
const supersedingKinds: readonly DocumentVersionKind[] = [
  'amendment',
  'correction',
  'esign-execution',
];

export interface DocumentVersionInput {
  readonly versionEventId: string;
  readonly tenantId: string;
  readonly documentId: string;
  readonly versionNo: number;
  readonly kind: DocumentVersionKind;
  readonly blobRef: string;
  readonly contentHash: string;
  readonly contentBytes: number;
  readonly mediaType: string;
  /** The version this one supersedes (required for superseding kinds). */
  readonly supersedesVersionNo?: number;
  /** The version a statement-of-disagreement or correction concerns. */
  readonly concernsVersionNo?: number;
  /** Why the version was added (correction reason / amendment basis) — a ref. */
  readonly reasonRef?: string;
  /** Signature evidence — required when and only when kind = esign-execution. */
  readonly signature?: SignatureEvidence;
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly synthetic: true;
}

export interface DocumentVersion extends DocumentVersionInput {
  /** Superseded by a later version's supersedesVersionNo (folded, not stored raw). */
  readonly superseded: boolean;
}

function assertContentAnchor(input: {
  readonly blobRef: string;
  readonly contentHash: string;
  readonly contentBytes: number;
  readonly mediaType: string;
}): void {
  if (!isBlobRef(input.blobRef)) {
    throw new DocumentError(
      `blobRef must be a blob:// ref; received ${JSON.stringify(input.blobRef)}`,
    );
  }
  if (!sha256Pattern.test(input.contentHash)) {
    throw new DocumentError('contentHash must be sha-256 hex');
  }
  if (input.blobRef !== `blob://documents/${input.contentHash}`) {
    throw new DocumentError('blobRef must be content-addressed by contentHash (integrity anchor)');
  }
  if (!Number.isInteger(input.contentBytes) || input.contentBytes <= 0) {
    throw new DocumentError('contentBytes must be a positive integer');
  }
  if (!/^[a-z0-9][a-z0-9.+/-]{0,127}$/.test(input.mediaType)) {
    throw new DocumentError('mediaType must be a media-type token');
  }
}

/** The current head = the highest version not superseded by a later version. */
export function currentVersion(versions: readonly DocumentVersion[]): DocumentVersion | null {
  let head: DocumentVersion | null = null;
  for (const version of versions) {
    if (version.superseded) {
      continue;
    }
    if (version.kind === 'statement-of-disagreement') {
      continue; // a disagreement stands beside, never as, the current record
    }
    if (head === null || version.versionNo > head.versionNo) {
      head = version;
    }
  }
  return head;
}

/**
 * Append a version, validating the same rules the DB CHECKs mirror and folding
 * supersession. The source is NEVER mutated — a correction/amendment is a new
 * row that marks the prior head superseded; a denied correction lands a
 * statement-of-disagreement that supersedes nothing.
 */
export function appendDocumentVersion(
  versions: readonly DocumentVersion[],
  input: DocumentVersionInput,
): { readonly version: DocumentVersion; readonly versions: readonly DocumentVersion[] } {
  if (input.synthetic !== true) {
    throw new DocumentError('document versions are synthetic-only in this environment');
  }
  assertId(input.versionEventId, 'versionEventId');
  assertId(input.documentId, 'documentId');
  if (!idPattern.test(input.tenantId)) {
    throw new DocumentError(`tenantId must match ${idPattern.source}`);
  }
  assertRef(input.actorRef, 'actorRef');
  assertInstant(input.occurredAt, 'occurredAt');
  if (!(documentVersionKinds as readonly string[]).includes(input.kind)) {
    throw new DocumentError(`unknown version kind ${JSON.stringify(input.kind)}`);
  }
  if (!Number.isInteger(input.versionNo) || input.versionNo < 1) {
    throw new DocumentError('versionNo must be a positive integer');
  }
  assertContentAnchor(input);
  if (input.reasonRef !== undefined) {
    assertRef(input.reasonRef, 'reasonRef');
  }

  const scoped = versions.filter(
    (v) => v.tenantId === input.tenantId && v.documentId === input.documentId,
  );
  const head = currentVersion(scoped);

  if (input.kind === 'original') {
    if (input.versionNo !== 1 || scoped.length > 0) {
      throw new DocumentError(
        'the original is version 1 and there can be exactly one per document',
      );
    }
    if (input.supersedesVersionNo !== undefined) {
      throw new DocumentError('the original supersedes nothing');
    }
  } else if (scoped.length === 0) {
    throw new DocumentError(`document ${input.documentId} has no original version to build on`);
  }

  if (supersedingKinds.includes(input.kind)) {
    if (head === null) {
      throw new DocumentError(`a ${input.kind} needs a current version to supersede`);
    }
    if (input.supersedesVersionNo !== head.versionNo) {
      throw new DocumentError(
        `a ${input.kind} must supersede the current head (v${head.versionNo}); got v${String(input.supersedesVersionNo)}`,
      );
    }
    if (input.versionNo <= head.versionNo) {
      throw new DocumentError('a superseding version must carry a higher versionNo than the head');
    }
  }

  if (input.kind === 'correction' && input.reasonRef === undefined) {
    throw new DocumentError('a correction records its reason (REQ-DOC-003 — the amendment basis)');
  }

  if (input.kind === 'statement-of-disagreement') {
    if (input.supersedesVersionNo !== undefined) {
      throw new DocumentError('a statement of disagreement supersedes nothing — the source stands');
    }
    if (input.concernsVersionNo === undefined) {
      throw new DocumentError('a statement of disagreement names the version it concerns');
    }
  }

  if (input.kind === 'esign-execution') {
    const signature = input.signature;
    if (signature === undefined) {
      throw new DocumentError('an esign-execution version carries its signature evidence');
    }
    if (signature.status !== 'signed') {
      throw new DocumentError(
        'transmission is not closure: only a `signed` outcome becomes a version (ADR-010)',
      );
    }
    if (
      signature.certificateHash === undefined ||
      !sha256Pattern.test(signature.certificateHash) ||
      signature.signedAt === undefined ||
      !isoInstantPattern.test(signature.signedAt) ||
      signature.signerRefs.length === 0
    ) {
      throw new DocumentError(
        'a signed outcome carries a certificate hash, a signed instant, and signers',
      );
    }
    if (signature.tenantId !== input.tenantId || signature.documentId !== input.documentId) {
      throw new DocumentError('signature evidence must be for this tenant and document');
    }
  } else if (input.signature !== undefined) {
    throw new DocumentError('only an esign-execution version carries signature evidence');
  }

  const version: DocumentVersion = { ...input, superseded: false };
  const next = versions.map((v) =>
    supersedingKinds.includes(input.kind) &&
    v.tenantId === input.tenantId &&
    v.documentId === input.documentId &&
    v.versionNo === input.supersedesVersionNo
      ? { ...v, superseded: true }
      : v,
  );
  return { version, versions: [...next, version] };
}

/** The full preserved lineage for a document, oldest first — the source is never lost. */
export function versionLineage(
  versions: readonly DocumentVersion[],
  tenantId: string,
  documentId: string,
): readonly DocumentVersion[] {
  return versions
    .filter((v) => v.tenantId === tenantId && v.documentId === documentId)
    .slice()
    .sort((a, b) => a.versionNo - b.versionNo);
}

// ---------------------------------------------------------------------------
// Scoped full-text search (REQ-DOC-013/016)
// ---------------------------------------------------------------------------

/**
 * Documents-local data-segment vocabulary for PDP minimum-necessary search
 * scoping (a decoupled subset — the authoritative PDP segment vocabulary is
 * WP-015's). A search caller is cleared for a set of segments; a document
 * indexed under a segment the caller lacks never surfaces.
 */
export const recordSegments = [
  'clinical',
  'billing',
  'administrative',
  'correspondence',
  'consent',
] as const;
export type RecordSegment = (typeof recordSegments)[number];

/**
 * A search index entry (schema `documents.document_search_index`). `searchTerms`
 * holds NON-PHI descriptor tokens only (document type, provenance labels) — the
 * tsvector is built from them. Raw PHI never enters the index (ADR-010 Dec. 4).
 */
export interface SearchIndexEntry {
  readonly tenantId: string;
  readonly documentId: string;
  readonly versionNo: number;
  readonly docType: string;
  /** Space-separated non-PHI descriptor tokens (fed to the tsvector). */
  readonly searchTerms: string;
  readonly partitionTags: readonly PartitionTag[];
  readonly segments: readonly RecordSegment[];
}

export interface SearchClearance {
  readonly tenantId: string;
  /** Partition tags the caller is cleared to see (must cover EVERY doc tag). */
  readonly partitionClearances: readonly PartitionTag[];
  /** Segments the caller may read (PDP minimum-necessary). */
  readonly segmentClearances: readonly RecordSegment[];
}

const nonPhiTermPattern = /^[a-z0-9][a-z0-9 .:_-]{0,255}$/;

export function assertSearchIndexEntryWellFormed(entry: SearchIndexEntry): void {
  assertId(entry.tenantId, 'tenantId');
  assertId(entry.documentId, 'documentId');
  if (!Number.isInteger(entry.versionNo) || entry.versionNo < 1) {
    throw new DocumentError('search index versionNo must be a positive integer');
  }
  if (!nonPhiTermPattern.test(entry.docType) || !nonPhiTermPattern.test(entry.searchTerms)) {
    throw new DocumentError(
      'search index carries non-PHI descriptor tokens only (lower-case labels; never raw values)',
    );
  }
}

/**
 * PDP + partition scoped search. A document surfaces ONLY when: it belongs to
 * the caller's tenant, the caller holds EVERY partition tag the document
 * carries (fail-closed — a genetic doc is invisible without genetic clearance),
 * the document's segment is within the caller's segment clearance, and the
 * query term matches the document's non-PHI descriptors. The partition and
 * segment scoping is the "partition-scoped search negative" gate.
 */
export function scopedSearch(
  index: readonly SearchIndexEntry[],
  query: string,
  clearance: SearchClearance,
): readonly SearchIndexEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return [];
  }
  const partitionSet = new Set(clearance.partitionClearances);
  const segmentSet = new Set(clearance.segmentClearances);
  return index.filter((entry) => {
    if (entry.tenantId !== clearance.tenantId) {
      return false;
    }
    if (!entry.partitionTags.every((tag) => partitionSet.has(tag))) {
      return false; // caller lacks a partition clearance the doc requires
    }
    if (!entry.segments.every((segment) => segmentSet.has(segment))) {
      return false; // outside the caller's minimum-necessary segments
    }
    const haystack = `${entry.docType} ${entry.searchTerms}`.toLowerCase();
    return haystack.includes(needle);
  });
}

// ---------------------------------------------------------------------------
// Records request -> export -> disclosure accounting (REQ-DOC-002/013/016)
// ---------------------------------------------------------------------------

/** An item eligible for export (a current version's content-address + tags). */
export interface RecordsExportItem {
  readonly artifactRef: string;
  readonly partitionTags: readonly PartitionTag[];
  readonly segment: RecordSegment;
}

/**
 * The send-time genetic re-check port (FWD-PDP-025-EXPORT). Structurally the
 * WP-015 `assembleRecordsExport` shape — the documents export domain executes
 * it at SEND time so genetic content is excluded unless a specific, dated,
 * written, UNEXPIRED authorization exists at the send instant. Injected at the
 * composition root; the fixture/test binds the REAL identity function.
 */
export interface RecordsExportGuardRequest {
  readonly items: readonly {
    readonly artifactRef: string;
    readonly partitionTags: readonly PartitionTag[];
  }[];
  readonly subjectPersonRef: string;
  readonly authorizations: readonly GeneticExportAuthorization[];
  readonly sendDate: string;
}

export interface GeneticExportAuthorization {
  readonly authorizationId: string;
  readonly subjectPersonRef: string;
  readonly grantedOn: string;
  readonly expiresOn: string;
  readonly writtenEvidenceRef: string;
  readonly status: 'active' | 'revoked';
}

export interface RecordsExportGuardDecision {
  readonly included: readonly {
    readonly artifactRef: string;
    readonly partitionTags: readonly PartitionTag[];
  }[];
  readonly excludedGenetic: readonly {
    readonly artifactRef: string;
    readonly partitionTags: readonly PartitionTag[];
  }[];
  readonly geneticIncludedUnder?: {
    readonly authorizationRef: string;
    readonly writtenEvidenceRef: string;
  };
  readonly authorizationCheckedAt: 'send-time';
}

export type RecordsExportGuard = (request: RecordsExportGuardRequest) => RecordsExportGuardDecision;

/** Purpose vocabulary for a disclosure (a closed set; never free text). */
export const disclosurePurposes = [
  'patient-request',
  'treatment',
  'payment',
  'operations',
  'legal-obligation',
  'subpoena-audit',
] as const;
export type DisclosurePurpose = (typeof disclosurePurposes)[number];

export interface RecordsRequest {
  readonly requestId: string;
  readonly tenantId: string;
  readonly subjectPersonRef: string;
  readonly recipientRef: string;
  readonly purpose: DisclosurePurpose;
  readonly requestedBy: string;
  /** Scope limits (REQ-DOC-016): only these segments/tags may be disclosed. */
  readonly allowedSegments: readonly RecordSegment[];
  readonly allowedPartitionTags: readonly PartitionTag[];
  readonly sendDate: string;
  readonly synthetic: true;
}

export type DisclosureClosureStatus = 'transmitted' | 'closed-with-evidence';

export interface RecordsDisclosure {
  readonly disclosureId: string;
  readonly tenantId: string;
  readonly subjectPersonRef: string;
  readonly recipientRef: string;
  readonly purpose: DisclosurePurpose;
  readonly requestedBy: string;
  /** WHAT was disclosed (content-address refs of the released versions). */
  readonly includedArtifactRefs: readonly string[];
  /** Excluded by scope limits (out of the requested segment/partition scope). */
  readonly excludedOutOfScopeRefs: readonly string[];
  /** Excluded genetic content (no valid send-time authorization). */
  readonly excludedGeneticRefs: readonly string[];
  readonly geneticIncludedUnder?: {
    readonly authorizationRef: string;
    readonly writtenEvidenceRef: string;
  };
  readonly disclosedAt: string;
  /** Transmission is not closure — closure needs delivery/outcome evidence. */
  readonly closureStatus: DisclosureClosureStatus;
  readonly closureEvidenceRef?: string;
  readonly synthetic: true;
}

export class RecordsExportError extends DocumentError {}

/**
 * Compile a records request into a disclosure: apply the scope limits
 * (REQ-DOC-016 — an out-of-scope segment/partition item is excluded), then run
 * the SEND-TIME genetic re-check through the injected guard (FWD-PDP-025-EXPORT),
 * and produce the disclosure-accounting record. The disclosure lands
 * `transmitted`; closure is a separate, evidenced step.
 */
export function compileRecordsDisclosure(
  request: RecordsRequest,
  candidates: readonly RecordsExportItem[],
  guard: RecordsExportGuard,
  authorizations: readonly GeneticExportAuthorization[],
): RecordsDisclosure {
  if (request.synthetic !== true) {
    throw new RecordsExportError('records requests are synthetic-only in this environment');
  }
  assertId(request.requestId, 'requestId');
  assertId(request.tenantId, 'tenantId');
  assertRef(request.subjectPersonRef, 'subjectPersonRef');
  assertRef(request.recipientRef, 'recipientRef');
  assertRef(request.requestedBy, 'requestedBy');
  if (!isoDatePattern.test(request.sendDate)) {
    throw new RecordsExportError('sendDate must be an ISO date (YYYY-MM-DD)');
  }
  if (!(disclosurePurposes as readonly string[]).includes(request.purpose)) {
    throw new RecordsExportError(`unknown disclosure purpose ${JSON.stringify(request.purpose)}`);
  }

  const allowedSegments = new Set(request.allowedSegments);
  const allowedTags = new Set(request.allowedPartitionTags);
  const inScope: RecordsExportItem[] = [];
  const outOfScope: string[] = [];
  for (const item of candidates) {
    const segmentOk = allowedSegments.has(item.segment);
    const tagsOk = item.partitionTags.every((tag) => allowedTags.has(tag));
    if (segmentOk && tagsOk) {
      inScope.push(item);
    } else {
      outOfScope.push(item.artifactRef);
    }
  }

  const decision = guard({
    items: inScope.map((item) => ({
      artifactRef: item.artifactRef,
      partitionTags: item.partitionTags,
    })),
    subjectPersonRef: request.subjectPersonRef,
    authorizations,
    sendDate: request.sendDate,
  });
  if (decision.authorizationCheckedAt !== 'send-time') {
    throw new RecordsExportError('the genetic re-check must be evaluated at send time (EX-2)');
  }

  return {
    disclosureId: request.requestId,
    tenantId: request.tenantId,
    subjectPersonRef: request.subjectPersonRef,
    recipientRef: request.recipientRef,
    purpose: request.purpose,
    requestedBy: request.requestedBy,
    includedArtifactRefs: decision.included.map((item) => item.artifactRef),
    excludedOutOfScopeRefs: outOfScope,
    excludedGeneticRefs: decision.excludedGenetic.map((item) => item.artifactRef),
    ...(decision.geneticIncludedUnder !== undefined
      ? { geneticIncludedUnder: decision.geneticIncludedUnder }
      : {}),
    disclosedAt: `${request.sendDate}T00:00:00Z`,
    closureStatus: 'transmitted',
    synthetic: true,
  };
}

/** Close a transmitted disclosure with delivery/outcome evidence (closure invariant). */
export function closeDisclosure(
  disclosure: RecordsDisclosure,
  closureEvidenceRef: string,
): RecordsDisclosure {
  if (disclosure.closureStatus === 'closed-with-evidence') {
    throw new RecordsExportError(`disclosure ${disclosure.disclosureId} is already closed`);
  }
  assertRef(closureEvidenceRef, 'closureEvidenceRef');
  return { ...disclosure, closureStatus: 'closed-with-evidence', closureEvidenceRef };
}

/** The `disclosure`-stream audit input for a records export — structurally an
 * @practicehub/audit-evidence AuditEmitInput without its id (WP-024 precedent:
 * document.ts produces the audit shape without importing the emitter into src).
 * Proven against the REAL emitter in the fixtures test. */
export interface DisclosureAuditInput {
  readonly tenantId: string;
  readonly stream: 'disclosure';
  readonly action: 'records-disclosed';
  readonly actorRef: string;
  readonly occurredAt: string;
  readonly decision: 'allow';
  readonly recipientRef: string;
  readonly purpose: DisclosurePurpose;
  readonly detail: Readonly<Record<string, string>>;
  readonly partitionTags?: readonly PartitionTag[];
  readonly synthetic: true;
}

export function disclosureAuditInput(disclosure: RecordsDisclosure): DisclosureAuditInput {
  const genetic = disclosure.geneticIncludedUnder !== undefined;
  return {
    tenantId: disclosure.tenantId,
    stream: 'disclosure',
    action: 'records-disclosed',
    actorRef: disclosure.requestedBy,
    occurredAt: disclosure.disclosedAt,
    decision: 'allow',
    recipientRef: disclosure.recipientRef,
    purpose: disclosure.purpose,
    detail: {
      'disclosure-id': disclosure.disclosureId,
      'subject-ref': disclosure.subjectPersonRef,
      'included-count': String(disclosure.includedArtifactRefs.length),
      'genetic-included': genetic ? 'true' : 'false',
    },
    ...(genetic ? { partitionTags: ['gipa-genetic'] as readonly PartitionTag[] } : {}),
    synthetic: true,
  };
}

// ---------------------------------------------------------------------------
// Destruction over the WP-020 retention engine (FWD-DOC-025 / FWD-AUD-025)
// ---------------------------------------------------------------------------

/** The facts a document contributes to a destruction candidate. */
export interface DocumentDestructionFacts {
  readonly tenantId: string;
  readonly documentId: string;
  /** Content-address refs of the versions to be destroyed. */
  readonly recordRefs: readonly string[];
  readonly recordClass: RetentionRecordClass;
  readonly recordDate: string;
  readonly subjectBirthDate?: string;
  readonly subjectMinor: boolean;
  readonly jurisdictionBasis: JurisdictionBasis;
  readonly legalEntityId?: string;
}

function toCandidate(facts: DocumentDestructionFacts): DestructionCandidate {
  if (facts.recordRefs.length === 0) {
    throw new DocumentError('a destruction candidate names the record refs it destroys');
  }
  return {
    tenantId: facts.tenantId,
    recordClass: facts.recordClass,
    recordRefs: facts.recordRefs,
    recordDate: facts.recordDate,
    ...(facts.subjectBirthDate !== undefined ? { subjectBirthDate: facts.subjectBirthDate } : {}),
    ...(facts.legalEntityId !== undefined ? { legalEntityId: facts.legalEntityId } : {}),
  };
}

/**
 * Plan a document destruction over the retention engine: resolve the record's
 * clock (WP-020 `resolveRetentionClock` — one source of truth, the jurisdiction
 * rule packs) and evaluate eligibility against the applicable legal holds. Pure
 * — the caller supplies the packs, the counsel-owned schedule, and `asOf`.
 */
export function planDocumentDestruction(
  packs: readonly JurisdictionRulePack[],
  schedule: RetentionSchedule,
  facts: DocumentDestructionFacts,
  holds: readonly LegalHold[],
  asOf: string,
): ReturnType<typeof evaluateDestructionEligibility> {
  const clock = resolveRetentionClock(packs, schedule, facts.recordClass, facts.jurisdictionBasis, {
    minor: facts.subjectMinor,
  });
  return evaluateDestructionEligibility(clock, toCandidate(facts), holds, asOf);
}

/**
 * Execute the planned destruction (WP-020 `executeDestruction`). The race
 * resolves to the hold — a hold placed after the eligibility scan suspends the
 * destruction; a still-running clock refuses outright; success yields the shared
 * `destruction_evidence` shape (what/why/authority/manifest hash). This is the
 * FWD-DOC-025-DESTRUCTION / FWD-AUD-025-DOCS discharge: documents composes the
 * retention engine and never writes the audit-evidence tables itself.
 */
export function executeDocumentDestruction(
  eligibility: ReturnType<typeof evaluateDestructionEligibility>,
  holdsAtExecution: readonly LegalHold[],
  execution: {
    readonly destructionId: string;
    readonly auditId: string;
    readonly authorityRef: string;
    readonly executedBy: string;
    readonly occurredAt: string;
  },
): DestructionOutcome {
  return executeDestruction(eligibility, holdsAtExecution, execution);
}

export { destructionManifestHash };
