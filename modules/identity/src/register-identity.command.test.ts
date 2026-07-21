/**
 * The register-identity command is capability-gated (standing invariant:
 * capability-state checks + AuthorityDecision on every authority-bearing
 * write). WP-013's own seed keeps `identity.person-model` at `scaffolded`
 * (the package ceiling) — the seeded grant must DENY, the synthetic
 * `simulated` grant must allow, and Riverbend (disabled) stays denied.
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

import { registerIdentityCommand } from './commands/register-identity.command.js';
import type { RegisterIdentityCommandInput } from './commands/register-identity.command.js';

const registry = capabilityRegistryV1;
const seededGrants: readonly CapabilityGrant[] = [
  ...syntheticCapabilitySeedV1.initialGrants,
  ...foldCapabilityEvents(registry, [], syntheticCapabilitySeedV1.events),
];

const input: RegisterIdentityCommandInput = {
  inquiry: {
    tenantId: 'northwind-synthetic' as TenantId,
    proposedPersonId: 'np-new-inquiry' as PersonId,
    attributes: { givenName: 'Dana', familyName: 'Okafor' },
    provenance: { source: 'synthetic-web-form', capturedBy: 'synthetic-web-intake' },
  },
  existing: [],
};

describe('register-identity command capability gate', () => {
  it('the WP-013 seed (scaffolded) DENIES live registration — the ceiling is honored', () => {
    expect(() =>
      registerIdentityCommand.invoke(
        registry,
        seededGrants,
        { tenantId: 'northwind-synthetic' as TenantId, scope: {} },
        input,
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it('a simulated grant allows registration and returns the AuthorityDecision', () => {
    const simulatedGrant: CapabilityGrant = {
      capabilityId: 'identity.person-model',
      tenantId: 'northwind-synthetic',
      scope: {},
      state: 'simulated',
      sinceEventId: 'synthetic-cap-evt-test-0001',
      evidenceRefs: ['synthetic-gate:identity-sim-conformance'],
      rollbackRef: 'registry-event-replay',
      synthetic: true,
    };
    const invocation = registerIdentityCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: 'northwind-synthetic' as TenantId, scope: {} },
      input,
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.decision.capabilityId).toBe('identity.person-model');
    expect(invocation.result.outcome).toBe('provisional-created');
  });

  it('Riverbend (disabled) is denied — the standing opposite-state proof', () => {
    expect(() =>
      registerIdentityCommand.invoke(
        registry,
        seededGrants,
        { tenantId: 'riverbend-synthetic' as TenantId, scope: {} },
        {
          ...input,
          inquiry: { ...input.inquiry, tenantId: 'riverbend-synthetic' as TenantId },
        },
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
