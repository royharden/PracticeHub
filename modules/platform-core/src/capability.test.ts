import { describe, expect, it } from 'vitest';

import {
  applyCapabilityTransition,
  applyEventToGrants,
  capabilityStates,
  CapabilityTransitionDeniedError,
  evaluateCapabilityTransition,
  foldCapabilityEvents,
  capabilityRegistryVersion,
  isLegalCapabilityTransition,
  legalCapabilityTransitions,
  type CapabilityGrant,
  type CapabilityState,
  type CapabilityTransitionRequest,
} from './capability.js';
import { capabilityRegistryV1, syntheticCapabilitySeedV1 } from './capability-definitions.js';

const registry = capabilityRegistryV1;

/** The 15 adjacent transitions of ADR-011 Decision 1 — the complete legal set. */
const expectedLegalPairs: readonly (readonly [CapabilityState, CapabilityState])[] = [
  ['disabled', 'scaffolded'],
  ['scaffolded', 'disabled'],
  ['scaffolded', 'simulated'],
  ['simulated', 'scaffolded'],
  ['simulated', 'shadow'],
  ['shadow', 'simulated'],
  ['shadow', 'pilot'],
  ['pilot', 'shadow'],
  ['pilot', 'active'],
  ['active', 'pilot'],
  ['active', 'read-only'],
  ['read-only', 'active'],
  ['read-only', 'retiring'],
  ['retiring', 'read-only'],
  ['retiring', 'disabled'],
];

function grantAt(state: CapabilityState): CapabilityGrant {
  return {
    capabilityId: 'platform.bootstrap',
    tenantId: 'northwind-synthetic',
    scope: {},
    state,
    sinceEventId: state === 'disabled' ? null : 'synthetic-cap-evt-prior',
    evidenceRefs: ['synthetic-gate:prior'],
    rollbackRef: 'registry-event-replay',
    synthetic: true,
  };
}

function requestFor(
  from: CapabilityState,
  to: CapabilityState,
  overrides: Partial<CapabilityTransitionRequest> = {},
): CapabilityTransitionRequest {
  return {
    tenantId: 'northwind-synthetic',
    capabilityId: 'platform.bootstrap',
    scope: {},
    fromState: from,
    toState: to,
    initiatorRef: 'synthetic-initiator',
    approvals: [{ approverRef: 'synthetic-approver', role: 'architecture' }],
    evidenceRefs: ['synthetic-gate:receipt-0001'],
    rollbackRef: 'registry-event-replay',
    ...overrides,
  };
}

describe('capability state machine (property: adjacency is the complete legal set)', () => {
  it('every state x state pair is legal exactly when it is one of the 15 adjacent edges', () => {
    for (const from of capabilityStates) {
      for (const to of capabilityStates) {
        const expected = expectedLegalPairs.some(([f, t]) => f === from && t === to);
        expect(isLegalCapabilityTransition(from, to), `${from} -> ${to} legality`).toBe(expected);
      }
    }
    expect(legalCapabilityTransitions()).toHaveLength(expectedLegalPairs.length);
  });

  it('an illegal jump is denied by the gate with the legal alternatives named', () => {
    const evaluation = evaluateCapabilityTransition(registry, [grantAt('simulated')], {
      ...requestFor('simulated', 'active'),
    });
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.denials.map((denial) => denial.code)).toContain('illegal-transition');
  });

  it('an illegal jump is unrepresentable as an event (constructor throws the evaluation)', () => {
    expect(() =>
      applyCapabilityTransition(
        registry,
        [grantAt('simulated')],
        requestFor('simulated', 'active'),
        'synthetic-cap-evt-bad',
      ),
    ).toThrow(CapabilityTransitionDeniedError);
  });

  it('a stale fromState is denied: the request must match the registry, not memory', () => {
    const evaluation = evaluateCapabilityTransition(
      registry,
      [grantAt('simulated')],
      requestFor('shadow', 'pilot'),
    );
    expect(evaluation.denials.map((denial) => denial.code)).toContain('stale-from-state');
  });
});

describe('approval + evidence policy (v1 draft floor; section-11 graduation pending)', () => {
  it('every rank-increasing transition is evidence-gated', () => {
    const evaluation = evaluateCapabilityTransition(
      registry,
      [],
      requestFor('disabled', 'scaffolded', { evidenceRefs: [] }),
    );
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.denials.map((denial) => denial.code)).toContain('missing-evidence');
    expect(evaluation.missingApprovals).toContain('evidence: at least one gate receipt');
  });

  it('entering authority (shadow -> pilot) requires an approval independent of the initiator', () => {
    const noApproval = evaluateCapabilityTransition(
      registry,
      [grantAt('shadow')],
      requestFor('shadow', 'pilot', { approvals: [] }),
    );
    expect(noApproval.allowed).toBe(false);
    expect(noApproval.denials.map((denial) => denial.code)).toContain('missing-approval');

    const selfApproved = evaluateCapabilityTransition(
      registry,
      [grantAt('shadow')],
      requestFor('shadow', 'pilot', {
        approvals: [{ approverRef: 'synthetic-initiator', role: 'architecture' }],
      }),
    );
    expect(selfApproved.allowed).toBe(false);
    expect(selfApproved.denials.map((denial) => denial.code)).toContain(
      'initiator-cannot-self-approve',
    );

    const approved = evaluateCapabilityTransition(
      registry,
      [grantAt('shadow')],
      requestFor('shadow', 'pilot'),
    );
    expect(approved.allowed).toBe(true);
  });

  it('pilot -> active requires the rehearsed-rollback receipt', () => {
    const unrehearsed = evaluateCapabilityTransition(
      registry,
      [grantAt('pilot')],
      requestFor('pilot', 'active'),
    );
    expect(unrehearsed.allowed).toBe(false);
    expect(unrehearsed.denials.map((denial) => denial.code)).toContain(
      'missing-rollback-rehearsal',
    );
    expect(unrehearsed.missingApprovals).toContain('rehearsed-rollback receipt');

    const rehearsed = evaluateCapabilityTransition(
      registry,
      [grantAt('pilot')],
      requestFor('pilot', 'active', {
        evidenceRefs: ['rollback-rehearsal:synthetic-drill-0001'],
      }),
    );
    expect(rehearsed.allowed).toBe(true);
  });

  it('rollback direction is never blocked: active -> pilot with no approvals and no evidence', () => {
    const { rollbackRef, ...bare } = requestFor('active', 'pilot', {
      approvals: [],
      evidenceRefs: [],
    });
    expect(rollbackRef).toBeDefined();
    const evaluation = evaluateCapabilityTransition(registry, [grantAt('active')], bare);
    expect(evaluation.allowed).toBe(true);
  });

  it('re-activation (read-only -> active) is regated: approval and evidence required again', () => {
    const bare = evaluateCapabilityTransition(
      registry,
      [grantAt('read-only')],
      requestFor('read-only', 'active', { approvals: [], evidenceRefs: [] }),
    );
    expect(bare.allowed).toBe(false);
    expect(bare.denials.map((denial) => denial.code)).toEqual(
      expect.arrayContaining(['missing-approval', 'missing-evidence']),
    );

    const gated = evaluateCapabilityTransition(
      registry,
      [grantAt('read-only')],
      requestFor('read-only', 'active'),
    );
    expect(gated.allowed).toBe(true);
  });

  it('forward transitions require a rollback procedure reference', () => {
    const { rollbackRef, ...bare } = requestFor('disabled', 'scaffolded');
    expect(rollbackRef).toBeDefined();
    const evaluation = evaluateCapabilityTransition(registry, [], bare);
    expect(evaluation.denials.map((denial) => denial.code)).toContain('missing-rollback-ref');
  });

  it('the policy is data with draft status pending the section-11 matrix', () => {
    expect(registry.approvalPolicy.status).toBe('draft');
    expect(registry.approvalPolicy.pendingRef).toBe('section-11-approval-matrix-graduation');
    expect(registry.approvalPolicy.rehearsedRollbackEvidencePrefix).toBe('rollback-rehearsal:');
  });
});

describe('event log + projection', () => {
  it('apply -> fold round-trips the grant projection and the event carries the full receipt', () => {
    const event = applyCapabilityTransition(
      registry,
      [],
      requestFor('disabled', 'scaffolded', { reviewRef: 'synthetic-review-0001' }),
      'synthetic-cap-evt-1001',
    );
    expect(event.initiatorRef).toBe('synthetic-initiator');
    expect(event.reviewRef).toBe('synthetic-review-0001');
    expect(event.synthetic).toBe(true);

    const grants = foldCapabilityEvents(registry, [], [event]);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.state).toBe('scaffolded');
    expect(grants[0]?.sinceEventId).toBe('synthetic-cap-evt-1001');
  });

  it('a broken chain (event that does not follow the projection) throws — integrity is proven', () => {
    const event = applyCapabilityTransition(
      registry,
      [grantAt('scaffolded')],
      requestFor('scaffolded', 'simulated'),
      'synthetic-cap-evt-1002',
    );
    expect(() => foldCapabilityEvents(registry, [], [event])).toThrow(/does not chain/);
  });

  it('the registry version is the event count — the require() cache key', () => {
    expect(capabilityRegistryVersion([])).toBe(0);
    expect(capabilityRegistryVersion(syntheticCapabilitySeedV1.events)).toBe(
      syntheticCapabilitySeedV1.events.length,
    );
  });

  it('SEED-VALID: every synthetic seed event passes the full transition gate in order', () => {
    let grants: readonly CapabilityGrant[] = [];
    for (const event of syntheticCapabilitySeedV1.events) {
      const evaluation = evaluateCapabilityTransition(registry, grants, {
        tenantId: event.tenantId,
        capabilityId: event.capabilityId,
        scope: event.scope,
        fromState: event.fromState,
        toState: event.toState,
        initiatorRef: event.initiatorRef,
        approvals: event.approvals,
        evidenceRefs: event.evidenceRefs,
        rollbackRef: event.rollbackRef,
      });
      expect(evaluation.denials, event.eventId).toEqual([]);
      grants = applyEventToGrants(grants, event);
    }
  });

  it('SEED-OPPOSITE: Riverbend stays declared disabled while tenant 1 chains to simulated', () => {
    const riverbendStates = syntheticCapabilitySeedV1.initialGrants
      .filter((grant) => grant.tenantId === 'riverbend-synthetic')
      .map((grant) => grant.state);
    expect(riverbendStates.length).toBeGreaterThan(0);
    expect(new Set(riverbendStates)).toEqual(new Set(['disabled']));

    const northwindGrants = foldCapabilityEvents(
      registry,
      [],
      syntheticCapabilitySeedV1.events,
    ).filter((grant) => grant.capabilityId === 'platform.capability-registry');
    expect(northwindGrants).toHaveLength(1);
    expect(northwindGrants[0]?.state).toBe('simulated');
  });
});
