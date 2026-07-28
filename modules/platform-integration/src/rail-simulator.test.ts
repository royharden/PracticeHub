import {
  capabilityRegistryV1,
  CapabilityDeniedError,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { injectRailScenarioCommand } from './commands/inject-rail-scenario.command.js';
import {
  railSimulatorKillPoints,
  railSimulatorPrimitiveIdPattern,
  validateRailScenarioRequest,
  RailScenarioError,
  type RailScenarioRequest,
} from './rail-simulator.js';

const tenant = 'northwind-synthetic';
const context = { tenantId: tenant, scope: {} };

function grantAt(state: CapabilityGrant['state'], tenantId = tenant): CapabilityGrant[] {
  return [
    {
      capabilityId: 'platform.rail-simulator',
      tenantId,
      scope: {},
      state,
      sinceEventId: 'synthetic-cap-evt-0022',
      evidenceRefs: ['synthetic-gate:wp-027-rail-simulator-scaffold'],
      rollbackRef: 'sim-reset',
      synthetic: true,
    },
  ];
}

const scenario: RailScenarioRequest = {
  railId: 'RAIL-008',
  primitiveId: 'X-06',
  dataPolicy: 'synthetic-only',
  options: { count: 1 },
};

describe('rail-scenario request validation (below the registry, no override path)', () => {
  it('refuses any environment that is not synthetic-only', () => {
    for (const dataPolicy of ['production', 'staging', 'unknown', '']) {
      expect(() => validateRailScenarioRequest({ ...scenario, dataPolicy })).toThrow(
        /synthetic-only environment/,
      );
    }
  });

  it('refuses ids outside the frozen grammars', () => {
    expect(() => validateRailScenarioRequest({ ...scenario, railId: 'stripe' })).toThrow(
      /is not a RAIL-### id/,
    );
    expect(() => validateRailScenarioRequest({ ...scenario, primitiveId: 'crash' })).toThrow(
      /is not an X-## injection primitive id/,
    );
    expect(railSimulatorPrimitiveIdPattern.test('X-18')).toBe(true);
    expect(railSimulatorPrimitiveIdPattern.test('X-180')).toBe(false);
  });

  it('refuses nonsensical options and unknown kill points', () => {
    expect(() =>
      validateRailScenarioRequest({ ...scenario, options: { afterAttempts: 0 } }),
    ).toThrow(RailScenarioError);
    expect(() => validateRailScenarioRequest({ ...scenario, options: { count: -1 } })).toThrow(
      /non-negative integer/,
    );
    expect(() => validateRailScenarioRequest({ ...scenario, options: { delayMs: -5 } })).toThrow(
      /non-negative integer/,
    );
    expect(() =>
      validateRailScenarioRequest({
        ...scenario,
        options: { killPoint: 'whenever' as (typeof railSimulatorKillPoints)[number] },
      }),
    ).toThrow(/unknown kill point/);
  });

  it('accepts a well-formed request against a synthetic-only environment', () => {
    expect(() => validateRailScenarioRequest(scenario)).not.toThrow();
    for (const killPoint of railSimulatorKillPoints) {
      expect(() =>
        validateRailScenarioRequest({ ...scenario, primitiveId: 'X-02', options: { killPoint } }),
      ).not.toThrow();
    }
  });
});

describe('injectRailScenario command (platform.rail-simulator, floored simulated)', () => {
  it('DENIES a live injection at the seeded package ceiling (scaffolded)', () => {
    expect(() =>
      injectRailScenarioCommand.invoke(capabilityRegistryV1, grantAt('scaffolded'), context, {
        scenario,
      }),
    ).toThrow(CapabilityDeniedError);
  });

  it('allows the injection once the capability reaches simulated', () => {
    const invocation = injectRailScenarioCommand.invoke(
      capabilityRegistryV1,
      grantAt('simulated'),
      context,
      { scenario },
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.result).toBe(scenario);
  });

  it('Riverbend (disabled) cannot inject — the standing opposite-state negative', () => {
    expect(() =>
      injectRailScenarioCommand.invoke(
        capabilityRegistryV1,
        grantAt('disabled', 'riverbend-synthetic'),
        { tenantId: 'riverbend-synthetic', scope: {} },
        { scenario },
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it('a capability grant cannot buy past the synthetic-only floor', () => {
    expect(() =>
      injectRailScenarioCommand.invoke(capabilityRegistryV1, grantAt('active'), context, {
        scenario: { ...scenario, dataPolicy: 'production' },
      }),
    ).toThrow(/synthetic-only environment/);
  });
});
