/**
 * The consent grant command is capability-gated (standing invariant:
 * capability-state checks + AuthorityDecision on every authority-bearing
 * write). WP-018's own seed keeps `consent.operational` at `scaffolded` (the
 * package ceiling) — the seeded grant must DENY live grant recording, the
 * synthetic `simulated` grant must allow, and Riverbend (disabled) stays
 * denied. Protective writes (revoke) never route through this gate.
 */
import {
  CapabilityDeniedError,
  capabilityRegistryV1,
  foldCapabilityEvents,
  syntheticCapabilitySeedV1,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { ConsentError, type ConsentEventInput } from './consent.js';
import { recordConsentGrantCommand } from './commands/consent-governance.command.js';

const registry = capabilityRegistryV1;
const seededGrants: readonly CapabilityGrant[] = [
  ...syntheticCapabilitySeedV1.initialGrants,
  ...foldCapabilityEvents(registry, [], syntheticCapabilitySeedV1.events),
];
const tenant = 'northwind-synthetic';

const grantInput: ConsentEventInput = {
  consentEventId: 'nce-cmd-0001',
  tenantId: tenant,
  personRef: 'np-cmd',
  scope: { type: 'communication', channel: 'sms', purpose: 'treatment' },
  action: 'grant',
  effectiveAt: '2026-03-20T00:00:00Z',
  source: 'portal_form',
  evidenceRef: 'synthetic-consent:nce-cmd-0001',
  jurisdiction: 'NV',
  policyVersion: 'consent-v1',
  synthetic: true,
};

const simulatedGrant: CapabilityGrant = {
  capabilityId: 'consent.operational',
  tenantId: tenant,
  scope: {},
  state: 'simulated',
  sinceEventId: 'synthetic-cap-evt-test-0014',
  evidenceRefs: ['synthetic-gate:consent-sim-conformance'],
  rollbackRef: 'registry-event-replay',
  synthetic: true,
};

describe('consent grant command capability gate', () => {
  it('the WP-018 seed (scaffolded) DENIES live grant recording — the ceiling is honored', () => {
    expect(() =>
      recordConsentGrantCommand.invoke(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        { log: [], event: grantInput },
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it('a denied invocation carries a deny AuthorityDecision for consent.operational', () => {
    try {
      recordConsentGrantCommand.invoke(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        { log: [], event: grantInput },
      );
      throw new Error('expected a CapabilityDeniedError');
    } catch (error) {
      if (!(error instanceof CapabilityDeniedError)) {
        throw error;
      }
      expect(error.decision.allowed).toBe(false);
      expect(error.decision.capabilityId).toBe('consent.operational');
    }
  });

  it('a simulated grant allows the write and returns the AuthorityDecision + event', () => {
    const invocation = recordConsentGrantCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      { log: [], event: grantInput },
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.decision.capabilityId).toBe('consent.operational');
    expect(invocation.result.event.resultingState).toBe('opted_in');
    expect(invocation.result.log).toHaveLength(1);
  });

  it('rejects a protective action routed through the gate (revoke goes ungated)', () => {
    expect(() =>
      recordConsentGrantCommand.invoke(
        registry,
        [simulatedGrant],
        { tenantId: tenant, scope: {} },
        {
          log: [],
          event: { ...grantInput, action: 'revoke', source: 'sms_keyword' },
        },
      ),
    ).toThrow(ConsentError);
  });

  it('Riverbend (disabled) is denied — the standing opposite-state proof', () => {
    expect(() =>
      recordConsentGrantCommand.invoke(
        registry,
        seededGrants,
        { tenantId: 'riverbend-synthetic', scope: {} },
        { log: [], event: { ...grantInput, tenantId: 'riverbend-synthetic' } },
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
