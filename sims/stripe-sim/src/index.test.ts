import { describe, expect, it } from 'vitest';

import { createStripeSimEngine, handleStripeSimRequest } from './index.js';

const happy = {
  operation: 'create-payment-intent',
  idempotencyKey: 'synthetic-rail-008-happy',
  payloadRef: 'synthetic-payload-rail-008-happy',
  requestedAt: '2026-01-01T00:00:00Z',
  payload: { synthetic: true, ref: 'synthetic-body-happy' },
  synthetic: true,
};

describe('stripe-sim RAIL-008', () => {
  it('lands a clean create-payment-intent once', () => {
    const engine = createStripeSimEngine();
    const first = handleStripeSimRequest(engine, {
      method: 'POST',
      path: '/rails/RAIL-008/create-payment-intent',
      body: happy,
    });
    expect(first.status).toBe(200);
    const response = first.body['response'] as Record<string, unknown>;
    expect(response['status']).toBe('accepted');
    expect(response['effectState']).toBe('landed');
  });

  it('replays the same idempotency key without a second send', () => {
    const engine = createStripeSimEngine();
    const first = handleStripeSimRequest(engine, {
      method: 'POST',
      path: '/rails/RAIL-008/create-payment-intent',
      body: happy,
    });
    const second = handleStripeSimRequest(engine, {
      method: 'POST',
      path: '/rails/RAIL-008/create-payment-intent',
      body: happy,
    });
    const a = first.body['response'] as Record<string, unknown>;
    const b = second.body['response'] as Record<string, unknown>;
    expect(a['effectKey']).toBe(b['effectKey']);
    expect(b['status'] === 'accepted' || b['status'] === 'deduplicated').toBe(true);
  });

  it('arms X-06 webhook-gap then refuses a second send of the landed effect', () => {
    const engine = createStripeSimEngine();
    expect(
      handleStripeSimRequest(engine, {
        method: 'POST',
        path: '/scenarios/RAIL-008/X-06',
        body: { count: 1 },
      }).status,
    ).toBe(200);
    const gapped = handleStripeSimRequest(engine, {
      method: 'POST',
      path: '/rails/RAIL-008/create-payment-intent',
      body: {
        ...happy,
        idempotencyKey: 'synthetic-rail-008-boundary',
        payloadRef: 'synthetic-payload-rail-008-boundary',
      },
    });
    const gappedBody = gapped.body['response'] as Record<string, unknown>;
    expect(gappedBody['effectState']).toBe('landed');
    expect(gappedBody['receiptRef']).toBeNull();
    const receipts = handleStripeSimRequest(engine, {
      method: 'GET',
      path: '/receipts/RAIL-008',
    });
    expect(receipts.body['receipts']).toEqual([]);
    const retry = handleStripeSimRequest(engine, {
      method: 'POST',
      path: '/rails/RAIL-008/create-payment-intent',
      body: {
        ...happy,
        idempotencyKey: 'synthetic-rail-008-boundary',
        payloadRef: 'synthetic-payload-rail-008-boundary',
        requestedAt: '2026-01-01T00:01:00Z',
      },
    });
    const retryBody = retry.body['response'] as Record<string, unknown>;
    expect(retryBody['effectKey']).toBe(gappedBody['effectKey']);
  });
});
