/**
 * Executable 4-class fixture packs for the WP-024 requirement slice
 * (REQ-DOC-006 quarantine, REQ-DOC-010 unmatched queue, REQ-DOC-011 hold-period
 * timer). Every case runs against the REAL domain functions — a fixture that
 * merely "exists" without encoding its acceptance criterion cannot pass here.
 * The access-stream audit input of a filing decision is emitted through the
 * REAL @practicehub/audit-evidence emitter, proving the authority-bearing write
 * is auditable.
 *
 * Review-009 discipline: the accepted-op list is validated at LOAD (an unknown
 * op fails the pack's structural test, not silently), and the dispatcher ends in
 * a throwing default.
 */
import { fileURLToPath } from 'node:url';

import { emitAuditEvent, emptyChainState } from '@practicehub/audit-evidence';
import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import { InMemoryBlobStore } from './blob.js';
import {
  appendDocumentEvent,
  computeHoldStatus,
  dispositionAtHoldExpiry,
  documentFiledAuditInput,
  documentReviewDescriptor,
  foldDocumentState,
  holdDeadline,
  receiveDocument,
  type Disposition,
  type DocumentEvent,
  type DocumentEventInput,
  type DocumentSource,
  type DocumentStatus,
  type ObservableAttributeName,
  type PartitionTag,
  type QuarantineReason,
} from './document.js';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));
const tenant = 'northwind-synthetic';
const docId = 'nd-fx';

const acceptedOps = ['lifecycle', 'hold', 'disposition', 'descriptor', 'audit'] as const;
type FixtureOp = (typeof acceptedOps)[number];

interface EventSpec {
  readonly id: string;
  readonly type: DocumentEvent['eventType'];
  readonly occurredAt: string;
  readonly actorRef?: string;
  readonly source?: DocumentSource;
  readonly bytes?: string;
  readonly mediaType?: string;
  readonly pageCount?: number;
  readonly partitionTags?: readonly PartitionTag[];
  readonly holdFrom?: string;
  readonly holdDays?: number;
  readonly holdUntil?: string;
  readonly matchedPersonRef?: string;
  readonly evidence?: boolean;
  readonly quarantineReason?: QuarantineReason;
  readonly observedAttributeNames?: readonly ObservableAttributeName[];
  readonly disposition?: Disposition;
  readonly redirectTarget?: string;
}

interface FixtureCase {
  readonly name: string;
  readonly op: FixtureOp;
  readonly events?: readonly EventSpec[];
  readonly event?: EventSpec;
  readonly expectError?: string;
  readonly expectStatus?: DocumentStatus;
  readonly asOf?: string;
  readonly expectHold?: 'within-hold' | 'expired';
  readonly expectExpired?: boolean;
  readonly expectDisposition?: Disposition;
  readonly expectOrigin?: string;
  readonly expectSummary?: string;
  readonly expectDecision?: 'allow' | 'deny';
}

interface DocumentsFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly cases: readonly FixtureCase[];
}

function nonReceivedInput(spec: EventSpec): DocumentEventInput {
  const holdUntil =
    spec.holdUntil ??
    (spec.holdFrom !== undefined ? holdDeadline(spec.holdFrom, spec.holdDays ?? 30) : undefined);
  return {
    documentEventId: spec.id,
    tenantId: tenant,
    documentId: docId,
    eventType: spec.type,
    actorRef: spec.actorRef ?? 'synthetic-staff:fixture',
    occurredAt: spec.occurredAt,
    ...(holdUntil !== undefined ? { holdUntil } : {}),
    ...(spec.matchedPersonRef !== undefined ? { matchedPersonRef: spec.matchedPersonRef } : {}),
    ...(spec.evidence === true ? { evidenceRef: `synthetic-doc-evidence:${spec.id}` } : {}),
    ...(spec.quarantineReason !== undefined ? { quarantineReason: spec.quarantineReason } : {}),
    ...(spec.observedAttributeNames !== undefined
      ? { observedAttributeNames: spec.observedAttributeNames }
      : {}),
    ...(spec.disposition !== undefined ? { disposition: spec.disposition } : {}),
    ...(spec.redirectTarget !== undefined ? { redirectTarget: spec.redirectTarget } : {}),
    synthetic: true,
  };
}

interface BuiltLog {
  readonly log: readonly DocumentEvent[];
  readonly lastEvent: DocumentEvent | null;
}

function applySpec(
  store: InMemoryBlobStore,
  log: readonly DocumentEvent[],
  spec: EventSpec,
): BuiltLog {
  if (spec.type === 'received') {
    const result = receiveDocument(store, log, {
      documentEventId: spec.id,
      tenantId: tenant,
      documentId: docId,
      source: spec.source ?? 'inbound_fax',
      bytes: spec.bytes ?? `synthetic-document-bytes:${spec.id}`,
      mediaType: spec.mediaType ?? 'application/pdf',
      pageCount: spec.pageCount ?? 1,
      actorRef: spec.actorRef ?? 'synthetic-fax-gateway',
      occurredAt: spec.occurredAt,
      ...(spec.partitionTags !== undefined ? { partitionTags: spec.partitionTags } : {}),
      synthetic: true,
    });
    return { log: result.log, lastEvent: result.event };
  }
  const { event, log: next } = appendDocumentEvent(log, nonReceivedInput(spec));
  return { log: next, lastEvent: event };
}

function buildLog(specs: readonly EventSpec[]): BuiltLog {
  const store = new InMemoryBlobStore();
  let log: readonly DocumentEvent[] = [];
  let lastEvent: DocumentEvent | null = null;
  for (const spec of specs) {
    ({ log, lastEvent } = applySpec(store, log, spec));
  }
  return { log, lastEvent };
}

function stateOf(log: readonly DocumentEvent[]) {
  const row = foldDocumentState(log).get(`${tenant}|${docId}`);
  if (row === undefined) {
    throw new Error('fixture built no document state');
  }
  return row;
}

function runCase(fixtureCase: FixtureCase): void {
  const prefix = buildLog(fixtureCase.events ?? []);
  switch (fixtureCase.op) {
    case 'lifecycle': {
      if (fixtureCase.event !== undefined && fixtureCase.expectError !== undefined) {
        const store = new InMemoryBlobStore();
        expect(() => applySpec(store, prefix.log, fixtureCase.event as EventSpec)).toThrow(
          fixtureCase.expectError,
        );
        break;
      }
      let log = prefix.log;
      if (fixtureCase.event !== undefined) {
        ({ log } = applySpec(new InMemoryBlobStore(), log, fixtureCase.event));
      }
      if (fixtureCase.expectStatus !== undefined) {
        expect(stateOf(log).status).toBe(fixtureCase.expectStatus);
      }
      break;
    }
    case 'hold': {
      expect(computeHoldStatus(stateOf(prefix.log), fixtureCase.asOf as string)).toBe(
        fixtureCase.expectHold,
      );
      break;
    }
    case 'disposition': {
      const decision = dispositionAtHoldExpiry(stateOf(prefix.log), fixtureCase.asOf as string);
      if (fixtureCase.expectExpired !== undefined) {
        expect(decision.expired).toBe(fixtureCase.expectExpired);
      }
      if (fixtureCase.expectDisposition !== undefined) {
        expect(decision.recommendedDisposition).toBe(fixtureCase.expectDisposition);
      }
      break;
    }
    case 'descriptor': {
      const descriptor = documentReviewDescriptor(stateOf(prefix.log));
      if (fixtureCase.expectOrigin !== undefined) {
        expect(descriptor.origin).toBe(fixtureCase.expectOrigin);
      }
      if (fixtureCase.expectSummary !== undefined) {
        expect(descriptor.summary).toBe(fixtureCase.expectSummary);
      }
      break;
    }
    case 'audit': {
      const event = prefix.lastEvent;
      if (event === null || event.eventType !== 'filed') {
        throw new Error('an audit case must end in a filed event');
      }
      const decision = fixtureCase.expectDecision ?? 'allow';
      const emitted = emitAuditEvent(emptyChainState, {
        ...documentFiledAuditInput(event, decision),
        auditId: 'fx-documents-audit-0001',
      });
      expect(emitted.record.entryHash).toMatch(/^[0-9a-f]{64}$/);
      expect(emitted.record.decision).toBe(decision);
      break;
    }
    default: {
      throw new Error(
        `unrecognized fixture op ${JSON.stringify((fixtureCase as { op: string }).op)} — ` +
          'the dispatcher refuses unknown cases (review-009)',
      );
    }
  }
}

const ownedRequirements = ['REQ-DOC-006', 'REQ-DOC-010', 'REQ-DOC-011'];

for (const requirementId of ownedRequirements) {
  describe(`${requirementId} fixture pack (4-class floor)`, () => {
    const pack = loadRequirementFixturePack(fixturesDirectory, requirementId);

    it('carries all four fixture classes with the synthetic watermark', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
    });

    it('every case declares a recognized op (load-time validation, review-009)', () => {
      for (const fixtureClass of requiredFixtureClasses) {
        const fixture = pack.fixtures[fixtureClass] as unknown as DocumentsFixture;
        expect(fixture.cases.length).toBeGreaterThan(0);
        for (const fixtureCase of fixture.cases) {
          expect(
            (acceptedOps as readonly string[]).includes(fixtureCase.op),
            `${fixtureClass}: unknown op ${JSON.stringify(fixtureCase.op)}`,
          ).toBe(true);
        }
      }
    });

    for (const fixtureClass of requiredFixtureClasses) {
      describe(fixtureClass, () => {
        const fixture = pack.fixtures[fixtureClass] as unknown as DocumentsFixture;
        for (const fixtureCase of fixture.cases) {
          it(fixtureCase.name, () => {
            runCase(fixtureCase);
          });
        }
      });
    }
  });
}
