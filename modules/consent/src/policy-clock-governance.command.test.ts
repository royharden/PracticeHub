/**
 * Recording a clock's evidence-of-completion is an authority-bearing attestation
 * (standing invariant: capability-state checks + AuthorityDecision on every
 * authority-bearing write). WP-019's own seed keeps `consent.policy-clocks` at
 * `scaffolded` (the package ceiling) — the seeded grant must DENY a live
 * satisfaction, the synthetic `simulated` grant must allow, and Riverbend
 * (disabled) stays denied. Protective/automatic writes never route here.
 */
import {
  CapabilityDeniedError,
  capabilityRegistryV1,
  foldCapabilityEvents,
  syntheticCapabilitySeedV1,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { triggerClock, type ObligationClock } from './clocks.js';
import { recordClockSatisfactionCommand } from './commands/policy-clock-governance.command.js';
import { obligationClockPoliciesV1 } from './policy-clock-seed.js';

const registry = capabilityRegistryV1;
const seededGrants: readonly CapabilityGrant[] = [
  ...syntheticCapabilitySeedV1.initialGrants,
  ...foldCapabilityEvents(registry, [], syntheticCapabilitySeedV1.events),
];
const tenant = 'northwind-synthetic';

const instance: ObligationClock = triggerClock({
  tenantId: tenant,
  clockId: 'clk-cmd-1',
  clockEventId: 'cle-cmd-1',
  obligationType: 'records-request-closure',
  subjectRef: 'np-cmd',
  triggerRef: 'records-request:cmd',
  triggeredAt: '2026-02-01T00:00:00.000Z',
  actorRef: 'synthetic-clock',
  basis: { providerState: 'IL', patientState: 'IL' },
  policies: obligationClockPoliciesV1,
}).instance;

const satisfaction = {
  instance,
  clockEventId: 'cle-cmd-2',
  occurredAt: '2026-02-20T00:00:00.000Z',
  actorRef: 'synthetic-records-officer',
  evidenceRef: 'records-release:cmd',
};

const simulatedGrant: CapabilityGrant = {
  capabilityId: 'consent.policy-clocks',
  tenantId: tenant,
  scope: {},
  state: 'simulated',
  sinceEventId: 'synthetic-cap-evt-test-0016',
  evidenceRefs: ['synthetic-gate:policy-clocks-sim-conformance'],
  rollbackRef: 'registry-event-replay',
  synthetic: true,
};

describe('clock satisfaction command capability gate', () => {
  it('the WP-019 seed (scaffolded) DENIES a live satisfaction — the ceiling is honored', () => {
    expect(() =>
      recordClockSatisfactionCommand.invoke(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        satisfaction,
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it('a denied invocation carries a deny AuthorityDecision for consent.policy-clocks', () => {
    try {
      recordClockSatisfactionCommand.invoke(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        satisfaction,
      );
      throw new Error('expected a CapabilityDeniedError');
    } catch (error) {
      if (!(error instanceof CapabilityDeniedError)) {
        throw error;
      }
      expect(error.decision.allowed).toBe(false);
      expect(error.decision.capabilityId).toBe('consent.policy-clocks');
    }
  });

  it('a simulated grant allows the write and returns the AuthorityDecision + audit input', () => {
    const invocation = recordClockSatisfactionCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      satisfaction,
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.decision.capabilityId).toBe('consent.policy-clocks');
    expect(invocation.result.instance.status).toBe('satisfied');
    expect(invocation.result.auditInput.stream).toBe('config-change');
  });

  it('Riverbend (disabled) is denied — the standing opposite-state proof', () => {
    expect(() =>
      recordClockSatisfactionCommand.invoke(
        registry,
        seededGrants,
        { tenantId: 'riverbend-synthetic', scope: {} },
        { ...satisfaction, instance: { ...instance, tenantId: 'riverbend-synthetic' } },
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
