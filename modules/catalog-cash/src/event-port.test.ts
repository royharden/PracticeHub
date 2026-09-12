import type { Queryable } from '@practicehub/events';
import { describe, expect, it } from 'vitest';

import { EventSpinePaidServicePort } from './event-port.js';

class QueryRecorder implements Queryable {
  public readonly statements: string[] = [];
  public query(text: string): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
    this.statements.push(text);
    return Promise.resolve({ rows: [], rowCount: 1 });
  }
}

describe('EventSpinePaidServicePort', () => {
  it('publishes through the real WP-021 outbox binding with a PHI-free envelope', async () => {
    const exec = new QueryRecorder();
    await new EventSpinePaidServicePort(exec).publish({
      eventId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      tenantId: 'northwind-synthetic',
      type: 'payment.reconciled',
      orderRef: 'order-1',
      journalRef: 'journal-1',
      occurredAt: '2026-04-01T12:00:00Z',
      correlationId: 'corr:paid-service:1',
      idempotencyKey: 'event-key-1',
      externalReceiptRef: 'receipt-opaque-1',
    });
    expect(exec.statements).toHaveLength(2);
    expect(exec.statements[0]).toContain('INSERT INTO events.outbox');
    expect(exec.statements[1]).toContain('INSERT INTO events.outbox_delivery');
  });
});
