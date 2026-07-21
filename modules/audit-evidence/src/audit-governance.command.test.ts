/**
 * The governance commands are capability-gated (standing invariant:
 * capability-state checks + AuthorityDecision on every authority-bearing
 * write). WP-020's own seed keeps `platform.audit-store` at `scaffolded`
 * (the package ceiling) — the seeded grant must DENY, the synthetic
 * `simulated` grant must allow, and Riverbend (disabled) stays denied.
 * `audit.emit` itself takes no grant — the deny path proves it still audits.
 */
import {
  CapabilityDeniedError,
  capabilityRegistryV1,
  foldCapabilityEvents,
  jurisdictionPacksV1,
  syntheticCapabilitySeedV1,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { auditInputForAuthorityDecision, validateAuditEmitInput } from './audit.js';
import {
  executeDestructionCommand,
  releaseLegalHoldCommand,
  type ExecuteDestructionCommandInput,
} from './commands/audit-governance.command.js';
import {
  evaluateDestructionEligibility,
  resolveRetentionClock,
  retentionScheduleV1,
  type LegalHold,
} from './retention.js';

const registry = capabilityRegistryV1;
const seededGrants: readonly CapabilityGrant[] = [
  ...syntheticCapabilitySeedV1.initialGrants,
  ...foldCapabilityEvents(registry, [], syntheticCapabilitySeedV1.events),
];
const tenant = 'northwind-synthetic';

const clock = resolveRetentionClock(
  jurisdictionPacksV1,
  retentionScheduleV1,
  'gfe-record',
  { providerState: 'NV', patientState: 'NV' },
  { minor: false },
);
const destructionInput: ExecuteDestructionCommandInput = {
  eligibility: evaluateDestructionEligibility(
    clock,
    {
      tenantId: tenant,
      recordClass: 'gfe-record',
      recordRefs: ['synthetic-gfe:cmd-test-0001'],
      recordDate: '2019-01-15',
    },
    [],
    '2026-03-20',
  ),
  holdsAtExecution: [],
  execution: {
    destructionId: 'ncd-0001',
    auditId: 'nca-0001',
    authorityRef: 'synthetic-staff:synthetic-compliance-001',
    executedBy: 'synthetic-staff:synthetic-compliance-001',
    occurredAt: '2026-03-20T12:00:00Z',
  },
};
const activeHold: LegalHold = {
  holdId: 'nch-0001',
  tenantId: tenant,
  matterRef: 'synthetic-matter-cmd',
  recordClasses: [],
  status: 'active',
  placedBy: 'synthetic-staff:synthetic-compliance-001',
  placedBasisRef: 'synthetic-hold-order-cmd',
  synthetic: true,
};
const simulatedGrant: CapabilityGrant = {
  capabilityId: 'platform.audit-store',
  tenantId: tenant,
  scope: {},
  state: 'simulated',
  sinceEventId: 'synthetic-cap-evt-test-0011',
  evidenceRefs: ['synthetic-gate:audit-sim-conformance'],
  rollbackRef: 'registry-event-replay',
  synthetic: true,
};

describe('audit governance command capability gate', () => {
  it('the WP-020 seed (scaffolded) DENIES live destruction — the ceiling is honored', () => {
    expect(() =>
      executeDestructionCommand.invoke(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        destructionInput,
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it('a denied invocation still audits: the thrown decision maps to a valid deny record', () => {
    try {
      executeDestructionCommand.invoke(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        destructionInput,
      );
      throw new Error('expected a CapabilityDeniedError');
    } catch (error) {
      if (!(error instanceof CapabilityDeniedError)) {
        throw error;
      }
      const auditInput = auditInputForAuthorityDecision(error.decision, {
        auditId: 'nca-deny-0001',
        actorRef: 'synthetic-staff:synthetic-compliance-001',
        occurredAt: '2026-03-20T12:00:00Z',
      });
      expect(() => validateAuditEmitInput(auditInput)).not.toThrow();
      expect(auditInput.decision).toBe('deny');
      expect(auditInput.detail?.['capability_id']).toBe('platform.audit-store');
    }
  });

  it('a simulated grant allows destruction and returns the AuthorityDecision', () => {
    const invocation = executeDestructionCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      destructionInput,
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.decision.capabilityId).toBe('platform.audit-store');
    expect(invocation.result.outcome).toBe('destroyed');
  });

  it('hold release moves under the same gate and honors the ceiling', () => {
    const input = {
      hold: activeHold,
      release: {
        releasedBy: 'synthetic-staff:synthetic-compliance-001',
        releaseEvidenceRef: 'synthetic-release-memo-cmd',
        auditId: 'nca-0002',
        occurredAt: '2026-03-20T12:30:00Z',
      },
    };
    expect(() =>
      releaseLegalHoldCommand.invoke(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        input,
      ),
    ).toThrow(CapabilityDeniedError);
    const allowed = releaseLegalHoldCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      input,
    );
    expect(allowed.result.hold.status).toBe('released');
  });

  it('Riverbend (disabled) is denied — the standing opposite-state proof', () => {
    expect(() =>
      executeDestructionCommand.invoke(
        registry,
        seededGrants,
        { tenantId: 'riverbend-synthetic', scope: {} },
        destructionInput,
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
