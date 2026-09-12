import type { TenantId } from '@practicehub/contracts';
import {
  InMemorySimStateStore,
  VendorSimEngine,
  type RailRequest,
  type RailResponse,
} from '@practicehub/vendor-sim-kit';
import { handleSimRequest, modelSim } from '@practicehub/vendor-simulator';
import { describe, expect, it, vi } from 'vitest';

import { EventAuditEvidencePort } from './evidence.js';
import { sha256 } from './guards.js';
import {
  LocalRail022HttpTransport,
  InMemoryProviderRequestFence,
  Rail022DevProvider,
  rail022IdempotencyKey,
  type ModelRailResult,
  type Rail022Transport,
} from './provider.js';
import { gatewayHarness, requestFixture } from './test-support.js';
import type { ProviderPrompt } from './types.js';

const railResponse: RailResponse = {
  railId: 'RAIL-022',
  operation: 'complete',
  status: 'accepted',
  effectKey: 'rail-022:effect:001',
  idempotencyKey: 'ai:interaction:001',
  receiptRef: 'receipt:rail-022:001',
  duplicateOf: null,
  requiresReconciliation: false,
  resendsExternalEffect: false,
  injectedPrimitiveId: null,
  outcomeClass: null,
  declaredDelayMs: 0,
  retryAfterSeconds: null,
  vendorVersion: 'model-api-v1',
  attempts: 1,
  effectState: 'landed',
  synthetic: true,
};

function promptFixture(): ProviderPrompt {
  const request = requestFixture();
  return {
    tenantId: request.tenantId,
    subjectRef: request.subjectRef,
    interactionRef: request.interactionRef,
    idempotencyKey: request.idempotencyKey,
    occurredAt: request.occurredAt,
    control: {
      modelRef: request.binding.modelRef,
      pinnedModelVersion: request.binding.pinnedModelVersion,
      promptTemplateVersion: request.binding.promptTemplateVersion,
      systemPolicyRef: request.binding.systemPolicyRef,
      allowedToolIds: [],
      synthetic: true,
    },
    data: [],
    synthetic: true,
  };
}

class InProcessRail022Transport implements Rail022Transport {
  public constructor(private readonly engine: VendorSimEngine) {}

  public async dispatch(request: RailRequest): Promise<ModelRailResult> {
    const handled = handleSimRequest(this.engine, {
      method: 'POST',
      path: '/rails/RAIL-022/complete',
      body: request,
    });
    if (handled.status !== 200) throw new Error(JSON.stringify(handled.body));
    return {
      response: handled.body['response'] as RailResponse,
      outputBody: JSON.stringify({ candidate: true, synthetic: true }),
      toolProposals: [],
    };
  }
}

function realScenarioProvider(primitiveId: string): Rail022DevProvider {
  const engine = new VendorSimEngine({
    rails: [modelSim],
    store: new InMemorySimStateStore(),
    dataPolicy: 'synthetic-only',
  });
  engine.controller.armScenario({
    railId: 'RAIL-022',
    primitiveId,
    dataPolicy: 'synthetic-only',
  });
  const fetcher = async (_input: string, init: { readonly body: string }) => {
    const handled = handleSimRequest(engine, {
      method: 'POST',
      path: '/rails/RAIL-022/complete',
      body: JSON.parse(init.body) as RailRequest,
    });
    return {
      ok: handled.status === 200,
      status: handled.status,
      async json() {
        return handled.body;
      },
    };
  };
  return new Rail022DevProvider(
    new LocalRail022HttpTransport('http://127.0.0.1:58090', fetcher),
    new InMemoryProviderRequestFence(),
  );
}

describe('RAIL-022 provider parity', () => {
  it('uses the frozen local route and exact RailRequest identity', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return { response: railResponse, synthetic: true };
      },
    }));
    const transport = new LocalRail022HttpTransport('http://127.0.0.1:58090/', fetcher);
    const result = await transport.dispatch({
      railId: 'RAIL-022',
      operation: 'complete',
      idempotencyKey: 'ai:interaction:001',
      payloadRef: 'interaction:001',
      requestedAt: '2026-06-01T09:00:00Z',
      payload: { synthetic: true },
      synthetic: true,
    });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:58090/rails/RAIL-022/complete',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.response).toEqual(railResponse);
    expect(result.toolProposals).toEqual([]);
  });

  it('refuses non-loopback provider bases', () => {
    expect(() => new LocalRail022HttpTransport('https://provider.invalid')).toThrow('loopback');
  });

  it('binds idempotency to tenant and preserves real engine dedup semantics', async () => {
    const engine = new VendorSimEngine({
      rails: [modelSim],
      store: new InMemorySimStateStore(),
      dataPolicy: 'synthetic-only',
    });
    const provider = new Rail022DevProvider(
      new InProcessRail022Transport(engine),
      new InMemoryProviderRequestFence(),
    );
    const northwind = promptFixture();
    const riverbend = {
      ...northwind,
      tenantId: 'riverbend-synthetic' as TenantId,
      subjectRef: 'subject:riverbend:001',
    };
    expect(rail022IdempotencyKey(northwind)).not.toBe(rail022IdempotencyKey(riverbend));
    await expect(provider.complete(northwind)).resolves.toMatchObject({ status: 'accepted' });
    await expect(
      provider.complete({
        ...northwind,
        data: [
          {
            originRef: 'ehr:synthetic-note',
            bodyRef: 'source:note:changed',
            bodyHash: 'd'.repeat(64),
            body: 'changed synthetic payload',
            trust: 'untrusted-data',
          },
        ],
      }),
    ).rejects.toThrow();
    await expect(provider.complete(riverbend)).resolves.toMatchObject({ status: 'accepted' });
    await expect(provider.complete(northwind)).resolves.toMatchObject({ status: 'deduplicated' });
  });

  it('refuses a structurally malformed successful response', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          response: { ...railResponse, vendorVersion: 'model api v1' },
          synthetic: true,
        };
      },
    }));
    const transport = new LocalRail022HttpTransport('http://127.0.0.1:58090', fetcher);
    await expect(
      transport.dispatch({
        railId: 'RAIL-022',
        operation: 'complete',
        idempotencyKey: 'ai-test',
        payloadRef: 'interaction:001',
        requestedAt: '2026-06-01T09:00:00Z',
        synthetic: true,
      }),
    ).rejects.toThrow('contradictory');
  });

  it('carries real X18 drift through the local envelope into contained evidence', async () => {
    const provider = realScenarioProvider('X-18');
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const evidencePort = new EventAuditEvidencePort({
      async query(text: string, params: readonly unknown[] = []) {
        queries.push({ text, params });
        return { rows: [] };
      },
    });
    const harness = gatewayHarness({ provider, evidencePort });

    await expect(harness.gateway.invoke(harness.request)).resolves.toMatchObject({
      kind: 'stale',
      reason: 'model-version-drift',
      toolDecisions: [],
    });
    expect(harness.containment.records()).toHaveLength(1);
    const serialized = JSON.stringify(queries);
    const rawVersion = 'model-api-v1+drift';
    const versionHash = sha256(rawVersion);
    expect(serialized).toContain(rawVersion);
    expect(serialized).toContain(versionHash);
    expect(serialized).toContain(`model-version-sha256:${versionHash}`);
    expect(
      queries.find((query) => query.text.includes('INSERT INTO ai_gateway.interaction'))?.params,
    ).toEqual(
      expect.arrayContaining([rawVersion, versionHash, `model-version-sha256:${versionHash}`]),
    );
  });

  it.each(['X-06', 'X-08', 'X-09', 'X-10', 'X-11'])(
    'keeps real accepted reconciliation scenario %s non-authoritative',
    async (primitiveId) => {
      const harness = gatewayHarness({ provider: realScenarioProvider(primitiveId) });
      await expect(harness.gateway.invoke(harness.request)).resolves.toMatchObject({
        kind: 'stale',
        reason: 'provider-failed',
        toolDecisions: [],
      });
      expect(harness.containment.records()).toHaveLength(1);
      expect(harness.evidence.commits[0]?.evidence.reason).toBe('provider-failed');
    },
  );

  it('maps malformed simulator identity to a closed provider result', async () => {
    const provider = new Rail022DevProvider(
      {
        async dispatch() {
          return {
            response: { ...railResponse, railId: 'RAIL-999' },
            outputBody: 'x',
            toolProposals: [],
          };
        },
      },
      new InMemoryProviderRequestFence(),
    );
    const result = await provider.complete(promptFixture());
    expect(result).toMatchObject({ status: 'malformed', requiresReconciliation: true });
  });
});
