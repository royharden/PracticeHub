/**
 * PDP governance commands are capability-gated (standing invariant:
 * capability-state checks + AuthorityDecision on every authority-bearing
 * write). WP-015's own seed keeps `identity.access-policy` at `scaffolded`
 * (the package ceiling) — the seeded grant must DENY, a synthetic
 * `simulated` grant must allow, and Riverbend (disabled) stays denied. The
 * denied invocation's AuthorityDecision still maps to a valid deny audit
 * record (the WP-020 mapping helper accepts it).
 */
import {
  auditInputForAuthorityDecision,
  emitAuditEvent,
  emptyChainState,
} from '@practicehub/audit-evidence';
import {
  CapabilityDeniedError,
  capabilityRegistryV1,
  foldCapabilityEvents,
  jurisdictionPacksV1,
  requireCapability,
  syntheticCapabilitySeedV1,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import {
  assignRoleCommand,
  establishAuthorityCommand,
  unlockDeceasedChartCommand,
} from './commands/pdp-governance.command.js';
import type { RoleAssignment } from './pdp.js';
import type { AuthorityRecord } from './proxy-authority.js';

const registry = capabilityRegistryV1;
const seededGrants: readonly CapabilityGrant[] = [
  ...syntheticCapabilitySeedV1.initialGrants,
  ...foldCapabilityEvents(registry, [], syntheticCapabilitySeedV1.events),
];

const tenant = 'northwind-synthetic' as TenantId;

const assignment: RoleAssignment = {
  tenantId: tenant,
  assignmentId: 'nra-cmd-0001',
  staffAccountId: 'nsa-morgan-lee',
  staffPersonId: 'np-morgan-lee' as PersonId,
  roleKey: 'front-desk',
  templateVersion: 1,
  locationScope: [],
  effectiveDate: '2026-03-01',
  status: 'active',
  assignedBy: 'synthetic-it-admin-001',
  synthetic: true,
};

const record: AuthorityRecord = {
  tenantId: tenant,
  authorityId: 'nar-cmd-0001',
  version: 1,
  kind: 'guardian-minor',
  granteePersonId: 'np-alex-rivera' as PersonId,
  subjectPersonId: 'np-casey-rivera' as PersonId,
  scope: [{ segment: 'scheduling', actions: ['view'] }],
  jurisdiction: 'NV',
  evidenceRef: 'synthetic-guardian-evidence-cmd-0001',
  effectiveDate: '2026-03-01',
  status: 'pending-verification',
  decidedBy: 'synthetic-front-desk-001',
  synthetic: true,
};

const simulatedGrant: CapabilityGrant = {
  capabilityId: 'identity.access-policy',
  tenantId: 'northwind-synthetic',
  scope: {},
  state: 'simulated',
  sinceEventId: 'synthetic-cap-evt-test-0004',
  evidenceRefs: ['synthetic-gate:pdp-sim-conformance'],
  rollbackRef: 'registry-event-replay',
  synthetic: true,
};

describe('pdp-governance command capability gate', () => {
  it('the WP-015 seed (scaffolded) DENIES live role assignment — the ceiling is honored', () => {
    expect(() =>
      assignRoleCommand.invoke(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        { existing: [], next: assignment },
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it('a denied invocation’s thrown decision still maps to a VALID deny audit record (FWD-AUD-015-PDP)', () => {
    let denied: CapabilityDeniedError | undefined;
    try {
      requireCapability(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        'identity.access-policy',
        { minimumState: 'simulated', checkpoint: 'enqueue' },
      );
    } catch (error) {
      denied = error as CapabilityDeniedError;
    }
    if (denied === undefined) {
      throw new Error('expected the scaffolded seed to deny');
    }
    expect(denied.decision.allowed).toBe(false);
    const emitted = emitAuditEvent(
      emptyChainState,
      auditInputForAuthorityDecision(denied.decision, {
        auditId: 'fx-pdp-authority-0001',
        actorRef: 'synthetic-staff:nsa-morgan-lee',
        occurredAt: '2026-03-25T10:00:00Z',
      }),
    );
    expect(emitted.record.decision).toBe('deny');
    expect(emitted.record.detail?.['capability_id']).toBe('identity.access-policy');
  });

  it('a simulated grant allows the three commands and returns AuthorityDecisions', () => {
    const assigned = assignRoleCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      { existing: [], next: assignment },
    );
    expect(assigned.decision.allowed).toBe(true);
    expect(assigned.result.active.assignmentId).toBe('nra-cmd-0001');

    const established = establishAuthorityCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      {
        record,
        relationshipVerified: true,
        verifiedBy: 'synthetic-front-desk-001',
        packs: jurisdictionPacksV1,
        providerState: 'NV',
      },
    );
    expect(established.decision.capabilityId).toBe('identity.access-policy');
    expect(established.result.outcome).toBe('established');

    const unlocked = unlockDeceasedChartCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      {
        unlockRef: 'neu-cmd-0001',
        personId: 'np-riley-fox' as PersonId,
        actorRoleKeys: ['practice-manager'],
        documentedPurposeRef: 'synthetic-estate-purpose-cmd-0001',
      },
    );
    expect(unlocked.result.unlockedByRole).toBe('practice-manager');
  });

  it('Riverbend (disabled) is denied — the standing opposite-state proof', () => {
    expect(() =>
      establishAuthorityCommand.invoke(
        registry,
        seededGrants,
        { tenantId: 'riverbend-synthetic' as TenantId, scope: {} },
        {
          record: { ...record, tenantId: 'riverbend-synthetic' as TenantId },
          relationshipVerified: true,
          verifiedBy: 'synthetic-front-desk-101',
          packs: jurisdictionPacksV1,
          providerState: null,
        },
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
