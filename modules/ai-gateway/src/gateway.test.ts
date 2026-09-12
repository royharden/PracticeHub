import { describe, expect, it } from 'vitest';

import { sha256 } from './guards.js';
import { scopedBody } from './recording-ports.js';
import { cleanProviderResult, gatewayHarness, requestFixture } from './test-support.js';

describe('AiGateway closed execution model', () => {
  it('returns only a retained human-review candidate and inert tool proposals', async () => {
    const proposal = {
      toolId: 'tool:chart-read',
      arguments: { subjectRef: 'subject:northwind:001' },
      sideEffect: 'none' as const,
      requestedPurpose: 'treatment',
      synthetic: true as const,
    };
    const harness = gatewayHarness({
      providerResult: { ...cleanProviderResult, toolProposals: [proposal] },
    });
    const decision = await harness.gateway.invoke(harness.request);

    expect(decision.kind).toBe('completed');
    if (decision.kind !== 'completed') throw new Error('expected completed decision');
    expect(decision.toolDecisions).toEqual([
      { allow: true, reason: 'authorized-inert-proposal', grantVersion: 1, proposal },
    ]);
    expect(harness.providerCalls()).toBe(1);
    expect(harness.evidence.commits).toHaveLength(1);
    expect(harness.evidence.commits[0]?.evidence).toMatchObject({
      promptRef: expect.any(String),
      promptHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      outputRef: decision.outputRef,
      outputHash: decision.outputHash,
      reason: 'candidate-for-human-review',
      providerReceiptRef: 'receipt:rail-022:001',
    });
  });

  it('refuses an input secret before provider invocation', async () => {
    const harness = gatewayHarness();
    const declared = harness.request.content[0];
    if (declared === undefined) throw new Error('fixture source missing');
    const body = 'synthetic-secret-canary';
    harness.objects.seed(
      scopedBody(harness.request, {
        bodyRef: declared.bodyRef,
        originRef: declared.originRef,
        body,
      }),
    );
    const request = { ...harness.request, content: [{ ...declared, bodyHash: sha256(body) }] };
    const decision = await harness.gateway.invoke(request);
    expect(decision).toMatchObject({ kind: 'blocked', reason: 'input-secret', providerCalls: 0 });
    expect(harness.providerCalls()).toBe(0);
  });

  it('refuses a declared cross-subject object before provider invocation', async () => {
    const harness = gatewayHarness();
    const declared = harness.request.content[0];
    if (declared === undefined) throw new Error('fixture source missing');
    const decision = await harness.gateway.invoke({
      ...harness.request,
      content: [{ ...declared, subjectRef: 'subject:northwind:002' }],
    });
    expect(decision).toMatchObject({
      kind: 'blocked',
      reason: 'object-scope-mismatch',
      providerCalls: 0,
    });
    expect(harness.providerCalls()).toBe(0);
  });

  it('contains exact cohort on model drift and leaves a sibling cohort callable', async () => {
    const drift = gatewayHarness({
      providerResult: { ...cleanProviderResult, actualModelVersion: 'model-api-v2' },
    });
    expect(await drift.gateway.invoke(drift.request)).toMatchObject({
      kind: 'stale',
      reason: 'model-version-drift',
    });
    expect(await drift.gateway.invoke(drift.request)).toMatchObject({
      kind: 'contained',
      cohortRef: 'cohort-alpha',
      providerCalls: 0,
    });

    const siblingRequest = requestFixture({
      cohortRef: 'cohort-beta',
      interactionRef: 'interaction:002',
      binding: {
        ...drift.request.binding,
        cohortRef: 'cohort-beta',
        bindingRef: 'binding:summary:beta',
      },
      grant: { ...drift.request.grant, cohortRef: 'cohort-beta' },
    });
    const sibling = gatewayHarness({ request: siblingRequest });
    expect(await sibling.gateway.invoke(sibling.request)).toMatchObject({ kind: 'completed' });
  });

  it.each(['X-06', 'X-08', 'X-09', 'X-10', 'X-11'])(
    'never completes reconciliation-required accepted outcome %s',
    async () => {
      const harness = gatewayHarness({
        providerResult: { ...cleanProviderResult, requiresReconciliation: true },
      });
      expect(await harness.gateway.invoke(harness.request)).toMatchObject({
        kind: 'stale',
        reason: 'provider-failed',
        toolDecisions: [],
      });
      expect(harness.containment.records()).toHaveLength(1);
    },
  );

  it('blocks uncovered provider egress without calling the provider', async () => {
    const harness = gatewayHarness({ egressAllowed: false });
    expect(await harness.gateway.invoke(harness.request)).toMatchObject({
      kind: 'blocked',
      reason: 'provider-egress-denied',
      providerCalls: 0,
    });
    expect(harness.providerCalls()).toBe(0);
    expect(harness.evidence.commits[0]?.egressDecision?.allow).toBe(false);
  });

  it('requires ai.gateway at simulated while preserving contained fallback reads', async () => {
    const denied = gatewayHarness({ capabilityAllowed: false });
    expect(await denied.gateway.invoke(denied.request)).toMatchObject({
      kind: 'blocked',
      reason: 'capability-denied',
      providerCalls: 0,
    });
    expect(denied.providerCalls()).toBe(0);

    const contained = gatewayHarness({ capabilityAllowed: false });
    await contained.containment.kill({
      tenantId: contained.request.tenantId,
      useCase: contained.request.useCase,
      cohortRef: contained.request.cohortRef,
      bindingRef: contained.request.binding.bindingRef,
      incidentRef: 'incident:prior',
      fallbackRef: 'fallback:human:summary',
      reason: 'prior-kill',
      containedAt: contained.request.occurredAt,
      synthetic: true,
    });
    expect(await contained.gateway.invoke(contained.request)).toMatchObject({
      kind: 'contained',
      providerCalls: 0,
    });
  });

  it('refuses caller policy snapshots absent an exact enabled trusted row', async () => {
    const harness = gatewayHarness({ policyMismatch: true });
    expect(await harness.gateway.invoke(harness.request)).toMatchObject({
      kind: 'blocked',
      reason: 'policy-snapshot-mismatch',
      providerCalls: 0,
    });
    expect(harness.providerCalls()).toBe(0);
  });

  it('never executes or releases a consequential tool proposal', async () => {
    const harness = gatewayHarness({
      providerResult: {
        ...cleanProviderResult,
        toolProposals: [
          {
            toolId: 'tool:chart-write',
            arguments: { subjectRef: 'subject:northwind:001' },
            sideEffect: 'consequential',
            requestedPurpose: 'treatment',
            synthetic: true,
          },
        ],
      },
    });
    expect(await harness.gateway.invoke(harness.request)).toMatchObject({
      kind: 'blocked',
      reason: 'tool-denied',
      providerCalls: 1,
    });
  });

  it('denies tool arguments that attempt to change the subject scope', async () => {
    const harness = gatewayHarness({
      providerResult: {
        ...cleanProviderResult,
        toolProposals: [
          {
            toolId: 'tool:chart-read',
            arguments: { subjectRef: 'subject:northwind:002' },
            sideEffect: 'none',
            requestedPurpose: 'treatment',
            synthetic: true,
          },
        ],
      },
    });
    expect(await harness.gateway.invoke(harness.request)).toMatchObject({
      kind: 'blocked',
      reason: 'tool-denied',
      providerCalls: 1,
    });
  });

  it('retains receipt evidence when output safety blocks after provider return', async () => {
    const harness = gatewayHarness({
      providerResult: {
        ...cleanProviderResult,
        outputBody: 'mentions subject:northwind:002',
      },
    });
    expect(await harness.gateway.invoke(harness.request)).toMatchObject({
      kind: 'blocked',
      reason: 'output-cross-subject',
      providerCalls: 1,
    });
    expect(harness.evidence.commits[0]?.evidence.providerReceiptRef).toBe('receipt:rail-022:001');
  });

  it('returns no authoritative decision when same-transaction evidence fails', async () => {
    const harness = gatewayHarness();
    harness.evidence.commit = async () => {
      throw new Error('synthetic rollback');
    };
    await expect(harness.gateway.invoke(harness.request)).rejects.toThrow(
      'no authoritative decision',
    );
  });
});
