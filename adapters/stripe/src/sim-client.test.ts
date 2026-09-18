import { describe, expect, it, vi } from 'vitest';
import { InMemorySimStateStore, VendorSimEngine } from '@practicehub/vendor-sim-kit';
import { handleSimRequest, stripeSim } from '@practicehub/vendor-simulator';
import type { EgressRequest, VendorRegistryRow } from '@practicehub/platform-integration';

import { StripeSimClient } from './sim-client.js';
import { validateAdapterContract } from '@practicehub/platform-integration';
import { stripeAdapterContract } from './stripe.adapter-contract.js';

const tenant = 'northwind-synthetic';

const row: VendorRegistryRow = {
  tenantId: tenant,
  vendorId: 'stripe-simulated',
  vendorClass: 'payments',
  isAiVendor: false,
  enforcementPoint: 'payment-intent-boundary',
  baaStatus: 'executed',
  baaEffective: '2026-01-01',
  baaExpiry: '2027-01-01',
  noTrainingOnPhi: false,
  zeroRetention: false,
  permittedCategories: ['PAY', 'ID'],
  status: 'active',
  version: 1,
  synthetic: true,
};

const egressBase: Omit<EgressRequest, 'categories' | 'phiClass'> = {
  tenantId: tenant,
  vendorId: 'stripe-simulated',
  purpose: 'payment',
  asOf: '2026-06-01',
  actorRef: 'synthetic-staff:stripe',
  occurredAt: '2026-06-01T09:00:00Z',
};

function payment(intentId = 'intent-1') {
  return {
    tenantId: tenant,
    intentId,
    sku: 'sku_9f3a2c',
    metadata: { orderRef: 'ord-1' },
    payloadRef: 'payload:stripe:1',
    requestedAt: '2026-09-12T14:00:00.000Z',
  };
}

describe('stripeAdapterContract', () => {
  it('is a complete AUTH-006 contract', () => {
    expect(validateAdapterContract(stripeAdapterContract)).toEqual([]);
    expect(stripeAdapterContract.authorityId).toBe('AUTH-006');
  });
});

describe('StripeSimClient', () => {
  it('blocks PHI metadata before the rail is called', async () => {
    const post = vi.fn();
    const client = new StripeSimClient({ post, get: vi.fn() }, row, egressBase);
    const result = await client.createPaymentIntent({
      ...payment(),
      metadata: { patient: 'x' },
    });
    expect(result.status).toBe('lint-blocked');
    expect(post).not.toHaveBeenCalled();
  });

  it('round-trips create-payment-intent through RAIL-008', async () => {
    const engine = new VendorSimEngine({ rails: [stripeSim], store: new InMemorySimStateStore() });
    const client = new StripeSimClient(
      {
        post: async (path, body) => {
          const response = handleSimRequest(engine, { method: 'POST', path, body });
          if (response.status !== 200) throw new Error(String(response.body['error']));
          return response.body;
        },
        get: async (path) => handleSimRequest(engine, { method: 'GET', path }).body,
      },
      row,
      egressBase,
    );
    await expect(client.createPaymentIntent(payment())).resolves.toMatchObject({
      status: 'accepted',
      synthetic: true,
    });
  });

  it('dedupes the same intent id on the real rail', async () => {
    const engine = new VendorSimEngine({ rails: [stripeSim], store: new InMemorySimStateStore() });
    const client = new StripeSimClient(
      {
        post: async (path, body) => handleSimRequest(engine, { method: 'POST', path, body }).body,
        get: async (path) => handleSimRequest(engine, { method: 'GET', path }).body,
      },
      row,
      egressBase,
    );
    const first = await client.createPaymentIntent(payment());
    const second = await client.createPaymentIntent(payment());
    expect(first.effectKey).toBe(second.effectKey);
    expect(second.status === 'accepted' || second.status === 'deduplicated').toBe(true);
  });

  it('fails closed on a mismatched rail id', async () => {
    const client = new StripeSimClient(
      {
        post: vi.fn().mockResolvedValue({
          synthetic: true,
          response: { synthetic: true, status: 'accepted', railId: 'RAIL-003' },
        }),
        get: vi.fn(),
      },
      row,
      egressBase,
    );
    await expect(client.createPaymentIntent(payment())).rejects.toThrow(
      'failed correlation or shape validation',
    );
  });
});
