import { describe, expect, it } from 'vitest';

import {
  canonicalScopeKey,
  CapabilityDeniedError,
  CapabilityRegistryError,
  requireCapability,
  resolveCapabilityGrant,
  listGrantMatrix,
  type CapabilityGrant,
  type CapabilityRegistry,
  type CapabilityScope,
  type CapabilityState,
} from './capability.js';
import { capabilityDefinitionsV1, capabilityRegistryV1 } from './capability-definitions.js';
import { capabilityTransitionCommand } from './commands/capability-transition.command.js';
import { defineCommandHandler } from './commands.js';

/** Test capability with three optional dimensions and an explicit precedence. */
const testRegistry: CapabilityRegistry = {
  ...capabilityRegistryV1,
  definitions: [
    ...capabilityDefinitionsV1,
    {
      capabilityId: 'testmod.widget',
      ownerRole: 'qa',
      dimensions: ['payer', 'location', 'channel'],
      precedence: ['payer', 'location', 'channel'],
      description: 'resolution-test capability',
    },
  ],
};

function widgetGrant(scope: CapabilityScope, state: CapabilityState): CapabilityGrant {
  return {
    capabilityId: 'testmod.widget',
    tenantId: 'northwind-synthetic',
    scope,
    state,
    sinceEventId: 'synthetic-cap-evt-res',
    evidenceRefs: ['synthetic-gate:res'],
    rollbackRef: 'registry-event-replay',
    synthetic: true,
  };
}

const fullContext = {
  tenantId: 'northwind-synthetic',
  scope: { payer: 'synthetic-payer-aurora', location: 'northwind-nv-henderson', channel: 'sms' },
} as const;

describe('scope resolution (specificity + declared precedence, deny-by-default)', () => {
  it('denies by default: no grant, no authority — and the decision records the denial', () => {
    try {
      requireCapability(testRegistry, [], fullContext, 'testmod.widget');
      expect.unreachable('expected a denial');
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityDeniedError);
      const decision = (error as CapabilityDeniedError).decision;
      expect(decision.allowed).toBe(false);
      expect(decision.grantState).toBe('disabled');
      expect(decision.reason).toContain('deny-by-default');
    }
  });

  it('the most specific grant wins: two matching dimensions beat one, beat zero', () => {
    const grants = [
      widgetGrant({}, 'simulated'),
      widgetGrant({ payer: 'synthetic-payer-aurora' }, 'shadow'),
      widgetGrant({ payer: 'synthetic-payer-aurora', location: 'northwind-nv-henderson' }, 'pilot'),
    ];
    const decision = requireCapability(testRegistry, grants, fullContext, 'testmod.widget');
    expect(decision.grantState).toBe('pilot');
    expect(decision.grantScopeKey).toBe(
      'location=northwind-nv-henderson/payer=synthetic-payer-aurora',
    );
  });

  it('equal specificity breaks by the declared precedence list (payer before location)', () => {
    const grants = [
      widgetGrant({ location: 'northwind-nv-henderson' }, 'shadow'),
      widgetGrant({ payer: 'synthetic-payer-aurora' }, 'pilot'),
    ];
    const resolved = resolveCapabilityGrant(testRegistry, grants, fullContext, 'testmod.widget');
    expect(canonicalScopeKey(resolved?.scope ?? {})).toBe('payer=synthetic-payer-aurora');
  });

  it('a grant scoped to a dimension value the context lacks never matches', () => {
    const grants = [widgetGrant({ payer: 'synthetic-payer-beacon' }, 'active')];
    expect(() => requireCapability(testRegistry, grants, fullContext, 'testmod.widget')).toThrow(
      CapabilityDeniedError,
    );
  });

  it('cross-tenant grants are never observable (Riverbend context, tenant-1 grants)', () => {
    const grants = [widgetGrant({}, 'active')];
    expect(() =>
      requireCapability(
        testRegistry,
        grants,
        { tenantId: 'riverbend-synthetic', scope: {} },
        'testmod.widget',
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it('minimumState bands: simulated grant satisfies a simulated floor, never the pilot default', () => {
    const grants = [widgetGrant({}, 'simulated')];
    expect(() => requireCapability(testRegistry, grants, fullContext, 'testmod.widget')).toThrow(
      CapabilityDeniedError,
    );
    const decision = requireCapability(testRegistry, grants, fullContext, 'testmod.widget', {
      minimumState: 'simulated',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.minimumState).toBe('simulated');
  });

  it('write-blocked states never satisfy a side-effect check (read-only, retiring)', () => {
    for (const state of ['read-only', 'retiring'] as const) {
      expect(() =>
        requireCapability(testRegistry, [widgetGrant({}, state)], fullContext, 'testmod.widget', {
          minimumState: 'simulated',
        }),
      ).toThrow(CapabilityDeniedError);
    }
  });

  it('an undeclared capability fails closed as a registry error', () => {
    expect(() => requireCapability(testRegistry, [], fullContext, 'testmod.unregistered')).toThrow(
      CapabilityRegistryError,
    );
  });

  it('a grant binding an undeclared dimension is invalid, never silently skipped', () => {
    const rogue = {
      ...widgetGrant({}, 'active'),
      scope: { wave: 'synthetic-wave-01' } as CapabilityScope,
    };
    expect(() => requireCapability(testRegistry, [rogue], fullContext, 'testmod.widget')).toThrow(
      CapabilityRegistryError,
    );
  });

  it('a path-specific capability refuses broad grants (required dimensions missing)', () => {
    const broad: CapabilityGrant = {
      capabilityId: 'rcm.rail-path',
      tenantId: 'northwind-synthetic',
      scope: { payer: 'synthetic-payer-aurora' },
      state: 'active',
      sinceEventId: 'synthetic-cap-evt-broad',
      evidenceRefs: ['synthetic-gate:broad'],
      rollbackRef: 'registry-event-replay',
      synthetic: true,
    };
    expect(() =>
      requireCapability(
        capabilityRegistryV1,
        [broad],
        {
          tenantId: 'northwind-synthetic',
          scope: {
            payer: 'synthetic-payer-aurora',
            provider: 'synthetic-dr-lee',
            transaction: 'x12-835',
          },
        },
        'rcm.rail-path',
      ),
    ).toThrow(/requires dimension/);
  });

  it('an invalid minimumState is a registry error, not a silent widen', () => {
    expect(() =>
      requireCapability(testRegistry, [], fullContext, 'testmod.widget', {
        minimumState: 'disabled' as CapabilityState,
      }),
    ).toThrow(CapabilityRegistryError);
  });

  it('the decision echoes checkpoint, registry version, and purpose for the audit trail', () => {
    const grants = [widgetGrant({}, 'active')];
    const decision = requireCapability(testRegistry, grants, fullContext, 'testmod.widget', {
      checkpoint: 'enqueue',
      registryVersion: 7,
      purpose: 'treatment-operations',
    });
    expect(decision.checkpoint).toBe('enqueue');
    expect(decision.registryVersion).toBe(7);
    expect(decision.purpose).toBe('treatment-operations');
    expect(decision.sinceEventId).toBe('synthetic-cap-evt-res');
  });
});

describe('console grant matrix', () => {
  it('lists every path independently, sorted, with its own state and evidence', () => {
    const grants = [
      widgetGrant({ payer: 'synthetic-payer-aurora' }, 'pilot'),
      widgetGrant({}, 'simulated'),
    ];
    const rows = listGrantMatrix(testRegistry, grants, { capabilityId: 'testmod.widget' });
    expect(rows.map((row) => row.scopeKey)).toEqual(['(root)', 'payer=synthetic-payer-aurora']);
    expect(rows.map((row) => row.state)).toEqual(['simulated', 'pilot']);
    expect(rows.every((row) => row.evidenceRefs.length > 0)).toBe(true);
  });
});

describe('command handlers (defineCommandHandler)', () => {
  const registryGrant: CapabilityGrant = {
    capabilityId: 'platform.capability-registry',
    tenantId: 'northwind-synthetic',
    scope: {},
    state: 'simulated',
    sinceEventId: 'synthetic-cap-evt-0002',
    evidenceRefs: ['synthetic-gate:wp-012-registry-simulated'],
    rollbackRef: 'registry-event-replay',
    synthetic: true,
  };

  it('defaults to the pilot floor: a handler is authority-bearing unless it opts down', () => {
    const handler = defineCommandHandler({
      capabilityId: 'testmod.widget',
      handle: () => 'ran',
    });
    expect(handler.minimumState).toBe('pilot');
  });

  it('denies before the handler body runs — the body never observes a denied context', () => {
    let ran = false;
    const handler = defineCommandHandler({
      capabilityId: 'testmod.widget',
      minimumState: 'simulated',
      handle: () => {
        ran = true;
        return 'ran';
      },
    });
    expect(() => handler.invoke(testRegistry, [], fullContext, undefined)).toThrow(
      CapabilityDeniedError,
    );
    expect(ran).toBe(false);
  });

  it('the registry transition command runs for tenant 1 and returns decision + event', () => {
    const { decision, result } = capabilityTransitionCommand.invoke(
      capabilityRegistryV1,
      [registryGrant],
      { tenantId: 'northwind-synthetic', scope: {} },
      {
        registry: capabilityRegistryV1,
        grants: [],
        request: {
          tenantId: 'northwind-synthetic',
          capabilityId: 'platform.bootstrap',
          scope: {},
          fromState: 'disabled',
          toState: 'scaffolded',
          initiatorRef: 'synthetic-initiator',
          approvals: [{ approverRef: 'synthetic-approver', role: 'architecture' }],
          evidenceRefs: ['synthetic-gate:cmd'],
          rollbackRef: 'registry-event-replay',
        },
        eventId: 'synthetic-cap-evt-cmd-0001',
      },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.checkpoint).toBe('drain');
    expect(result.toState).toBe('scaffolded');
  });

  it('Riverbend (opposite capability state) cannot apply transitions at all', () => {
    expect(() =>
      capabilityTransitionCommand.invoke(
        capabilityRegistryV1,
        [{ ...registryGrant, tenantId: 'riverbend-synthetic', state: 'disabled' }],
        { tenantId: 'riverbend-synthetic', scope: {} },
        {
          registry: capabilityRegistryV1,
          grants: [],
          request: {
            tenantId: 'riverbend-synthetic',
            capabilityId: 'platform.bootstrap',
            scope: {},
            fromState: 'disabled',
            toState: 'scaffolded',
            initiatorRef: 'synthetic-initiator',
            approvals: [],
            evidenceRefs: ['synthetic-gate:cmd'],
            rollbackRef: 'registry-event-replay',
          },
          eventId: 'synthetic-cap-evt-cmd-0002',
        },
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
