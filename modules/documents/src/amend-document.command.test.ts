/**
 * The amendDocument command is capability-gated (standing invariant: capability
 * checks + AuthorityDecision on every authority-bearing write). WP-025 keeps
 * `documents.records` at `scaffolded` (the package ceiling) — the seeded grant
 * DENIES a live amendment/correction/e-sign execution, the synthetic `simulated`
 * grant allows, and Riverbend (disabled) stays denied. Protective/patient-right
 * writes (the original version, a statement of disagreement) never route here.
 */
import {
  CapabilityDeniedError,
  capabilityRegistryV1,
  foldCapabilityEvents,
  syntheticCapabilitySeedV1,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { blobRefFor, contentByteLength, hashContent } from './blob.js';
import { DocumentError } from './document.js';
import {
  appendDocumentVersion,
  type DocumentVersion,
  type DocumentVersionInput,
} from './records.js';
import { amendDocumentCommand } from './commands/amend-document.command.js';

const registry = capabilityRegistryV1;
const seededGrants: readonly CapabilityGrant[] = [
  ...syntheticCapabilitySeedV1.initialGrants,
  ...foldCapabilityEvents(registry, [], syntheticCapabilitySeedV1.events),
];
const tenant = 'northwind-synthetic';

function versionInput(spec: {
  eventId: string;
  versionNo: number;
  kind: DocumentVersionInput['kind'];
  content: string;
  supersedesVersionNo?: number;
  concernsVersionNo?: number;
  reasonRef?: string;
}): DocumentVersionInput {
  const hash = hashContent(spec.content);
  return {
    versionEventId: spec.eventId,
    tenantId: tenant,
    documentId: 'nd-cmd-v-0001',
    versionNo: spec.versionNo,
    kind: spec.kind,
    blobRef: blobRefFor(hash),
    contentHash: hash,
    contentBytes: contentByteLength(spec.content),
    mediaType: 'application/pdf',
    ...(spec.supersedesVersionNo !== undefined
      ? { supersedesVersionNo: spec.supersedesVersionNo }
      : {}),
    ...(spec.concernsVersionNo !== undefined ? { concernsVersionNo: spec.concernsVersionNo } : {}),
    ...(spec.reasonRef !== undefined ? { reasonRef: spec.reasonRef } : {}),
    actorRef: 'synthetic-staff:records-clerk-001',
    occurredAt: '2026-03-05T10:00:00Z',
    synthetic: true,
  };
}

function originalLog(): readonly DocumentVersion[] {
  return appendDocumentVersion(
    [],
    versionInput({ eventId: 'v1', versionNo: 1, kind: 'original', content: 'orig' }),
  ).versions;
}

const correction: DocumentVersionInput = versionInput({
  eventId: 'v2',
  versionNo: 2,
  kind: 'correction',
  content: 'corrected',
  supersedesVersionNo: 1,
  reasonRef: 'synthetic-correction-request:wrong-dob',
});

const simulatedGrant: CapabilityGrant = {
  capabilityId: 'documents.records',
  tenantId: tenant,
  scope: {},
  state: 'simulated',
  sinceEventId: 'synthetic-cap-evt-test-0020',
  evidenceRefs: ['synthetic-gate:documents-records-sim-conformance'],
  rollbackRef: 'registry-event-replay',
  synthetic: true,
};

describe('amendDocument command capability gate', () => {
  it('the WP-025 seed (scaffolded) DENIES a live correction — the ceiling is honored', () => {
    expect(() =>
      amendDocumentCommand.invoke(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        { versions: originalLog(), version: correction },
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it('a simulated grant allows the correction and returns the AuthorityDecision + version', () => {
    const invocation = amendDocumentCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      { versions: originalLog(), version: correction },
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.decision.capabilityId).toBe('documents.records');
    expect(invocation.result.version.kind).toBe('correction');
  });

  it('a protective/patient-right write (statement of disagreement) is refused by the gate', () => {
    expect(() =>
      amendDocumentCommand.invoke(
        registry,
        [simulatedGrant],
        { tenantId: tenant, scope: {} },
        {
          versions: originalLog(),
          version: versionInput({
            eventId: 'v2',
            versionNo: 2,
            kind: 'statement-of-disagreement',
            content: 'disagreement',
            concernsVersionNo: 1,
          }),
        },
      ),
    ).toThrow(DocumentError);
  });

  it('Riverbend (disabled) is denied — the standing opposite-state proof', () => {
    expect(() =>
      amendDocumentCommand.invoke(
        registry,
        seededGrants,
        { tenantId: 'riverbend-synthetic', scope: {} },
        {
          versions: appendDocumentVersion([], {
            ...versionInput({ eventId: 'v1', versionNo: 1, kind: 'original', content: 'orig' }),
            tenantId: 'riverbend-synthetic',
          }).versions,
          version: { ...correction, tenantId: 'riverbend-synthetic' },
        },
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
