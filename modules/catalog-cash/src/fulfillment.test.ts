import { describe, expect, it } from 'vitest';

import { FulfillmentStore } from './fulfillment.js';

describe('FulfillmentStore', () => {
  it('creates one owned paid obligation idempotently and refunds without deletion', () => {
    const store = new FulfillmentStore();
    const item = {
      tenantId: 'northwind-synthetic',
      obligationId: 'ob-1',
      orderRef: 'order-1',
      offerVersionRef: 'offer-v1',
      componentRef: 'c1#1',
      ownerRole: 'guide',
      state: 'paid' as const,
    };
    expect(store.createPaid(item)).toEqual(store.createPaid(item));
    expect(store.refund(item.tenantId, item.orderRef)[0]?.state).toBe('refunded');
    expect(store.forOrder(item.tenantId, item.orderRef)).toHaveLength(1);
    expect(store.getFulfillmentStatus(item.tenantId, item.orderRef)).toEqual({
      orderRef: 'order-1',
      aggregateState: 'refunded',
      componentStates: [{ componentRef: 'c1#1', state: 'refunded' }],
    });
  });

  it('keeps delimiter-bearing tenant and obligation tuples distinct', () => {
    const store = new FulfillmentStore();
    const base = {
      orderRef: 'order-1',
      offerVersionRef: 'offer-v1',
      componentRef: 'c1#1',
      ownerRole: 'guide',
      state: 'paid' as const,
    };
    store.createPaid({ ...base, tenantId: 'tenant:a', obligationId: 'b' });
    store.createPaid({ ...base, tenantId: 'tenant', obligationId: 'a:b' });
    expect(store.forOrder('tenant:a', 'order-1')).toHaveLength(1);
    expect(store.forOrder('tenant', 'order-1')).toHaveLength(1);
  });
});
