import { describe, expect, it } from 'vitest';

import {
  evaluateCapabilityTransition,
  listCapabilityEdgeViolations,
  targetModuleCapabilityToken,
  type CapabilityGrant,
  type CapabilityId,
  type CapabilityRegistry,
  type CapabilityScope,
  type CapabilityState,
  type CapabilityTransitionEvent,
  type CapabilityTransitionRequest,
} from './capability.js';
import { capabilityEdgesV1, capabilityRegistryV1 } from './capability-definitions.js';

const registry = capabilityRegistryV1;
const tenant = 'northwind-synthetic';

function grant(
  capabilityId: CapabilityId,
  state: CapabilityState,
  scope: CapabilityScope = {},
): CapabilityGrant {
  return {
    capabilityId,
    tenantId: tenant,
    scope,
    state,
    sinceEventId:
      state === 'disabled' ? null : `synthetic-cap-evt-${capabilityId.replace('.', '-')}`,
    evidenceRefs: ['synthetic-gate:edge-setup'],
    rollbackRef: 'registry-event-replay',
    synthetic: true,
  };
}

function gatedRequest(
  capabilityId: CapabilityId,
  from: CapabilityState,
  to: CapabilityState,
  overrides: Partial<CapabilityTransitionRequest> = {},
): CapabilityTransitionRequest {
  const evidence =
    from === 'pilot' && to === 'active'
      ? ['synthetic-gate:edge', 'rollback-rehearsal:synthetic-drill-0001']
      : ['synthetic-gate:edge'];
  return {
    tenantId: tenant,
    capabilityId,
    scope: {},
    fromState: from,
    toState: to,
    initiatorRef: 'synthetic-initiator',
    approvals: [{ approverRef: 'synthetic-approver', role: 'architecture' }],
    evidenceRefs: evidence,
    rollbackRef: 'registry-event-replay',
    ...overrides,
  };
}

interface EdgeProbe {
  readonly constraintId: string;
  readonly request: CapabilityTransitionRequest;
  /** Grants placing the dependent at its from-state, WITHOUT the prerequisite. */
  readonly withoutPrerequisite: readonly CapabilityGrant[];
  /** The prerequisite grant that unlocks the transition. */
  readonly prerequisite: CapabilityGrant;
}

/**
 * One probe per frozen edge row: the dependent transition that would exceed
 * `max_dependent_state_without_prerequisite` must be denied while the
 * prerequisite is absent (or below its minimum state), and allowed once the
 * prerequisite grant is present — the WP-012 half of each IC negative proof
 * (the runtime denial halves belong to the owning feature packages).
 */
const probes: readonly EdgeProbe[] = [
  {
    constraintId: 'IC-1',
    request: gatedRequest('migration.podium-port', 'pilot', 'active', {
      scope: { number: 'synthetic-num-0001' },
    }),
    withoutPrerequisite: [
      grant('migration.podium-port', 'pilot', { number: 'synthetic-num-0001' }),
    ],
    prerequisite: grant('consent.operational', 'simulated'),
  },
  {
    constraintId: 'IC-2',
    request: gatedRequest('membership.employer-surfaces', 'scaffolded', 'simulated'),
    withoutPrerequisite: [grant('membership.employer-surfaces', 'scaffolded')],
    prerequisite: grant('privacy.gipa-partition', 'simulated'),
  },
  {
    constraintId: 'IC-3',
    request: gatedRequest('finance.billing-authority', 'scaffolded', 'simulated'),
    withoutPrerequisite: [grant('finance.billing-authority', 'scaffolded')],
    prerequisite: grant('membership.entitlement-ledger', 'simulated'),
  },
  {
    constraintId: 'IC-4',
    request: gatedRequest('migration.acquisition-rehearsal', 'scaffolded', 'simulated', {
      scope: { wave: 'synthetic-wave-01' },
    }),
    withoutPrerequisite: [
      grant('migration.acquisition-rehearsal', 'scaffolded', { wave: 'synthetic-wave-01' }),
    ],
    prerequisite: grant('migration.workbench', 'simulated'),
  },
  {
    constraintId: 'IC-5',
    request: gatedRequest('governance.authority-bearing-write', 'shadow', 'pilot'),
    withoutPrerequisite: [grant('governance.authority-bearing-write', 'shadow')],
    prerequisite: grant('governance.authority-matrix', 'scaffolded'),
  },
  {
    constraintId: 'IC-6',
    request: gatedRequest('migration.wave-import', 'scaffolded', 'simulated', {
      scope: { wave: 'synthetic-wave-01' },
      targetCapabilityId: 'membership.entitlement-ledger',
    }),
    withoutPrerequisite: [
      grant('migration.wave-import', 'scaffolded', { wave: 'synthetic-wave-01' }),
    ],
    prerequisite: grant('membership.entitlement-ledger', 'scaffolded'),
  },
];

describe('IC-1..6 edge preconditions (every negative proof denies the dependent transition)', () => {
  it('covers every frozen edge row with a probe', () => {
    expect(probes.map((probe) => probe.constraintId)).toEqual(
      capabilityEdgesV1.map((edge) => edge.constraintId),
    );
    expect(capabilityEdgesV1).toHaveLength(6);
  });

  for (const probe of probes) {
    it(`${probe.constraintId}: denied without the prerequisite, allowed with it`, () => {
      const denied = evaluateCapabilityTransition(
        registry,
        probe.withoutPrerequisite,
        probe.request,
      );
      expect(denied.allowed).toBe(false);
      expect(denied.violatedEdges).toContain(probe.constraintId);
      expect(denied.denials.map((denial) => denial.code)).toContain(probe.constraintId);

      const allowed = evaluateCapabilityTransition(
        registry,
        [...probe.withoutPrerequisite, probe.prerequisite],
        probe.request,
      );
      expect(allowed.denials, probe.constraintId).toEqual([]);
    });
  }

  it('a prerequisite BELOW its minimum state still denies (present is not sufficient)', () => {
    const below = evaluateCapabilityTransition(
      registry,
      [
        grant('membership.employer-surfaces', 'scaffolded'),
        grant('privacy.gipa-partition', 'scaffolded'),
      ],
      gatedRequest('membership.employer-surfaces', 'scaffolded', 'simulated'),
    );
    expect(below.violatedEdges).toContain('IC-2');
  });

  it('a write-blocked prerequisite (read-only) is unavailable — revoked authority never satisfies', () => {
    const revoked = evaluateCapabilityTransition(
      registry,
      [
        grant('finance.billing-authority', 'scaffolded'),
        grant('membership.entitlement-ledger', 'read-only'),
      ],
      gatedRequest('finance.billing-authority', 'scaffolded', 'simulated'),
    );
    expect(revoked.violatedEdges).toContain('IC-3');
  });

  it('IC-6 fails closed without a targetCapabilityId on the transition request', () => {
    const missing = evaluateCapabilityTransition(
      registry,
      [grant('migration.wave-import', 'scaffolded', { wave: 'synthetic-wave-01' })],
      gatedRequest('migration.wave-import', 'scaffolded', 'simulated', {
        scope: { wave: 'synthetic-wave-01' },
      }),
    );
    expect(missing.violatedEdges).toContain('IC-6');
    expect(missing.denials.some((denial) => denial.message.includes('targetCapabilityId'))).toBe(
      true,
    );
  });

  it('IC-6 with an undeclared target capability fails closed too', () => {
    const unknown = evaluateCapabilityTransition(
      registry,
      [grant('migration.wave-import', 'scaffolded', { wave: 'synthetic-wave-01' })],
      gatedRequest('migration.wave-import', 'scaffolded', 'simulated', {
        scope: { wave: 'synthetic-wave-01' },
        targetCapabilityId: 'testmod.unregistered',
      }),
    );
    expect(unknown.violatedEdges).toContain('IC-6');
  });

  it('decommissioning a dependent (active -> read-only) is never edge-blocked: the walk order exceeds the ceiling but write authority does not', () => {
    const evaluation = evaluateCapabilityTransition(
      registry,
      [grant('migration.podium-port', 'active', { number: 'synthetic-num-0001' })],
      gatedRequest('migration.podium-port', 'active', 'read-only', {
        scope: { number: 'synthetic-num-0001' },
      }),
    );
    expect(evaluation.denials).toEqual([]);
  });

  it('transitions at or below the ceiling stay unaffected by the edge', () => {
    const belowCeiling = evaluateCapabilityTransition(
      registry,
      [],
      gatedRequest('membership.employer-surfaces', 'disabled', 'scaffolded'),
    );
    expect(belowCeiling.denials).toEqual([]);
  });
});

describe('edge-violation listing (prerequisite revoked after the fact)', () => {
  it('IC-1: rolling operational consent below simulated flags the port capability', () => {
    const grants = [
      grant('migration.podium-port', 'active', { number: 'synthetic-num-0001' }),
      grant('consent.operational', 'scaffolded'),
    ];
    const violations = listCapabilityEdgeViolations(registry, grants);
    expect(violations.map((violation) => violation.constraintId)).toContain('IC-1');
    expect(violations[0]?.capabilityId).toBe('migration.podium-port');
  });

  it('a satisfied prerequisite produces no violation', () => {
    const grants = [
      grant('migration.podium-port', 'active', { number: 'synthetic-num-0001' }),
      grant('consent.operational', 'simulated'),
    ];
    expect(listCapabilityEdgeViolations(registry, grants)).toEqual([]);
  });

  it('IC-6: a wave-import grant whose minting event is unresolvable fails closed', () => {
    const grants = [grant('migration.wave-import', 'simulated', { wave: 'synthetic-wave-01' })];
    const violations = listCapabilityEdgeViolations(registry, grants, []);
    expect(violations.map((violation) => violation.constraintId)).toContain('IC-6');
  });

  it('IC-6: the minting event binds the target module and clears the violation', () => {
    const importGrant = grant('migration.wave-import', 'simulated', {
      wave: 'synthetic-wave-01',
    });
    const events: readonly CapabilityTransitionEvent[] = [
      {
        eventId: importGrant.sinceEventId ?? 'synthetic-cap-evt-wave',
        tenantId: tenant,
        capabilityId: 'migration.wave-import',
        scope: { wave: 'synthetic-wave-01' },
        fromState: 'scaffolded',
        toState: 'simulated',
        initiatorRef: 'synthetic-initiator',
        approvals: [],
        evidenceRefs: ['synthetic-gate:edge'],
        rollbackRef: 'registry-event-replay',
        targetCapabilityId: 'membership.entitlement-ledger',
        synthetic: true,
      },
    ];
    const violations = listCapabilityEdgeViolations(
      registry,
      [importGrant, grant('membership.entitlement-ledger', 'scaffolded')],
      events,
    );
    expect(violations).toEqual([]);
  });
});

describe('external-wait ceilings (max pre-wait state as registry data)', () => {
  const ceilingRegistry: CapabilityRegistry = {
    ...registry,
    ceilings: [
      {
        capabilityId: 'governance.authority-bearing-write',
        maxState: 'shadow',
        releaseEvidencePrefix: 'wait-cleared:',
        ref: 'synthetic-ew-01',
      },
    ],
  };
  const grants = [
    grant('governance.authority-bearing-write', 'shadow'),
    grant('governance.authority-matrix', 'scaffolded'),
  ];

  it('a transition above the ceiling is denied until release evidence is recorded', () => {
    const capped = evaluateCapabilityTransition(
      ceilingRegistry,
      grants,
      gatedRequest('governance.authority-bearing-write', 'shadow', 'pilot'),
    );
    expect(capped.allowed).toBe(false);
    expect(capped.denials.map((denial) => denial.code)).toContain('ceiling:synthetic-ew-01');
  });

  it('release evidence lifts the ceiling; states at or below it were never blocked', () => {
    const released = evaluateCapabilityTransition(
      ceilingRegistry,
      grants,
      gatedRequest('governance.authority-bearing-write', 'shadow', 'pilot', {
        evidenceRefs: ['synthetic-gate:edge', 'wait-cleared:synthetic-receipt-0001'],
      }),
    );
    expect(released.denials).toEqual([]);
  });
});

describe('frozen edge register integrity', () => {
  it('every edge capability id resolves in the definition registry', () => {
    const declared = new Set(registry.definitions.map((definition) => definition.capabilityId));
    for (const edge of capabilityEdgesV1) {
      expect(declared.has(edge.dependentCapabilityId), edge.dependentCapabilityId).toBe(true);
      if (edge.prerequisiteCapabilityId !== targetModuleCapabilityToken) {
        expect(declared.has(edge.prerequisiteCapabilityId), edge.prerequisiteCapabilityId).toBe(
          true,
        );
      }
    }
  });
});
