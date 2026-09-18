import { describe, expect, it } from 'vitest';

import { StripeWebhookInbox, type StripeWebhook } from './webhook-inbox.js';

function event(overrides: Partial<StripeWebhook> = {}): StripeWebhook {
  return {
    tenantId: 'northwind-synthetic',
    eventId: 'evt-1',
    sequence: 1,
    type: 'payment_intent.succeeded',
    payloadRef: 'payload:wh:1',
    receivedAt: '2026-06-01T09:00:00Z',
    ...overrides,
  };
}

describe('StripeWebhookInbox', () => {
  it('applies the next sequence once', () => {
    const inbox = new StripeWebhookInbox();
    const first = inbox.ingest(event());
    expect(first.status).toBe('applied');
    expect(first.appliedEffectKeys).toEqual(['wh-northwind-synthetic-evt-1']);
    expect(first.missingSequences).toEqual([]);
  });

  it('treats a duplicate event id as one effect', () => {
    const inbox = new StripeWebhookInbox();
    inbox.ingest(event());
    const again = inbox.ingest(event({ receivedAt: '2026-06-01T09:01:00Z' }));
    expect(again.status).toBe('duplicate');
    expect(again.appliedEffectKeys).toEqual(['wh-northwind-synthetic-evt-1']);
    expect(inbox.replay('evt-1').status).toBe('duplicate');
  });

  it('buffers an out-of-order later sequence and reports the gap', () => {
    const inbox = new StripeWebhookInbox();
    const buffered = inbox.ingest(event({ eventId: 'evt-3', sequence: 3 }));
    expect(buffered.status).toBe('buffered');
    expect(buffered.appliedEffectKeys).toEqual([]);
    expect(buffered.missingSequences).toEqual([1, 2]);
  });

  it('drains a gap when the missing sequence arrives, then applies the buffered tail', () => {
    const inbox = new StripeWebhookInbox();
    inbox.ingest(event({ eventId: 'evt-2', sequence: 2 }));
    expect(inbox.gaps()).toEqual([1]);
    const filled = inbox.ingest(event({ eventId: 'evt-1', sequence: 1 }));
    expect(filled.status).toBe('applied');
    expect(filled.appliedEffectKeys).toEqual([
      'wh-northwind-synthetic-evt-1',
      'wh-northwind-synthetic-evt-2',
    ]);
    expect(filled.missingSequences).toEqual([]);
  });
});
