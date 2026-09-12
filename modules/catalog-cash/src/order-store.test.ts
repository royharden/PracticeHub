import { describe, expect, it } from 'vitest';

import { InMemoryPaidServiceOrderStore } from './order-store.js';
import type { PaidServiceOrder } from './paid-service-loop.js';

const order: PaidServiceOrder = {
  tenantId: 'northwind-synthetic',
  orderId: 'order-1',
  buyerRef: 'buyer-1',
  memberRef: 'member-1',
  offer: {
    tenantId: 'northwind-synthetic',
    catalogVersionRef: 'catalog-v1',
    offerVersionRef: 'offer-v1',
    opaqueProcessorSkuRef: 'sku-1',
    amountMinor: 100,
    currency: 'USD',
    expiresAt: '2027-01-01T00:00:00Z',
    componentLines: [],
    cancellationPolicyRef: 'cancel-v1',
    refundPolicyRef: 'refund-v1',
    synthetic: true,
  },
  state: 'reconciled',
  entitlementEvents: [],
  fulfillment: [],
};

describe('PaidServiceOrderStore', () => {
  it('rehydrates the exact purchase aggregate and rejects request drift', async () => {
    const store = new InMemoryPaidServiceOrderStore();
    const record = {
      tenantId: order.tenantId,
      purchaseKey: 'purchase-1',
      requestHash: 'a'.repeat(64),
      occurredAt: '2026-04-01T12:00:00Z',
      order,
    };
    await store.save(record);
    expect(await store.load(order.tenantId, record.purchaseKey)).toEqual(record);
    expect(() => store.save({ ...record, requestHash: 'b'.repeat(64) })).toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
  });
});
