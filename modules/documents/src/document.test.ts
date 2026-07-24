/**
 * Document intake domain unit suite (WP-024). Covers the append-only lifecycle,
 * the structural validations mirrored by the DB CHECKs, the quarantine
 * attribute-names-only rule (REQ-DOC-006), the unmatched queue (REQ-DOC-010),
 * and the hold-period timer (REQ-DOC-011 — the unknown-patient timer).
 */
import { describe, expect, it } from 'vitest';

import { InMemoryBlobStore } from './blob.js';
import {
  appendDocumentEvent,
  computeHoldStatus,
  dispositionAtHoldExpiry,
  documentFiledAuditInput,
  documentReviewDescriptor,
  DocumentError,
  foldDocumentState,
  holdDeadline,
  receiveDocument,
  resolveDocumentState,
  type DocumentEvent,
  type DocumentEventInput,
} from './document.js';

const tenant = 'northwind-synthetic';

function receivedInput(overrides: Partial<DocumentEventInput> = {}): DocumentEventInput {
  return {
    documentEventId: 'nde-t-0001',
    tenantId: tenant,
    documentId: 'nd-t-0001',
    eventType: 'received',
    actorRef: 'synthetic-fax-gateway',
    occurredAt: '2026-03-01T09:00:00Z',
    source: 'inbound_fax',
    blobRef: `blob://documents/${'a'.repeat(64)}`,
    contentHash: 'a'.repeat(64),
    contentBytes: 42,
    mediaType: 'application/pdf',
    pageCount: 2,
    synthetic: true,
    ...overrides,
  };
}

function buildReceived(): readonly DocumentEvent[] {
  return appendDocumentEvent([], receivedInput()).log;
}

describe('appendDocumentEvent — lifecycle + structure', () => {
  it('a received event initializes the document and folds into the projection', () => {
    const state = resolveDocumentState(buildReceived(), tenant, 'nd-t-0001');
    expect(state?.status).toBe('received');
    expect(state?.source).toBe('inbound_fax');
    expect(state?.pageCount).toBe(2);
  });

  it('a received event must carry the full intake integrity anchor', () => {
    const { contentHash: _omitHash, ...withoutHash } = receivedInput();
    void _omitHash;
    expect(() => appendDocumentEvent([], withoutHash)).toThrow(/integrity anchor/);
  });

  it('a lifecycle event with no prior received event is unrepresentable', () => {
    expect(() =>
      appendDocumentEvent([], {
        documentEventId: 'nde-t-0002',
        tenantId: tenant,
        documentId: 'nd-t-0009',
        eventType: 'filed',
        actorRef: 'synthetic-staff:clerk',
        occurredAt: '2026-03-01T10:00:00Z',
        matchedPersonRef: 'np-x',
        evidenceRef: 'synthetic-doc-evidence:x',
        synthetic: true,
      }),
    ).toThrow(DocumentError);
  });

  it('a terminal (filed) document accepts no further events', () => {
    let log = buildReceived();
    ({ log } = appendDocumentEvent(log, {
      documentEventId: 'nde-t-0002',
      tenantId: tenant,
      documentId: 'nd-t-0001',
      eventType: 'filed',
      actorRef: 'synthetic-staff:clerk',
      occurredAt: '2026-03-01T10:00:00Z',
      matchedPersonRef: 'np-sam-porter',
      evidenceRef: 'synthetic-doc-evidence:match',
      synthetic: true,
    }));
    expect(() =>
      appendDocumentEvent(log, {
        documentEventId: 'nde-t-0003',
        tenantId: tenant,
        documentId: 'nd-t-0001',
        eventType: 'redirected',
        actorRef: 'synthetic-staff:clerk',
        occurredAt: '2026-03-01T11:00:00Z',
        redirectTarget: 'synthetic-practice:elsewhere',
        synthetic: true,
      }),
    ).toThrow(/terminal/);
  });

  it('filing to a chart must name the matched person and its evidence (authority-bearing)', () => {
    const log = buildReceived();
    expect(() =>
      appendDocumentEvent(log, {
        documentEventId: 'nde-t-0002',
        tenantId: tenant,
        documentId: 'nd-t-0001',
        eventType: 'filed',
        actorRef: 'synthetic-staff:clerk',
        occurredAt: '2026-03-01T10:00:00Z',
        matchedPersonRef: 'np-sam-porter',
        synthetic: true,
      }),
    ).toThrow(/authority-bearing/);
  });
});

describe('quarantine engine (REQ-DOC-006) — attribute NAMES only, never values', () => {
  it('a quarantined document records a reason and the names of observed attributes', () => {
    let log = buildReceived();
    ({ log } = appendDocumentEvent(log, {
      documentEventId: 'nde-t-0002',
      tenantId: tenant,
      documentId: 'nd-t-0001',
      eventType: 'quarantined',
      actorRef: 'synthetic-staff:clerk',
      occurredAt: '2026-03-01T10:00:00Z',
      quarantineReason: 'wrong-patient',
      observedAttributeNames: ['patient-name', 'date-of-birth'],
      synthetic: true,
    }));
    expect(resolveDocumentState(log, tenant, 'nd-t-0001')?.status).toBe('quarantined');
    expect(resolveDocumentState(log, tenant, 'nd-t-0001')?.quarantineReason).toBe('wrong-patient');
    // The queue row (projection) surfaces the observed NAMES for triage (§3).
    expect(resolveDocumentState(log, tenant, 'nd-t-0001')?.observedAttributeNames).toEqual([
      'patient-name',
      'date-of-birth',
    ]);
  });

  it('a value smuggled in as an attribute name is refused (only NAMES are representable)', () => {
    const log = buildReceived();
    expect(() =>
      appendDocumentEvent(log, {
        documentEventId: 'nde-t-0002',
        tenantId: tenant,
        documentId: 'nd-t-0001',
        eventType: 'quarantined',
        actorRef: 'synthetic-staff:clerk',
        occurredAt: '2026-03-01T10:00:00Z',
        quarantineReason: 'wrong-patient',
        observedAttributeNames: ['not-an-attribute-name' as never],
        synthetic: true,
      }),
    ).toThrow(/attribute NAME/);
  });

  it('a quarantine with no observed attributes is refused', () => {
    const log = buildReceived();
    expect(() =>
      appendDocumentEvent(log, {
        documentEventId: 'nde-t-0002',
        tenantId: tenant,
        documentId: 'nd-t-0001',
        eventType: 'quarantined',
        actorRef: 'synthetic-staff:clerk',
        occurredAt: '2026-03-01T10:00:00Z',
        quarantineReason: 'wrong-patient',
        observedAttributeNames: [],
        synthetic: true,
      }),
    ).toThrow(DocumentError);
  });
});

describe('unmatched queue + hold-period timer (REQ-DOC-010/011)', () => {
  it('auto-match failure requires a hold deadline and yields the unmatched status', () => {
    let log = buildReceived();
    ({ log } = appendDocumentEvent(log, {
      documentEventId: 'nde-t-0002',
      tenantId: tenant,
      documentId: 'nd-t-0001',
      eventType: 'auto_match_failed',
      actorRef: 'synthetic-match-engine',
      occurredAt: '2026-03-01T09:05:00Z',
      holdUntil: holdDeadline('2026-03-01T09:05:00Z'),
      synthetic: true,
    }));
    expect(resolveDocumentState(log, tenant, 'nd-t-0001')?.status).toBe('unmatched');
  });

  it('holdDeadline is receipt + the hold period as a whole-second UTC instant', () => {
    expect(holdDeadline('2026-03-01T00:00:00Z', 30)).toBe('2026-03-31T00:00:00Z');
  });

  it('the hold status flips at exactly the deadline (inclusive — fail toward disposition)', () => {
    let log = buildReceived();
    ({ log } = appendDocumentEvent(log, {
      documentEventId: 'nde-t-0002',
      tenantId: tenant,
      documentId: 'nd-t-0001',
      eventType: 'auto_match_failed',
      actorRef: 'synthetic-match-engine',
      occurredAt: '2026-03-01T00:00:00Z',
      holdUntil: '2026-03-31T00:00:00Z',
      synthetic: true,
    }));
    const state = resolveDocumentState(log, tenant, 'nd-t-0001');
    expect(state).not.toBeNull();
    const row = state as NonNullable<typeof state>;
    expect(computeHoldStatus(row, '2026-03-30T23:59:59Z')).toBe('within-hold');
    expect(computeHoldStatus(row, '2026-03-31T00:00:00Z')).toBe('expired');
  });

  it('at expiry a fax is returned to sender; a portal upload is destroyed', () => {
    const faxState = resolveDocumentState(buildUnmatched('inbound_fax'), tenant, 'nd-t-0001');
    const portalState = resolveDocumentState(buildUnmatched('portal_upload'), tenant, 'nd-t-0001');
    expect(dispositionAtHoldExpiry(faxState as never, '2026-05-01T00:00:00Z')).toEqual({
      expired: true,
      recommendedDisposition: 'returned',
    });
    expect(dispositionAtHoldExpiry(portalState as never, '2026-05-01T00:00:00Z')).toEqual({
      expired: true,
      recommendedDisposition: 'destroyed',
    });
  });

  it('a disposition decision is a protective write and closes the document', () => {
    let log = buildUnmatched('inbound_fax');
    ({ log } = appendDocumentEvent(log, {
      documentEventId: 'nde-t-0003',
      tenantId: tenant,
      documentId: 'nd-t-0001',
      eventType: 'disposition_decided',
      actorRef: 'synthetic-records-sweep',
      occurredAt: '2026-05-01T00:00:00Z',
      disposition: 'returned',
      evidenceRef: 'synthetic-doc-evidence:return',
      synthetic: true,
    }));
    expect(resolveDocumentState(log, tenant, 'nd-t-0001')?.status).toBe('disposed');
    expect(resolveDocumentState(log, tenant, 'nd-t-0001')?.disposition).toBe('returned');
  });
});

function buildUnmatched(source: 'inbound_fax' | 'portal_upload'): readonly DocumentEvent[] {
  let log = appendDocumentEvent([], receivedInput({ source })).log;
  ({ log } = appendDocumentEvent(log, {
    documentEventId: 'nde-t-0002',
    tenantId: tenant,
    documentId: 'nd-t-0001',
    eventType: 'auto_match_failed',
    actorRef: 'synthetic-match-engine',
    occurredAt: '2026-03-01T09:05:00Z',
    holdUntil: holdDeadline('2026-03-01T09:05:00Z'),
    synthetic: true,
  }));
  return log;
}

describe('receiveDocument + audit + descriptors', () => {
  it('receiveDocument stores the bytes and anchors the ref/hash on the event', () => {
    const store = new InMemoryBlobStore();
    const { event, blobRef } = receiveDocument(store, [], {
      documentEventId: 'nde-r-0001',
      tenantId: tenant,
      documentId: 'nd-r-0001',
      source: 'inbound_fax',
      bytes: 'synthetic-document-bytes:receive',
      mediaType: 'application/pdf',
      pageCount: 1,
      actorRef: 'synthetic-fax-gateway',
      occurredAt: '2026-03-01T09:00:00Z',
      synthetic: true,
    });
    expect(event.blobRef).toBe(blobRef);
    expect(store.get(blobRef).contentHash).toBe(event.contentHash);
  });

  it('a filed event produces an access-stream audit input (allow and deny map alike)', () => {
    const { event } = appendDocumentEvent(buildReceived(), {
      documentEventId: 'nde-t-0002',
      tenantId: tenant,
      documentId: 'nd-t-0001',
      eventType: 'filed',
      actorRef: 'synthetic-staff:clerk',
      occurredAt: '2026-03-01T10:00:00Z',
      matchedPersonRef: 'np-sam-porter',
      evidenceRef: 'synthetic-doc-evidence:match',
      synthetic: true,
    });
    const input = documentFiledAuditInput(event, 'allow');
    expect(input.stream).toBe('access');
    expect(input.subjectRef).toBe('np-sam-porter');
    expect(input.decision).toBe('allow');
    expect(documentFiledAuditInput(event, 'deny').decision).toBe('deny');
  });

  it('a quarantined/unmatched document produces a review descriptor over the admin origin', () => {
    const { log } = appendDocumentEvent(buildReceived(), {
      documentEventId: 'nde-t-0002',
      tenantId: tenant,
      documentId: 'nd-t-0001',
      eventType: 'quarantined',
      actorRef: 'synthetic-staff:clerk',
      occurredAt: '2026-03-01T10:00:00Z',
      quarantineReason: 'wrong-patient',
      observedAttributeNames: ['patient-name'],
      synthetic: true,
    });
    const descriptor = documentReviewDescriptor(
      foldDocumentState(log).get(`${tenant}|nd-t-0001`) as never,
    );
    expect(descriptor.origin).toBe('admin');
    expect(descriptor.subjectRef).toBe('nd-t-0001');
    expect(descriptor.summary).toBe('quarantine-review');
  });
});
