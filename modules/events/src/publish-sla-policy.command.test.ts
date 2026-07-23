import {
  capabilityRegistryV1,
  CapabilityDeniedError,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { publishSlaPolicyCommand } from './commands/publish-sla-policy.command.js';
import type { SlaPolicy } from './sla.js';

const tenant = 'northwind-synthetic';
const context = { tenantId: tenant, scope: {} };

const policy: SlaPolicy = {
  policyId: 'sla-concierge',
  version: 2,
  effectiveOn: '2026-06-01',
  memberTier: 'concierge',
  hoursMode: 'after_hours',
  firstResponseTargetMinutes: 30,
  nextResponseTargetMinutes: 30,
  resolutionTargetMinutes: 240,
  escalationChain: [{ afterMinutes: 30, action: 'notify_owner', target: 'synthetic-role:owner' }],
  quietHoursExempt: true,
};

function grantAt(state: CapabilityGrant['state'], tenantId = tenant): CapabilityGrant[] {
  return [
    {
      capabilityId: 'platform.tasking-engine',
      tenantId,
      scope: {},
      state,
      sinceEventId: 'synthetic-cap-evt-0017',
      evidenceRefs: ['synthetic-gate:wp-022-tasking-engine-scaffold'],
      rollbackRef: 'registry-event-replay',
      synthetic: true,
    },
  ];
}

const input = {
  tenantId: tenant,
  policy,
  actorRef: 'synthetic-ops-admin',
  occurredAt: '2026-05-01T00:00:00Z',
};

describe('publish-sla-policy command (platform.tasking-engine, floored simulated)', () => {
  it('DENIES a live publish at the seeded package ceiling (scaffolded)', () => {
    expect(() =>
      publishSlaPolicyCommand.invoke(capabilityRegistryV1, grantAt('scaffolded'), context, input),
    ).toThrow(CapabilityDeniedError);
  });

  it('allows a publish once the capability reaches simulated, yielding the config-change audit input', () => {
    const invocation = publishSlaPolicyCommand.invoke(
      capabilityRegistryV1,
      grantAt('simulated'),
      context,
      input,
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.result.auditInput.stream).toBe('config-change');
    expect(invocation.result.auditInput.detail.config_ref).toBe('sla-policy:sla-concierge:v2');
  });

  it('Riverbend (disabled) cannot publish — the standing opposite-state negative', () => {
    expect(() =>
      publishSlaPolicyCommand.invoke(
        capabilityRegistryV1,
        grantAt('disabled', 'riverbend-synthetic'),
        { tenantId: 'riverbend-synthetic', scope: {} },
        { ...input, tenantId: 'riverbend-synthetic' },
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
