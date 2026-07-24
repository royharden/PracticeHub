import {
  capabilityRegistryV1,
  CapabilityDeniedError,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { registerVendorBaaCommand } from './commands/register-vendor-baa.command.js';
import type { VendorRegistryEvent } from './vendor-registry.js';

const tenant = 'northwind-synthetic';
const context = { tenantId: tenant, scope: {} };

function grantAt(state: CapabilityGrant['state'], tenantId = tenant): CapabilityGrant[] {
  return [
    {
      capabilityId: 'platform.vendor-registry',
      tenantId,
      scope: {},
      state,
      sinceEventId: 'synthetic-cap-evt-0021',
      evidenceRefs: ['synthetic-gate:wp-026-vendor-registry-scaffold'],
      rollbackRef: 'registry-event-replay',
      synthetic: true,
    },
  ];
}

const executedEvent: VendorRegistryEvent = {
  tenantId: tenant,
  vendorId: 'synthetic-vendor',
  version: 2,
  kind: 'baa-executed',
  baaStatus: 'executed',
  baaEffective: '2026-01-05',
  baaExpiry: '2027-01-05',
  permittedCategories: ['ID', 'CLIN'],
  approvedBy: 'synthetic-compliance-officer',
  evidenceRef: 'synthetic-baa:executed',
  occurredAt: '2026-01-05T00:00:00Z',
  synthetic: true,
};

describe('registerVendorBaa command (platform.vendor-registry, floored simulated)', () => {
  it('DENIES a live BAA registration at the seeded package ceiling (scaffolded)', () => {
    expect(() =>
      registerVendorBaaCommand.invoke(capabilityRegistryV1, grantAt('scaffolded'), context, {
        event: executedEvent,
      }),
    ).toThrow(CapabilityDeniedError);
  });

  it('allows the write once the capability reaches simulated, returning the validated event', () => {
    const invocation = registerVendorBaaCommand.invoke(
      capabilityRegistryV1,
      grantAt('simulated'),
      context,
      {
        event: executedEvent,
      },
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.result).toBe(executedEvent);
  });

  it('Riverbend (disabled) cannot register — the standing opposite-state negative', () => {
    expect(() =>
      registerVendorBaaCommand.invoke(
        capabilityRegistryV1,
        grantAt('disabled', 'riverbend-synthetic'),
        { tenantId: 'riverbend-synthetic', scope: {} },
        { event: { ...executedEvent, tenantId: 'riverbend-synthetic' } },
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
