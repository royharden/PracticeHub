import { describe, expect, it, vi } from 'vitest';
import { InMemorySimStateStore, VendorSimEngine } from '@practicehub/vendor-sim-kit';
import { handleSimRequest, twilioSim } from '@practicehub/vendor-simulator';

import { TwilioSimClient } from './sim-client.js';

describe('TwilioSimClient', () => {
  it('uses the frozen simulator route and a tenant-scoped idempotency key', async () => {
    const post = vi.fn().mockImplementation((_path: string, body: Record<string, unknown>) => ({
      synthetic: true,
      response: {
        railId: 'RAIL-003',
        operation: 'send-message',
        idempotencyKey: body['idempotencyKey'],
        status: 'uncertain',
        effectKey: 'effect-1',
        receiptRef: null,
        requiresReconciliation: true,
        retryAfterSeconds: null,
        effectState: 'unknown',
        synthetic: true,
      },
    }));
    const client = new TwilioSimClient({ post, get: vi.fn() });
    const result = await client.sendMessage({
      tenantId: 'tenant-a',
      threadId: 'thread-1',
      messageId: 'message-1',
      payloadRef: 'payload:1',
      channel: 'sms',
      requestedAt: '2026-09-12T14:00:00.000Z',
    });
    expect(post).toHaveBeenCalledWith(
      '/rails/RAIL-003/send-message',
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^msg-[0-9a-f]{64}$/),
        payload: expect.objectContaining({ threadRef: '["tenant-a","thread-1"]' }),
        synthetic: true,
      }),
    );
    expect(result).toMatchObject({ deliveryState: 'unknown', requiresReconciliation: true });
  });

  it('round-trips through the real RAIL-003 handler and engine', async () => {
    const engine = new VendorSimEngine({ rails: [twilioSim], store: new InMemorySimStateStore() });
    const client = new TwilioSimClient({
      post: async (path, body) => {
        const response = handleSimRequest(engine, { method: 'POST', path, body });
        if (response.status !== 200) throw new Error(String(response.body['error']));
        return response.body;
      },
      get: async (path) => handleSimRequest(engine, { method: 'GET', path }).body,
    });
    await expect(
      client.sendMessage({
        tenantId: 'tenant-a',
        threadId: 'thread-1',
        messageId: 'message-1',
        payloadRef: 'payload:1',
        channel: 'sms',
        requestedAt: '2026-09-12T14:00:00.000Z',
      }),
    ).resolves.toMatchObject({ status: 'accepted', deliveryState: 'accepted' });
  });

  it.each([
    ['X-13', 'throttled', 30],
    ['X-14', 'unauthorized', null],
    ['X-15', 'conflict', null],
  ] as const)(
    'preserves the real %s negative result',
    async (primitive, status, retryAfterSeconds) => {
      const engine = new VendorSimEngine({
        rails: [twilioSim],
        store: new InMemorySimStateStore(),
      });
      expect(
        handleSimRequest(engine, { method: 'POST', path: `/scenarios/RAIL-003/${primitive}` })
          .status,
      ).toBe(200);
      const client = new TwilioSimClient({
        post: async (path, body) => handleSimRequest(engine, { method: 'POST', path, body }).body,
        get: async (path) => handleSimRequest(engine, { method: 'GET', path }).body,
      });
      await expect(
        client.sendMessage({
          tenantId: 'tenant-a',
          threadId: 'thread-1',
          messageId: `message-${primitive.toLowerCase()}`,
          payloadRef: 'payload:1',
          channel: 'sms',
          requestedAt: '2026-09-12T14:00:00.000Z',
        }),
      ).resolves.toMatchObject({ status, deliveryState: 'failed', retryAfterSeconds });
    },
  );

  it('fails closed on a malformed or mismatched simulator response', async () => {
    const client = new TwilioSimClient({
      post: vi.fn().mockResolvedValue({
        synthetic: true,
        response: { synthetic: true, status: 'accepted', railId: 'RAIL-008' },
      }),
      get: vi.fn(),
    });
    await expect(
      client.sendMessage({
        tenantId: 'tenant-a',
        threadId: 'thread-1',
        messageId: 'message-1',
        payloadRef: 'payload:1',
        channel: 'sms',
        requestedAt: '2026-09-12T14:00:00.000Z',
      }),
    ).rejects.toThrow('failed correlation or shape validation');
  });

  it('fails closed on a contradictory accepted-but-unknown response', async () => {
    const client = new TwilioSimClient({
      post: vi.fn().mockResolvedValue({
        synthetic: true,
        response: {
          synthetic: true,
          railId: 'RAIL-003',
          operation: 'send-message',
          idempotencyKey: '["tenant-a","message-1"]',
          status: 'accepted',
          effectKey: 'effect-1',
          receiptRef: null,
          requiresReconciliation: true,
          retryAfterSeconds: null,
          effectState: 'unknown',
        },
      }),
      get: vi.fn(),
    });
    await expect(
      client.sendMessage({
        tenantId: 'tenant-a',
        threadId: 'thread-1',
        messageId: 'message-1',
        payloadRef: 'payload:1',
        channel: 'sms',
        requestedAt: '2026-09-12T14:00:00.000Z',
      }),
    ).rejects.toThrow('failed correlation or shape validation');
  });

  it('drains the real RAIL-003 receipt route for reconciliation', async () => {
    const get = vi.fn().mockResolvedValue({ receipts: [] });
    const client = new TwilioSimClient({ post: vi.fn(), get });
    await client.drainReceipts();
    expect(get).toHaveBeenCalledWith('/receipts/RAIL-003');
  });
});
