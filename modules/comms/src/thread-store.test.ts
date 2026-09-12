import type { Queryable } from '@practicehub/events';
import { describe, expect, it, vi } from 'vitest';

import { appendThreadMessage, applyDeliveryReceipt } from './thread-store.js';
import { openThread, recordMessage } from './thread.js';

const occurredAt = '2026-09-12T14:00:00.000Z';
const observedAt = '2026-09-12T14:01:00.000Z';

function pending() {
  return recordMessage(
    openThread({
      tenantId: 'tenant-a',
      threadId: 'thread-1',
      personRef: 'person-1',
      workItemId: 'work-1',
      channel: 'sms',
      purpose: 'treatment',
      ownerRef: 'guide-1',
    }),
    {
      messageId: 'message-1',
      direction: 'outbound',
      contentRef: 'content:1',
      occurredAt,
      vendorEventKey: 'vendor-1',
      effectKey: 'effect-1',
      holding: false,
    },
  );
}

const lockedMessage = {
  message_id: 'message-1',
  direction: 'outbound',
  content_ref: 'content:1',
  occurred_at: occurredAt,
  vendor_event_key: 'vendor-1',
  effect_key: 'effect-1',
  delivery_state: 'unknown',
  holding: false,
};

const receipt = {
  receiptId: 'receipt-1',
  messageId: 'message-1',
  messageVendorEventKey: 'vendor-1',
  receiptEventKey: 'receipt-event-1',
  effectKey: 'effect-1',
  outcome: 'delivered' as const,
  observedAt,
};

describe('durable Thread state', () => {
  it('deduplicates an ingress replay after PostgreSQL timestamp hydration', async () => {
    const hydrated = recordMessage(
      openThread({
        tenantId: 'tenant-a',
        threadId: 'thread-1',
        personRef: 'person-1',
        workItemId: 'work-1',
        channel: 'sms',
        purpose: 'treatment',
        ownerRef: 'guide-1',
      }),
      {
        messageId: 'message-1',
        direction: 'inbound',
        contentRef: 'content:1',
        occurredAt: '2026-09-12T14:00:00.000Z',
        vendorEventKey: 'vendor-1',
        holding: false,
      },
    );
    const exec = { query: vi.fn() } satisfies Queryable;
    const hydratedMessage = hydrated.messages[0];
    if (hydratedMessage === undefined) throw new Error('hydrated message missing');
    await expect(
      appendThreadMessage(exec, hydrated, {
        ...hydratedMessage,
        occurredAt: '2026-09-12T14:00:00Z',
      }),
    ).resolves.toBe(hydrated);
    expect(exec.query).not.toHaveBeenCalled();
  });

  it('persists a correlated receipt then advances the message projection', async () => {
    const exec = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [lockedMessage], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }),
    } satisfies Queryable;
    const result = await applyDeliveryReceipt(exec, pending(), receipt);
    expect(result.messages[0]?.deliveryState).toBe('delivered');
    expect(exec.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('UPDATE comms.thread_message'),
      ['tenant-a', 'message-1', 'delivered'],
    );
  });

  it('makes an identical receipt replay a durable no-op', async () => {
    const exec = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ ...lockedMessage, delivery_state: 'delivered' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [
            {
              message_id: 'message-1',
              message_vendor_event_key: 'vendor-1',
              receipt_event_key: 'receipt-event-1',
              effect_key: 'effect-1',
              outcome: 'delivered',
              observed_at: new Date(observedAt),
            },
          ],
          rowCount: 1,
        }),
    } satisfies Queryable;
    const result = await applyDeliveryReceipt(exec, pending(), receipt);
    expect(result.messages[0]?.deliveryState).toBe('delivered');
    expect(exec.query).toHaveBeenCalledTimes(2);
  });

  it('accepts a known accepted-receipt replay after a later delivered receipt', async () => {
    const accepted = { ...receipt, outcome: 'accepted' as const };
    const exec = {
      query: vi
        .fn()
        .mockResolvedValueOnce({
          rows: [{ ...lockedMessage, delivery_state: 'delivered' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({
          rows: [
            {
              message_id: 'message-1',
              message_vendor_event_key: 'vendor-1',
              receipt_event_key: 'receipt-event-1',
              effect_key: 'effect-1',
              outcome: 'accepted',
              observed_at: new Date(observedAt),
            },
          ],
          rowCount: 1,
        }),
    } satisfies Queryable;
    const result = await applyDeliveryReceipt(exec, pending(), accepted);
    expect(result.messages[0]?.deliveryState).toBe('delivered');
    expect(exec.query).toHaveBeenCalledTimes(2);
  });
});
