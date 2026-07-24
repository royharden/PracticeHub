/**
 * The discloseRecords command is capability-gated: releasing a patient's records
 * is a disclosure (PHI egress) and floors at `simulated`. WP-025 keeps
 * `documents.records` at `scaffolded`, so the seeded grant DENIES a live
 * disclosure; a synthetic `simulated` grant allows; Riverbend (disabled) is the
 * standing opposite-state proof.
 */
import {
  CapabilityDeniedError,
  capabilityRegistryV1,
  foldCapabilityEvents,
  syntheticCapabilitySeedV1,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { blobRefFor, hashContent } from './blob.js';
import type { PartitionTag } from './document.js';
import type { RecordsExportGuard, RecordsExportItem, RecordsRequest } from './records.js';
import { discloseRecordsCommand } from './commands/disclose-records.command.js';

const registry = capabilityRegistryV1;
const seededGrants: readonly CapabilityGrant[] = [
  ...syntheticCapabilitySeedV1.initialGrants,
  ...foldCapabilityEvents(registry, [], syntheticCapabilitySeedV1.events),
];
const tenant = 'northwind-synthetic';

// A minimal guard for the gate test — the REAL assembleRecordsExport discharge
// is proven in records.test.ts; here we only exercise the capability gate.
const guard: RecordsExportGuard = (req) => ({
  included: req.items.filter((item) => !item.partitionTags.includes('gipa-genetic')),
  excludedGenetic: req.items.filter((item) => item.partitionTags.includes('gipa-genetic')),
  authorizationCheckedAt: 'send-time',
});

const candidates: readonly RecordsExportItem[] = [
  { artifactRef: blobRefFor(hashContent('nd-0001-v2')), partitionTags: [], segment: 'clinical' },
];

function requestFor(t: string): RecordsRequest {
  return {
    requestId: 'ndd-cmd-0001',
    tenantId: t,
    subjectPersonRef: 'np-sam-porter',
    recipientRef: 'synthetic-auditor:state-board-0007',
    purpose: 'subpoena-audit',
    requestedBy: 'synthetic-staff:compliance-001',
    allowedSegments: ['clinical'],
    allowedPartitionTags: ['gipa-genetic'] as readonly PartitionTag[],
    sendDate: '2026-03-15',
    synthetic: true,
  };
}

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

describe('discloseRecords command capability gate', () => {
  it('the WP-025 seed (scaffolded) DENIES a live disclosure — the ceiling is honored', () => {
    expect(() =>
      discloseRecordsCommand.invoke(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        { request: requestFor(tenant), candidates, guard, authorizations: [] },
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it('a simulated grant allows the disclosure and returns the accounting record', () => {
    const invocation = discloseRecordsCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      { request: requestFor(tenant), candidates, guard, authorizations: [] },
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.decision.capabilityId).toBe('documents.records');
    expect(invocation.result.closureStatus).toBe('transmitted');
    expect(invocation.result.includedArtifactRefs).toHaveLength(1);
  });

  it('Riverbend (disabled) is denied — the standing opposite-state proof', () => {
    expect(() =>
      discloseRecordsCommand.invoke(
        registry,
        seededGrants,
        { tenantId: 'riverbend-synthetic', scope: {} },
        {
          request: requestFor('riverbend-synthetic'),
          candidates,
          guard,
          authorizations: [],
        },
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
