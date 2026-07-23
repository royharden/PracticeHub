/**
 * The break-glass GRANT is capability-gated (standing invariant: capability
 * checks + AuthorityDecision on every authority-bearing write). WP-017's seed
 * keeps `identity.break-glass` at `scaffolded` (the package ceiling) — the
 * seeded grant must DENY a live break-glass grant, a synthetic `simulated`
 * grant must allow, and Riverbend (disabled) stays denied. Offboarding and
 * anomaly investigation are protective/detective and are NOT commands (never
 * gated). The denied invocation's AuthorityDecision still maps to a valid deny
 * audit record.
 */
import {
  auditInputForAuthorityDecision,
  emitAuditEvent,
  emptyChainState,
} from '@practicehub/audit-evidence';
import {
  CapabilityDeniedError,
  capabilityRegistryV1,
  foldCapabilityEvents,
  requireCapability,
  syntheticCapabilitySeedV1,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import type { BreakGlassGrantRequest } from './break-glass.js';
import { grantBreakGlassCommand } from './commands/elevation-governance.command.js';

const registry = capabilityRegistryV1;
const seededGrants: readonly CapabilityGrant[] = [
  ...syntheticCapabilitySeedV1.initialGrants,
  ...foldCapabilityEvents(registry, [], syntheticCapabilitySeedV1.events),
];

const tenant = 'northwind-synthetic' as TenantId;

function grantRequest(overrides: Partial<BreakGlassGrantRequest> = {}): BreakGlassGrantRequest {
  return {
    tenantId: tenant,
    grantId: 'bg-cmd-0001',
    staffAccountId: 'nsa-morgan-lee',
    accessorPersonId: 'np-morgan-lee' as PersonId,
    subjectPersonId: 'np-alex-rivera' as PersonId,
    scope: ['clinical-notes'],
    reasonCode: 'emergency-care',
    justificationRef: 'synthetic-break-glass-reason-cmd',
    initiatedBy: 'synthetic-it-admin-001',
    effectiveAt: '2026-03-25T10:00:00Z',
    windowMinutes: 60,
    reviewWindowMinutes: 1440,
    ...overrides,
  };
}

const simulatedGrant: CapabilityGrant = {
  capabilityId: 'identity.break-glass',
  tenantId: 'northwind-synthetic',
  scope: {},
  state: 'simulated',
  sinceEventId: 'synthetic-cap-evt-test-0018',
  evidenceRefs: ['synthetic-gate:break-glass-sim-conformance'],
  rollbackRef: 'registry-event-replay',
  synthetic: true,
};

describe('break-glass grant capability gate', () => {
  it('the WP-017 seed (scaffolded) DENIES a live break-glass grant — the ceiling is honored', () => {
    expect(() =>
      grantBreakGlassCommand.invoke(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        grantRequest(),
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it('a denied invocation’s thrown decision still maps to a VALID deny audit record', () => {
    let denied: CapabilityDeniedError | undefined;
    try {
      requireCapability(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        'identity.break-glass',
        { minimumState: 'simulated', checkpoint: 'enqueue' },
      );
    } catch (error) {
      denied = error as CapabilityDeniedError;
    }
    if (denied === undefined) {
      throw new Error('expected the scaffolded seed to deny');
    }
    expect(denied.decision.allowed).toBe(false);
    const emitted = emitAuditEvent(
      emptyChainState,
      auditInputForAuthorityDecision(denied.decision, {
        auditId: 'fx-break-glass-authority-0001',
        actorRef: 'synthetic-it-admin-001',
        occurredAt: '2026-03-25T10:00:00Z',
      }),
    );
    expect(emitted.record.decision).toBe('deny');
    expect(emitted.record.detail?.['capability_id']).toBe('identity.break-glass');
  });

  it('a simulated grant allows the break-glass grant and returns an AuthorityDecision', () => {
    const outcome = grantBreakGlassCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      grantRequest(),
    );
    expect(outcome.decision.allowed).toBe(true);
    expect(outcome.decision.capabilityId).toBe('identity.break-glass');
    expect(outcome.result.grant.grantId).toBe('bg-cmd-0001');
    expect(outcome.result.obligations).toEqual(['independent-review-required']);
  });

  it('Riverbend (disabled) is denied — the standing opposite-state proof', () => {
    expect(() =>
      grantBreakGlassCommand.invoke(
        registry,
        seededGrants,
        { tenantId: 'riverbend-synthetic' as TenantId, scope: {} },
        grantRequest({ tenantId: 'riverbend-synthetic' as TenantId, grantId: 'bg-cmd-rb' }),
      ),
    ).toThrow(CapabilityDeniedError);
  });
});
