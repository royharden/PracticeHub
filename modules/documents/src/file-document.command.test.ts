/**
 * The fileDocument command is capability-gated (standing invariant:
 * capability-state checks + AuthorityDecision on every authority-bearing
 * write). WP-024's own seed keeps `documents.intake` at `scaffolded` (the
 * package ceiling) — the seeded grant must DENY a live filing, the synthetic
 * `simulated` grant must allow, and Riverbend (disabled) stays denied.
 * Protective writes (quarantine/hold/disposition/redirect) never route here.
 */
import {
  CapabilityDeniedError,
  capabilityRegistryV1,
  foldCapabilityEvents,
  syntheticCapabilitySeedV1,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import {
  appendDocumentEvent,
  DocumentError,
  type DocumentEvent,
  type DocumentEventInput,
} from './document.js';
import { fileDocumentCommand } from './commands/file-document.command.js';

const registry = capabilityRegistryV1;
const seededGrants: readonly CapabilityGrant[] = [
  ...syntheticCapabilitySeedV1.initialGrants,
  ...foldCapabilityEvents(registry, [], syntheticCapabilitySeedV1.events),
];
const tenant = 'northwind-synthetic';

function receivedLog(): readonly DocumentEvent[] {
  return appendDocumentEvent([], {
    documentEventId: 'nde-cmd-0001',
    tenantId: tenant,
    documentId: 'nd-cmd-0001',
    eventType: 'received',
    actorRef: 'synthetic-fax-gateway',
    occurredAt: '2026-03-20T09:00:00Z',
    source: 'inbound_fax',
    blobRef: `blob://documents/${'b'.repeat(64)}`,
    contentHash: 'b'.repeat(64),
    contentBytes: 40,
    mediaType: 'application/pdf',
    pageCount: 1,
    synthetic: true,
  }).log;
}

const fileEvent: DocumentEventInput = {
  documentEventId: 'nde-cmd-0002',
  tenantId: tenant,
  documentId: 'nd-cmd-0001',
  eventType: 'filed',
  actorRef: 'synthetic-staff:records-clerk-001',
  occurredAt: '2026-03-20T10:00:00Z',
  matchedPersonRef: 'np-sam-porter',
  evidenceRef: 'synthetic-doc-evidence:nd-cmd-0001-match',
  synthetic: true,
};

const simulatedGrant: CapabilityGrant = {
  capabilityId: 'documents.intake',
  tenantId: tenant,
  scope: {},
  state: 'simulated',
  sinceEventId: 'synthetic-cap-evt-test-0019',
  evidenceRefs: ['synthetic-gate:documents-sim-conformance'],
  rollbackRef: 'registry-event-replay',
  synthetic: true,
};

describe('fileDocument command capability gate', () => {
  it('the WP-024 seed (scaffolded) DENIES a live filing — the ceiling is honored', () => {
    expect(() =>
      fileDocumentCommand.invoke(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        { log: receivedLog(), event: fileEvent },
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it('a denied invocation carries a deny AuthorityDecision for documents.intake', () => {
    try {
      fileDocumentCommand.invoke(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        { log: receivedLog(), event: fileEvent },
      );
      throw new Error('expected a CapabilityDeniedError');
    } catch (error) {
      if (!(error instanceof CapabilityDeniedError)) {
        throw error;
      }
      expect(error.decision.allowed).toBe(false);
      expect(error.decision.capabilityId).toBe('documents.intake');
    }
  });

  it('a simulated grant allows the filing and returns the AuthorityDecision + event', () => {
    const invocation = fileDocumentCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      { log: receivedLog(), event: fileEvent },
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.decision.capabilityId).toBe('documents.intake');
    expect(invocation.result.event.resultingStatus).toBe('filed');
  });

  it('rejects a protective action routed through the gate (quarantine goes ungated)', () => {
    const { matchedPersonRef: _m, evidenceRef: _e, ...base } = fileEvent;
    void _m;
    void _e;
    expect(() =>
      fileDocumentCommand.invoke(
        registry,
        [simulatedGrant],
        { tenantId: tenant, scope: {} },
        {
          log: receivedLog(),
          event: {
            ...base,
            eventType: 'quarantined',
            quarantineReason: 'wrong-patient',
            observedAttributeNames: ['patient-name'],
          },
        },
      ),
    ).toThrow(DocumentError);
  });

  it('Riverbend (disabled) is denied — the standing opposite-state proof', () => {
    expect(() =>
      fileDocumentCommand.invoke(
        registry,
        seededGrants,
        { tenantId: 'riverbend-synthetic', scope: {} },
        {
          log: [],
          event: { ...fileEvent, tenantId: 'riverbend-synthetic' },
        },
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
