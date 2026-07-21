/**
 * Merge/unmerge commands are capability-gated (standing invariant:
 * capability-state checks + AuthorityDecision on every authority-bearing
 * write). WP-016's own seed keeps `identity.merge-governance` at `scaffolded`
 * (the package ceiling) — the seeded grant must DENY, a synthetic `simulated`
 * grant must allow, and Riverbend (disabled) stays denied.
 */
import {
  CapabilityDeniedError,
  capabilityRegistryV1,
  foldCapabilityEvents,
  syntheticCapabilitySeedV1,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import { executeMergeCommand, executeUnmergeCommand } from './commands/merge-governance.command.js';
import { openMergeCase, type MergeExecutionInput } from './merge.js';

const registry = capabilityRegistryV1;
const seededGrants: readonly CapabilityGrant[] = [
  ...syntheticCapabilitySeedV1.initialGrants,
  ...foldCapabilityEvents(registry, [], syntheticCapabilitySeedV1.events),
];

const tenant = 'northwind-synthetic' as TenantId;
const sam = 'np-sam-porter' as PersonId;
const samLegacy = 'np-sam-porter-legacy' as PersonId;

const input: MergeExecutionInput = {
  mergeCase: openMergeCase({
    caseId: 'nmc-cmd-0001',
    tenantId: tenant,
    kind: 'possible-match',
    personIds: [sam, samLegacy],
    matchedAttributes: ['given-name', 'family-name', 'birth-date'],
    confidence: 'high',
    openedBy: 'synthetic-migration-workbench',
    source: 'synthetic-acquisition-import',
  }),
  basis: {
    comparedAttributes: ['given-name', 'family-name', 'birth-date'],
    decidedBy: 'synthetic-data-migration-001',
  },
  eventId: 'nme-cmd-0001',
  survivorPersonId: sam,
  mergedPersonId: samLegacy,
  artifacts: [
    {
      kind: 'source-identifier',
      artifactRef: 'legacy-lakeside:lg-000778',
      ownerPersonId: samLegacy,
    },
  ],
  mergedPersonSourceIdRefs: ['legacy-lakeside:lg-000778'],
  rationale: 'synthetic acquisition duplicate confirmed',
  evidenceRef: 'synthetic-merge-evidence-cmd-0001',
};

const simulatedGrant: CapabilityGrant = {
  capabilityId: 'identity.merge-governance',
  tenantId: 'northwind-synthetic',
  scope: {},
  state: 'simulated',
  sinceEventId: 'synthetic-cap-evt-test-0003',
  evidenceRefs: ['synthetic-gate:merge-sim-conformance'],
  rollbackRef: 'registry-event-replay',
  synthetic: true,
};

describe('merge-governance command capability gate', () => {
  it('the WP-016 seed (scaffolded) DENIES live merge execution — the ceiling is honored', () => {
    expect(() =>
      executeMergeCommand.invoke(registry, seededGrants, { tenantId: tenant, scope: {} }, input),
    ).toThrow(CapabilityDeniedError);
  });

  it('a simulated grant allows the merge and returns the AuthorityDecision', () => {
    const invocation = executeMergeCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      input,
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.decision.capabilityId).toBe('identity.merge-governance');
    expect(invocation.result.resolvedCase.status).toBe('resolved-merged');
  });

  it('the unmerge command moves under the same capability — seeded grant denies, simulated allows', () => {
    const merged = executeMergeCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      input,
    );
    const unmergeInput = {
      mergeEvent: merged.result.event,
      lineage: merged.result.lineage,
      postMergeArtifacts: [],
      eventId: 'nme-cmd-0002',
      approvedBy: 'synthetic-compliance-001',
      rationale: 'synthetic reversal drill',
    };
    expect(() =>
      executeUnmergeCommand.invoke(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        unmergeInput,
      ),
    ).toThrow(CapabilityDeniedError);
    const invocation = executeUnmergeCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      unmergeInput,
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.result.outcome).toBe('unmerged');
  });

  it('Riverbend (disabled) is denied — the standing opposite-state proof', () => {
    expect(() =>
      executeMergeCommand.invoke(
        registry,
        seededGrants,
        { tenantId: 'riverbend-synthetic' as TenantId, scope: {} },
        input,
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
