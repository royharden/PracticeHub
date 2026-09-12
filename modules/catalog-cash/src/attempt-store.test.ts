import { describe, expect, it } from 'vitest';

import { InMemoryPaidServiceAttemptStore, PgPaidServiceAttemptStore } from './attempt-store.js';

const purchase = {
  tenantId: 'northwind-synthetic',
  operation: 'purchase' as const,
  idempotencyKey: 'key-1',
  requestHash: 'a'.repeat(64),
  authorityHash: 'b'.repeat(64),
  orderRef: 'order-1',
};

describe('PaidServiceAttemptStore', () => {
  it('persists effect and completion evidence across coordinator retries', async () => {
    const store = new InMemoryPaidServiceAttemptStore();
    await store.reserve(purchase);
    await store.markSubmitted(purchase);
    expect(
      (await store.load(purchase.tenantId, purchase.operation, purchase.idempotencyKey))?.submitted,
    ).toBe(true);
    await store.recordEffect({
      tenantId: purchase.tenantId,
      operation: purchase.operation,
      idempotencyKey: purchase.idempotencyKey,
      effect: {
        effectRef: 'effect-1',
        outcome: 'landed',
        receiptRef: 'receipt-1',
        observedAt: '2026-04-01T12:00:00Z',
      },
    });
    expect(
      (await store.load(purchase.tenantId, purchase.operation, purchase.idempotencyKey))?.effect
        ?.effectRef,
    ).toBe('effect-1');
    await store.complete(purchase);
    expect(
      (await store.load(purchase.tenantId, purchase.operation, purchase.idempotencyKey))?.completed,
    ).toBe(true);
    expect(() => store.markSubmitted(purchase)).toThrow('ATTEMPT_NOT_RESERVABLE');
  });

  it('makes submission ownership a one-way transition before any rail call', async () => {
    const store = new InMemoryPaidServiceAttemptStore();
    await store.reserve(purchase);
    expect(
      (await store.load(purchase.tenantId, purchase.operation, purchase.idempotencyKey))?.submitted,
    ).toBe(false);
    await store.markSubmitted(purchase);
    expect(
      (await store.load(purchase.tenantId, purchase.operation, purchase.idempotencyKey))?.submitted,
    ).toBe(true);
  });

  it('rejects a changed request identity and reserves one refund key per original order', async () => {
    const store = new InMemoryPaidServiceAttemptStore();
    await store.reserve(purchase);
    expect(() => store.reserve({ ...purchase, requestHash: 'b'.repeat(64) })).toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
    expect(() => store.reserve({ ...purchase, authorityHash: 'c'.repeat(64) })).toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
    await store.reserve({ ...purchase, operation: 'refund', idempotencyKey: 'refund-a' });
    expect(() =>
      store.reserve({ ...purchase, operation: 'refund', idempotencyKey: 'refund-b' }),
    ).toThrow('REFUND_ALREADY_RESERVED');
  });

  it('commits PostgreSQL submission ownership before markSubmitted returns', async () => {
    const statements: string[] = [];
    const store = new PgPaidServiceAttemptStore({
      query(text: string) {
        statements.push(text);
        return Promise.resolve({ rows: [], rowCount: text.startsWith('UPDATE') ? 1 : null });
      },
    });
    await store.markSubmitted(purchase);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.some((statement) => statement.includes("state='submitted'"))).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
  });
});
