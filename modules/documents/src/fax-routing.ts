/**
 * Schema-free fax routing slice (WP-049).
 *
 * Provider output is advisory: urgent screening runs before identity resolution,
 * every page is reconciled exactly once, and only an attributed human
 * confirmation can produce a filing plan. Confidence, including 1.0, never
 * authorizes an automatic chart attachment.
 */

import { contentByteLength, hashContent, type BlobStore } from './blob.js';
import {
  DocumentError,
  observableAttributeNames,
  receiveDocument,
  type DocumentEvent,
  type ObservableAttributeName,
  type PartitionTag,
} from './document.js';
import type { InboundFaxDelivery } from './intake-port.js';

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const refPattern = /^[a-z0-9][a-z0-9:._/-]{0,199}$/;
const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export const faxDocumentTypes = ['referral', 'outside-records', 'signed-form', 'other'] as const;
export type FaxDocumentType = (typeof faxDocumentTypes)[number];

export const faxUrgencySignals = ['negative', 'positive', 'uncertain'] as const;
export type FaxUrgencySignal = (typeof faxUrgencySignals)[number];

export interface FaxIdentityEvidence {
  /** Ephemeral synthetic facts for the identity adapter; never returned in a queue descriptor. */
  readonly facts: Readonly<Record<string, string>>;
  readonly observedAttributeNames: readonly ObservableAttributeName[];
  readonly evidenceRef: string;
}

export interface ProposedFaxPageGroup {
  readonly groupId: string;
  readonly pages: readonly number[];
  readonly documentType: FaxDocumentType;
  readonly identityEvidence: FaxIdentityEvidence;
  readonly confidence: number;
}

export interface FaxInspection {
  readonly tenantId: string;
  readonly faxId: string;
  readonly documentId: string;
  readonly providerRef: string;
  readonly providerVersion: string;
  readonly readable: boolean;
  readonly groups: readonly ProposedFaxPageGroup[];
  readonly urgency: {
    readonly signal: FaxUrgencySignal;
    readonly evidenceRef: string;
  };
  readonly realParityCase: string;
  readonly synthetic: true;
}

export interface FaxIntelligencePort {
  inspect(input: {
    readonly tenantId: string;
    readonly faxId: string;
    readonly documentId: string;
    readonly senderRef: string;
    readonly blobRef: string;
    readonly contentHash: string;
    readonly pageCount: number;
    readonly receivedAt: string;
    readonly synthetic: true;
  }): Promise<FaxInspection>;
}

export interface FaxCandidateRef {
  readonly personRef: string;
  readonly matchedAttributeNames: readonly ObservableAttributeName[];
}

export type FaxPatientMatchResult =
  | { readonly kind: 'none'; readonly tenantId: string }
  | {
      readonly kind: 'single';
      readonly tenantId: string;
      readonly personRef: string;
      readonly matchedAttributeNames: readonly ObservableAttributeName[];
    }
  | {
      readonly kind: 'ambiguous';
      readonly tenantId: string;
      readonly candidates: readonly FaxCandidateRef[];
    };

export interface FaxPatientMatchPort {
  resolve(input: {
    readonly tenantId: string;
    readonly faxId: string;
    readonly documentId: string;
    readonly groupId: string;
    readonly evidence: FaxIdentityEvidence;
    readonly synthetic: true;
  }): Promise<FaxPatientMatchResult>;
}

export interface FaxUrgentWorkDescriptor {
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly faxId: string;
  readonly documentId: string;
  readonly signal: Exclude<FaxUrgencySignal, 'negative'>;
  readonly receivedAt: string;
  readonly dueAt: string;
  readonly afterHoursRouteRef: string;
  readonly evidenceRef: string;
  readonly idempotencyKey: string;
  readonly purpose: 'urgent-fax-review';
  readonly synthetic: true;
}

/** Explicit double boundary until the real WP-022 consumer binding is assigned. */
export interface FaxWorkItemPort {
  /** Implementations deduplicate this stable key and never resend an external effect. */
  openUrgent(input: FaxUrgentWorkDescriptor): Promise<{
    readonly workItemRef: string;
    readonly outcome: 'opened' | 'deduplicated';
    readonly resendsExternalEffect: false;
  }>;
}

export type FaxGroupRoute =
  | {
      readonly kind: 'awaiting-human-confirmation';
      readonly groupId: string;
      readonly pages: readonly number[];
      readonly documentType: FaxDocumentType;
      readonly proposedPersonRef: string;
      readonly matchedAttributeNames: readonly ObservableAttributeName[];
      readonly confidence: number;
      readonly evidenceRef: string;
    }
  | {
      readonly kind: 'manual-review';
      readonly groupId: string;
      readonly pages: readonly number[];
      readonly documentType: FaxDocumentType;
      readonly reason: 'unreadable' | 'no-candidate' | 'ambiguous' | 'sub-threshold';
      readonly candidateRefs: readonly FaxCandidateRef[];
      readonly observedAttributeNames: readonly ObservableAttributeName[];
      readonly confidence: number;
      readonly evidenceRef: string;
    };

export interface FaxRoutingResult {
  readonly tenantId: string;
  readonly faxId: string;
  readonly documentId: string;
  readonly blobRef: string;
  readonly contentHash: string;
  readonly log: readonly DocumentEvent[];
  readonly groups: readonly FaxGroupRoute[];
  readonly urgentWork: (FaxUrgentWorkDescriptor & { readonly workItemRef: string }) | null;
  readonly requiresHumanConfirmation: true;
  readonly synthetic: true;
}

export interface RouteInboundFaxInput {
  readonly tenantId: string;
  readonly documentId: string;
  readonly documentEventId: string;
  readonly actorRef: string;
  readonly delivery: InboundFaxDelivery;
  readonly partitionTags?: readonly PartitionTag[];
  readonly minimumConfidence: number;
  readonly urgentDueAt: string;
  readonly afterHoursRouteRef: string;
}

export interface FaxRoutingPorts {
  readonly intelligence: FaxIntelligencePort;
  readonly matcher: FaxPatientMatchPort;
  readonly workItems: FaxWorkItemPort;
}

function assertId(value: string, label: string): void {
  if (!idPattern.test(value)) {
    throw new DocumentError(`${label} must be a lower-case identifier`);
  }
}

function assertRef(value: string, label: string): void {
  if (!refPattern.test(value)) {
    throw new DocumentError(`${label} must be a lower-case reference, never prose or a raw value`);
  }
}

function assertInstant(value: string, label: string): void {
  const parsed = new Date(value);
  const normalized = value.includes('.')
    ? value.replace(/\.(\d{1,3})Z$/, (_match, fraction: string) => `.${fraction.padEnd(3, '0')}Z`)
    : value.replace(/Z$/, '.000Z');
  if (
    !isoInstantPattern.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString() !== normalized
  ) {
    throw new DocumentError(`${label} must be a real ISO-8601 UTC instant`);
  }
}

function assertConfidence(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new DocumentError(`${label} must be normalized between 0 and 1`);
  }
}

function uniqueNames(
  names: readonly ObservableAttributeName[],
): readonly ObservableAttributeName[] {
  for (const name of names) {
    if (!(observableAttributeNames as readonly string[]).includes(name)) {
      throw new DocumentError('identity evidence may contain attribute names only');
    }
  }
  return [...new Set(names)];
}

/** Every received page belongs to exactly one proposed group. */
export function assertExactPageCover(
  groups: readonly ProposedFaxPageGroup[],
  pageCount: number,
): void {
  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    throw new DocumentError('pageCount must be a positive integer');
  }
  if (groups.length === 0) {
    throw new DocumentError('fax inspection must propose at least one page group');
  }
  const owners = new Map<number, string>();
  const groupIds = new Set<string>();
  for (const group of groups) {
    assertId(group.groupId, 'groupId');
    if (groupIds.has(group.groupId)) {
      throw new DocumentError(`group ${group.groupId} is proposed twice`);
    }
    groupIds.add(group.groupId);
    if (!faxDocumentTypes.includes(group.documentType)) {
      throw new DocumentError(`unknown fax document type ${JSON.stringify(group.documentType)}`);
    }
    assertConfidence(group.confidence, `group ${group.groupId} confidence`);
    assertRef(group.identityEvidence.evidenceRef, 'identity evidenceRef');
    if (group.pages.length === 0) {
      throw new DocumentError(`group ${group.groupId} has no pages`);
    }
    for (const page of group.pages) {
      if (!Number.isInteger(page) || page < 1 || page > pageCount) {
        throw new DocumentError(`page ${page} is outside received range 1..${pageCount}`);
      }
      const prior = owners.get(page);
      if (prior !== undefined) {
        throw new DocumentError(`page ${page} is assigned twice (${prior}, ${group.groupId})`);
      }
      owners.set(page, group.groupId);
    }
  }
  for (let page = 1; page <= pageCount; page += 1) {
    if (!owners.has(page)) {
      throw new DocumentError(`page ${page} is missing from the proposed grouping`);
    }
  }
}

function validateInspectionEnvelope(
  inspection: FaxInspection,
  input: RouteInboundFaxInput,
  content: { readonly blobRef: string; readonly contentHash: string },
): void {
  if (inspection.synthetic !== true) {
    throw new DocumentError('fax inspection must carry the synthetic watermark');
  }
  if (
    inspection.tenantId !== input.tenantId ||
    inspection.faxId !== input.delivery.faxId ||
    inspection.documentId !== input.documentId
  ) {
    throw new DocumentError('fax inspection tenant/subject context does not match the request');
  }
  assertRef(inspection.providerRef, 'providerRef');
  assertRef(inspection.providerVersion, 'providerVersion');
  if (!(faxUrgencySignals as readonly string[]).includes(inspection.urgency.signal)) {
    throw new DocumentError('fax inspection returned an unknown urgency signal');
  }
  assertRef(inspection.urgency.evidenceRef, 'urgency evidenceRef');
  assertRef(inspection.realParityCase, 'realParityCase');
  assertRef(content.blobRef, 'blobRef');
  assertRef(content.contentHash, 'contentHash');
}

function validateInspectionGroups(inspection: FaxInspection, pageCount: number): void {
  assertExactPageCover(inspection.groups, pageCount);
  for (const group of inspection.groups) {
    uniqueNames(group.identityEvidence.observedAttributeNames);
  }
}

function receiveFaxOnce(
  store: BlobStore,
  log: readonly DocumentEvent[],
  input: RouteInboundFaxInput,
): {
  readonly event: DocumentEvent;
  readonly log: readonly DocumentEvent[];
  readonly blobRef: string;
} {
  const prior = log.find((event) => event.documentEventId === input.documentEventId);
  if (prior === undefined) {
    return {
      ...receiveDocument(store, log, {
        documentEventId: input.documentEventId,
        tenantId: input.tenantId,
        documentId: input.documentId,
        source: 'inbound_fax',
        bytes: input.delivery.bytes,
        mediaType: input.delivery.mediaType,
        pageCount: input.delivery.pageCount,
        actorRef: input.actorRef,
        occurredAt: input.delivery.receivedAt,
        ...(input.partitionTags !== undefined ? { partitionTags: input.partitionTags } : {}),
        synthetic: true,
      }),
    };
  }

  const expectedHash = hashContent(input.delivery.bytes);
  if (
    prior.eventType !== 'received' ||
    prior.tenantId !== input.tenantId ||
    prior.documentId !== input.documentId ||
    prior.source !== 'inbound_fax' ||
    prior.contentHash !== expectedHash ||
    prior.contentBytes !== contentByteLength(input.delivery.bytes) ||
    prior.mediaType !== input.delivery.mediaType ||
    prior.pageCount !== input.delivery.pageCount ||
    prior.actorRef !== input.actorRef ||
    prior.occurredAt !== input.delivery.receivedAt ||
    prior.blobRef === undefined
  ) {
    throw new DocumentError('fax replay does not match the original received event');
  }
  const stored = store.get(prior.blobRef);
  if (stored.contentHash !== expectedHash || stored.bytes !== input.delivery.bytes) {
    throw new DocumentError('fax replay bytes do not match the original content address');
  }
  return { event: prior, log, blobRef: prior.blobRef };
}

function urgentDescriptor(
  input: RouteInboundFaxInput,
  inspection: FaxInspection,
): FaxUrgentWorkDescriptor | null {
  if (inspection.urgency.signal === 'negative') {
    return null;
  }
  assertInstant(input.urgentDueAt, 'urgentDueAt');
  assertRef(input.afterHoursRouteRef, 'afterHoursRouteRef');
  return {
    tenantId: input.tenantId,
    subjectRef: `fax:${input.tenantId}:${input.documentId}`,
    faxId: input.delivery.faxId,
    documentId: input.documentId,
    signal: inspection.urgency.signal,
    receivedAt: input.delivery.receivedAt,
    dueAt: input.urgentDueAt,
    afterHoursRouteRef: input.afterHoursRouteRef,
    evidenceRef: inspection.urgency.evidenceRef,
    idempotencyKey: `urgent-fax:${input.tenantId}:${input.documentId}`,
    purpose: 'urgent-fax-review',
    synthetic: true,
  };
}

/**
 * Execute the schema-free slice. Urgent work is opened before the first matcher
 * call, so an unreadable or unmatched fax cannot hide a critical signal.
 */
export async function routeInboundFax(
  store: BlobStore,
  log: readonly DocumentEvent[],
  input: RouteInboundFaxInput,
  ports: FaxRoutingPorts,
): Promise<FaxRoutingResult> {
  assertId(input.tenantId, 'tenantId');
  assertId(input.documentId, 'documentId');
  assertId(input.documentEventId, 'documentEventId');
  assertRef(input.actorRef, 'actorRef');
  assertConfidence(input.minimumConfidence, 'minimumConfidence');
  assertInstant(input.delivery.receivedAt, 'delivery.receivedAt');
  if (input.delivery.synthetic !== true) {
    throw new DocumentError('fax delivery must carry the synthetic watermark');
  }
  if (input.delivery.tenantId !== input.tenantId) {
    throw new DocumentError('fax delivery tenant does not match the routing tenant');
  }

  const received = receiveFaxOnce(store, log, input);

  const inspection = await ports.intelligence.inspect({
    tenantId: input.tenantId,
    faxId: input.delivery.faxId,
    documentId: input.documentId,
    senderRef: input.delivery.senderRef,
    blobRef: received.blobRef,
    contentHash: received.event.contentHash as string,
    pageCount: input.delivery.pageCount,
    receivedAt: input.delivery.receivedAt,
    synthetic: true,
  });
  validateInspectionEnvelope(inspection, input, {
    blobRef: received.blobRef,
    contentHash: received.event.contentHash as string,
  });

  // This call deliberately precedes all identity matching (RT-20).
  const urgent = urgentDescriptor(input, inspection);
  let urgentWork: FaxRoutingResult['urgentWork'] = null;
  if (urgent !== null) {
    const opened = await ports.workItems.openUrgent(urgent);
    if (opened.resendsExternalEffect !== false) {
      throw new DocumentError('urgent work adapter may not resend an external effect');
    }
    if (opened.outcome !== 'opened' && opened.outcome !== 'deduplicated') {
      throw new DocumentError('urgent work adapter returned an unknown outcome');
    }
    assertRef(opened.workItemRef, 'workItemRef');
    urgentWork = { ...urgent, workItemRef: opened.workItemRef };
  }

  // Page-shape validation follows urgent handoff so malformed grouping cannot hide critical content.
  validateInspectionGroups(inspection, input.delivery.pageCount);

  const groups: FaxGroupRoute[] = [];
  for (const group of inspection.groups) {
    const names = uniqueNames(group.identityEvidence.observedAttributeNames);
    if (!inspection.readable) {
      groups.push({
        kind: 'manual-review',
        groupId: group.groupId,
        pages: group.pages,
        documentType: group.documentType,
        reason: 'unreadable',
        candidateRefs: [],
        observedAttributeNames: names,
        confidence: group.confidence,
        evidenceRef: group.identityEvidence.evidenceRef,
      });
      continue;
    }

    const match = await ports.matcher.resolve({
      tenantId: input.tenantId,
      faxId: input.delivery.faxId,
      documentId: input.documentId,
      groupId: group.groupId,
      evidence: group.identityEvidence,
      synthetic: true,
    });
    if (match.tenantId !== input.tenantId) {
      throw new DocumentError('identity match result crossed the routing tenant boundary');
    }
    if (match.kind !== 'none' && match.kind !== 'single' && match.kind !== 'ambiguous') {
      throw new DocumentError('identity matcher returned an unknown outcome');
    }
    if (match.kind === 'ambiguous') {
      for (const candidate of match.candidates) {
        assertRef(candidate.personRef, 'candidate personRef');
        uniqueNames(candidate.matchedAttributeNames);
      }
    }
    if (group.confidence < input.minimumConfidence) {
      groups.push({
        kind: 'manual-review',
        groupId: group.groupId,
        pages: group.pages,
        documentType: group.documentType,
        reason: 'sub-threshold',
        candidateRefs:
          match.kind === 'ambiguous'
            ? match.candidates
            : match.kind === 'single'
              ? [
                  {
                    personRef: match.personRef,
                    matchedAttributeNames: match.matchedAttributeNames,
                  },
                ]
              : [],
        observedAttributeNames: names,
        confidence: group.confidence,
        evidenceRef: group.identityEvidence.evidenceRef,
      });
      continue;
    }
    if (match.kind === 'none') {
      groups.push({
        kind: 'manual-review',
        groupId: group.groupId,
        pages: group.pages,
        documentType: group.documentType,
        reason: 'no-candidate',
        candidateRefs: [],
        observedAttributeNames: names,
        confidence: group.confidence,
        evidenceRef: group.identityEvidence.evidenceRef,
      });
      continue;
    }
    if (match.kind === 'ambiguous') {
      groups.push({
        kind: 'manual-review',
        groupId: group.groupId,
        pages: group.pages,
        documentType: group.documentType,
        reason: 'ambiguous',
        candidateRefs: match.candidates,
        observedAttributeNames: names,
        confidence: group.confidence,
        evidenceRef: group.identityEvidence.evidenceRef,
      });
      continue;
    }
    assertRef(match.personRef, 'matched personRef');
    const matchedAttributeNames = uniqueNames(match.matchedAttributeNames);
    groups.push({
      kind: 'awaiting-human-confirmation',
      groupId: group.groupId,
      pages: group.pages,
      documentType: group.documentType,
      proposedPersonRef: match.personRef,
      matchedAttributeNames,
      confidence: group.confidence,
      evidenceRef: group.identityEvidence.evidenceRef,
    });
  }

  return {
    tenantId: input.tenantId,
    faxId: input.delivery.faxId,
    documentId: input.documentId,
    blobRef: received.blobRef,
    contentHash: received.event.contentHash as string,
    log: received.log,
    groups,
    urgentWork,
    requiresHumanConfirmation: true,
    synthetic: true,
  };
}

export type FaxHumanDisposition =
  | {
      readonly kind: 'confirm';
      readonly groupId: string;
      readonly personRef: string;
      readonly pages: readonly number[];
      readonly documentType: FaxDocumentType;
      readonly orderOrReferralRef?: string;
    }
  | {
      readonly kind: 'quarantine';
      readonly groupId: string;
      readonly pages: readonly number[];
      readonly reasonRef: string;
    };

export interface FaxFilingPlan {
  readonly tenantId: string;
  readonly faxId: string;
  readonly documentId: string;
  readonly confirmedBy: string;
  readonly confirmedAt: string;
  readonly evidenceRef: string;
  readonly filings: readonly Extract<FaxHumanDisposition, { readonly kind: 'confirm' }>[];
  readonly quarantines: readonly Extract<FaxHumanDisposition, { readonly kind: 'quarantine' }>[];
  readonly synthetic: true;
}

/** Human confirmation reconciles every proposed group; it performs no write. */
export function confirmFaxRouting(
  routing: FaxRoutingResult,
  input: {
    readonly tenantId: string;
    readonly confirmedBy: string;
    readonly confirmedAt: string;
    readonly evidenceRef: string;
    readonly dispositions: readonly FaxHumanDisposition[];
  },
): FaxFilingPlan {
  if (input.tenantId !== routing.tenantId) {
    throw new DocumentError('human confirmation tenant does not match the fax tenant');
  }
  assertRef(input.confirmedBy, 'confirmedBy');
  assertInstant(input.confirmedAt, 'confirmedAt');
  assertRef(input.evidenceRef, 'confirmation evidenceRef');
  const byGroup = new Map(routing.groups.map((group) => [group.groupId, group]));
  const seen = new Set<string>();
  for (const disposition of input.dispositions) {
    if (disposition.kind !== 'confirm' && disposition.kind !== 'quarantine') {
      throw new DocumentError('human disposition returned an unknown kind');
    }
    if (seen.has(disposition.groupId)) {
      throw new DocumentError(`group ${disposition.groupId} received two human dispositions`);
    }
    seen.add(disposition.groupId);
    const proposed = byGroup.get(disposition.groupId);
    if (proposed === undefined) {
      throw new DocumentError(`human disposition names unknown group ${disposition.groupId}`);
    }
    if (
      JSON.stringify([...disposition.pages].sort((a, b) => a - b)) !==
      JSON.stringify([...proposed.pages].sort((a, b) => a - b))
    ) {
      throw new DocumentError(`human disposition changed the page set for ${disposition.groupId}`);
    }
    if (disposition.kind === 'confirm') {
      if (proposed.kind !== 'awaiting-human-confirmation') {
        throw new DocumentError(
          `group ${disposition.groupId} is manual-review and cannot be confirmed`,
        );
      }
      assertRef(disposition.personRef, 'confirmed personRef');
      if (disposition.personRef !== proposed.proposedPersonRef) {
        throw new DocumentError(
          `group ${disposition.groupId} confirmation changed the proposed person`,
        );
      }
      if (disposition.documentType !== proposed.documentType) {
        throw new DocumentError(`group ${disposition.groupId} confirmation changed document type`);
      }
      if (disposition.orderOrReferralRef !== undefined) {
        assertRef(disposition.orderOrReferralRef, 'orderOrReferralRef');
      }
    } else {
      assertRef(disposition.reasonRef, 'quarantine reasonRef');
    }
  }
  if (seen.size !== routing.groups.length) {
    throw new DocumentError(
      'human confirmation must disposition every proposed group exactly once',
    );
  }
  return {
    tenantId: routing.tenantId,
    faxId: routing.faxId,
    documentId: routing.documentId,
    confirmedBy: input.confirmedBy,
    confirmedAt: input.confirmedAt,
    evidenceRef: input.evidenceRef,
    filings: input.dispositions.filter(
      (item): item is Extract<FaxHumanDisposition, { readonly kind: 'confirm' }> =>
        item.kind === 'confirm',
    ),
    quarantines: input.dispositions.filter(
      (item): item is Extract<FaxHumanDisposition, { readonly kind: 'quarantine' }> =>
        item.kind === 'quarantine',
    ),
    synthetic: true,
  };
}

export function sweepUrgentFaxReviews(
  pending: readonly FaxUrgentWorkDescriptor[],
  asOf: string,
): readonly FaxUrgentWorkDescriptor[] {
  assertInstant(asOf, 'asOf');
  const tenants = new Set(pending.map((item) => item.tenantId));
  if (tenants.size > 1) {
    throw new DocumentError('urgent fax sweep must run inside one tenant scope');
  }
  for (const item of pending) {
    assertRef(item.afterHoursRouteRef, 'afterHoursRouteRef');
    assertInstant(item.dueAt, 'dueAt');
  }
  return pending
    .filter((item) => Date.parse(item.dueAt) <= Date.parse(asOf))
    .sort((left, right) => {
      const risk = (left.signal === 'positive' ? 0 : 1) - (right.signal === 'positive' ? 0 : 1);
      return (
        risk ||
        left.dueAt.localeCompare(right.dueAt) ||
        left.documentId.localeCompare(right.documentId)
      );
    });
}

export interface FaxSenderOutcome {
  readonly outcome: 'matched' | 'unmatched' | 'unidentifiable';
}

export function evaluateFaxSenderPattern(input: {
  readonly tenantId: string;
  readonly senderRef: string;
  readonly outcomes: readonly FaxSenderOutcome[];
  readonly outreachThreshold: number;
  readonly perSenderNoteRef?: string;
  readonly perFaxMinimumConfidence: number;
}): {
  readonly flagPracticeManagerOutreach: boolean;
  readonly patternCount: number;
  readonly perSenderNoteRef?: string;
  readonly perFaxMinimumConfidence: number;
  readonly matchPolicyUnchanged: true;
} {
  assertId(input.tenantId, 'tenantId');
  assertRef(input.senderRef, 'senderRef');
  assertConfidence(input.perFaxMinimumConfidence, 'perFaxMinimumConfidence');
  if (!Number.isInteger(input.outreachThreshold) || input.outreachThreshold <= 0) {
    throw new DocumentError('outreachThreshold must be a positive integer');
  }
  if (input.perSenderNoteRef !== undefined) {
    assertRef(input.perSenderNoteRef, 'perSenderNoteRef');
  }
  const patternCount = input.outcomes.filter((item) => item.outcome !== 'matched').length;
  return {
    flagPracticeManagerOutreach: patternCount >= input.outreachThreshold,
    patternCount,
    ...(input.perSenderNoteRef !== undefined ? { perSenderNoteRef: input.perSenderNoteRef } : {}),
    perFaxMinimumConfidence: input.perFaxMinimumConfidence,
    matchPolicyUnchanged: true,
  };
}
