/**
 * The destroyDocument command is capability-gated: executing a destruction
 * disposes of a patient's record and floors at `simulated` (the audit-store
 * governance precedent). WP-025 keeps `documents.records` at `scaffolded`, so
 * the seeded grant DENIES a live destruction; a synthetic `simulated` grant
 * allows; Riverbend (disabled) is the standing opposite-state proof. Eligibility
 * evaluation is pure/unguarded — only execution is gated.
 */
import { retentionScheduleV1 } from '@practicehub/audit-evidence';
import {
  CapabilityDeniedError,
  capabilityRegistryV1,
  foldCapabilityEvents,
  jurisdictionPacksV1,
  syntheticCapabilitySeedV1,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { blobRefFor, hashContent } from './blob.js';
import { planDocumentDestruction } from './records.js';
import { destroyDocumentCommand } from './commands/destroy-document.command.js';

const registry = capabilityRegistryV1;
const seededGrants: readonly CapabilityGrant[] = [
  ...syntheticCapabilitySeedV1.initialGrants,
  ...foldCapabilityEvents(registry, [], syntheticCapabilitySeedV1.events),
];
const tenant = 'northwind-synthetic';

function eligibilityFor(t: string): ReturnType<typeof planDocumentDestruction> {
  return planDocumentDestruction(
    jurisdictionPacksV1,
    retentionScheduleV1,
    {
      tenantId: t,
      documentId: 'nd-0001',
      recordRefs: [blobRefFor(hashContent('nd-0001-v2'))],
      recordClass: 'clinical-record',
      recordDate: '2010-01-01',
      subjectMinor: false,
      jurisdictionBasis: { providerState: 'NV', patientState: 'NV' },
    },
    [],
    '2026-03-20',
  );
}

const execution = {
  destructionId: 'ndx-cmd-0001',
  auditId: 'nax-cmd-0001',
  authorityRef: 'synthetic-staff:records-officer-001',
  executedBy: 'synthetic-staff:records-officer-001',
  occurredAt: '2026-03-20T00:00:00Z',
};

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

describe('destroyDocument command capability gate', () => {
  it('the WP-025 seed (scaffolded) DENIES a live destruction — the ceiling is honored', () => {
    expect(() =>
      destroyDocumentCommand.invoke(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        { eligibility: eligibilityFor(tenant), holdsAtExecution: [], execution },
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it('a simulated grant allows the destruction and returns the evidence outcome', () => {
    const invocation = destroyDocumentCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      { eligibility: eligibilityFor(tenant), holdsAtExecution: [], execution },
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.decision.capabilityId).toBe('documents.records');
    expect(invocation.result.outcome).toBe('destroyed');
  });

  it('Riverbend (disabled) is denied — the standing opposite-state proof', () => {
    expect(() =>
      destroyDocumentCommand.invoke(
        registry,
        seededGrants,
        { tenantId: 'riverbend-synthetic', scope: {} },
        { eligibility: eligibilityFor('riverbend-synthetic'), holdsAtExecution: [], execution },
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
