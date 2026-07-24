import {
  capabilityRegistryV1,
  CapabilityDeniedError,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { publishOnCallRotationCommand } from './commands/publish-oncall-rotation.command.js';
import type { OnCallRotation } from './oncall.js';

const tenant = 'northwind-synthetic';
const context = { tenantId: tenant, scope: {} };

const rotation: OnCallRotation = {
  rotationId: 'oncall-concierge-nv',
  version: 2,
  effectiveOn: '2026-06-01',
  locationId: 'loc-nv-lasvegas',
  coverageMode: '24x7',
  serviceScopes: ['concierge-urgent', 'longevity'],
  memberOrder: [
    { memberRef: 'synthetic-provider:reyes', serviceScopes: ['concierge-urgent', 'longevity'] },
  ],
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
  rotation,
  actorRef: 'synthetic-ops-admin',
  occurredAt: '2026-05-01T00:00:00Z',
};

describe('publish-oncall-rotation command (platform.tasking-engine, floored simulated)', () => {
  it('DENIES a live publish at the seeded package ceiling (scaffolded)', () => {
    expect(() =>
      publishOnCallRotationCommand.invoke(
        capabilityRegistryV1,
        grantAt('scaffolded'),
        context,
        input,
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it('allows a publish once the capability reaches simulated, yielding the config-change audit input', () => {
    const invocation = publishOnCallRotationCommand.invoke(
      capabilityRegistryV1,
      grantAt('simulated'),
      context,
      input,
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.result.auditInput.stream).toBe('config-change');
    expect(invocation.result.auditInput.detail.config_ref).toBe(
      'oncall-rotation:oncall-concierge-nv:v2',
    );
  });

  it('Riverbend (disabled) cannot publish — the standing opposite-state negative', () => {
    expect(() =>
      publishOnCallRotationCommand.invoke(
        capabilityRegistryV1,
        grantAt('disabled', 'riverbend-synthetic'),
        { tenantId: 'riverbend-synthetic', scope: {} },
        { ...input, tenantId: 'riverbend-synthetic' },
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
