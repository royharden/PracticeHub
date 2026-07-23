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
import { emitAuditEvent, emptyChainState } from '@practicehub/audit-evidence';
import { describe, expect, it } from 'vitest';

import { triggerClock, type ObligationClock, type ObligationClockPolicy } from './clocks.js';
import {
  publishObligationClockPolicyCommand,
  publishPolicyDocumentCommand,
  recordClockSatisfactionCommand,
} from './commands/policy-clock-governance.command.js';
import type { PolicyDocumentVersion } from './policy-registry.js';
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

// --- review-016 F1: gated policy/clock-policy publication -------------------

const policyDocument: PolicyDocumentVersion = {
  tenantId: tenant,
  documentType: 'disclosure-authorization',
  jurisdiction: 'MN',
  version: 3,
  effectiveOn: '2027-01-01',
  status: 'draft',
  changeControlRef: 'ccr-mn-disclosure-2027',
  contentRef: 'policy-doc:northwind:disclosure-authorization:mn:v3',
  contentHash: 'a'.repeat(64),
  synthetic: true,
};

const clockPolicy: ObligationClockPolicy = {
  obligationType: 'records-request-closure',
  jurisdiction: 'IL',
  version: 2,
  effectiveOn: '2027-01-01',
  status: 'draft',
  changeControlRef: 'ccr-il-access-2027',
  durationDays: 15,
  escalationLeadDays: 5,
  sourceRef: 'il-access-tightened',
  synthetic: true,
};

const publishDoc = {
  document: policyDocument,
  actorRef: 'synthetic-counsel',
  occurredAt: '2026-07-01T00:00:00.000Z',
};
const publishClockPolicy = {
  policy: clockPolicy,
  actorRef: 'synthetic-counsel',
  occurredAt: '2026-07-01T00:00:00.000Z',
};

describe('policy publication command capability gate (review-016 F1)', () => {
  it('the WP-019 seed (scaffolded) DENIES a live policy-document publication', () => {
    expect(() =>
      publishPolicyDocumentCommand.invoke(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        publishDoc,
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it('the WP-019 seed (scaffolded) DENIES a live clock-policy publication', () => {
    expect(() =>
      publishObligationClockPolicyCommand.invoke(
        registry,
        seededGrants,
        { tenantId: tenant, scope: {} },
        publishClockPolicy,
      ),
    ).toThrow(CapabilityDeniedError);
  });

  it('a simulated grant allows policy-document publication + emits a config-change audit', () => {
    const invocation = publishPolicyDocumentCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      publishDoc,
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.result.version.version).toBe(3);
    // The config-change audit input emits through the REAL emitter.
    const emitted = emitAuditEvent(emptyChainState, {
      ...invocation.result.auditInput,
      auditId: 'fx-policy-audit-0001',
    });
    expect(emitted.record.entryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(emitted.record.action).toBe('policy-document-published');
  });

  it('a simulated grant allows clock-policy publication + emits a config-change audit', () => {
    const invocation = publishObligationClockPolicyCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      publishClockPolicy,
    );
    expect(invocation.decision.allowed).toBe(true);
    const emitted = emitAuditEvent(emptyChainState, {
      ...invocation.result.auditInput,
      auditId: 'fx-clock-policy-audit-0001',
    });
    expect(emitted.record.action).toBe('obligation-clock-policy-published');
  });

  it('Riverbend (disabled) is denied a publication — the standing opposite-state proof', () => {
    expect(() =>
      publishPolicyDocumentCommand.invoke(
        registry,
        seededGrants,
        { tenantId: 'riverbend-synthetic', scope: {} },
        { ...publishDoc, document: { ...policyDocument, tenantId: 'riverbend-synthetic' } },
      ),
    ).toThrow(CapabilityDeniedError);
  });
});

describe('rule-pack-review satisfaction command (structured evidence; review-016 F5)', () => {
  const trackerInstance: ObligationClock = triggerClock({
    tenantId: tenant,
    clockId: 'clk-cmd-tracker',
    clockEventId: 'cle-cmd-t1',
    obligationType: 'rule-pack-review',
    subjectRef: 'rule-pack-scope:all-jurisdictions',
    triggerRef: 'statute-tracker:cmd',
    triggeredAt: '2026-01-01T00:00:00.000Z',
    actorRef: 'synthetic-clock',
    basis: { providerState: null, patientState: null },
    policies: obligationClockPoliciesV1,
  }).instance;

  it('a simulated grant closes the statute-tracker with structured evidence', () => {
    const invocation = recordClockSatisfactionCommand.invoke(
      registry,
      [simulatedGrant],
      { tenantId: tenant, scope: {} },
      {
        instance: trackerInstance,
        clockEventId: 'cle-cmd-t2',
        occurredAt: '2026-04-01T00:00:00.000Z',
        actorRef: 'synthetic-officer',
        closureEvidence: {
          changeControlRef: 'ccr-statute-2026-q1',
          truthTableReceiptRef: 'truth-table:regen:cells-432-diffs-0',
        },
      },
    );
    expect(invocation.decision.allowed).toBe(true);
    expect(invocation.result.instance.status).toBe('satisfied');
    expect(invocation.result.event.truthTableReceiptRef).toBe(
      'truth-table:regen:cells-432-diffs-0',
    );
  });
});
