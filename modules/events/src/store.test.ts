import { buildEventEnvelope, type DeliveryStatus } from '@practicehub/platform';
import { describe, expect, it, vi } from 'vitest';

import { deliverClaimedEvent, markDeliveryFailed, type Queryable } from './store.js';

const eventId = '01H8XGJWBWBAQ4Z5Z5Z5Z5Z5Z5';
const envelope = buildEventEnvelope({
  eventId,
  tenantId: 'northwind-synthetic',
  type: 'test.delivery',
  aggregate: { type: 'test', id: 'synthetic-aggregate', version: 1 },
  occurredAt: '2026-04-01T00:00:00Z',
  recordedAt: '2026-04-01T00:00:00Z',
  source: { module: 'events' },
  idempotencyKey: 'synthetic:delivery',
  dataClassification: 'none',
  payload: { synthetic: true },
  synthetic: true,
});

function recorder() {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const exec: Queryable = {
    query: async (text, params = []) => {
      queries.push({ text, params });
      return { rows: [], rowCount: 1 };
    },
  };
  return { exec, queries };
}

describe('event delivery repository', () => {
  it.each(['pending', 'failed'] as const)(
    'NR-043 denied %s delivery records only parking and passes the logical clock',
    async (status) => {
      const { exec, queries } = recorder();
      const sideEffect = vi.fn();
      const nowIso = '2030-01-01T00:00:00Z';
      const outcome = await deliverClaimedEvent(exec, {
        claimed: { envelope, delivery: { status, attempts: 1 } },
        consumer: 'synthetic-consumer',
        capabilityAllowed: false,
        seen: new Set(),
        retryPolicy: { maxAttempts: 3 },
        nowIso,
        sideEffect,
      });
      expect(outcome).toEqual({ action: 'park-denied', effected: false });
      expect(sideEffect).not.toHaveBeenCalled();
      expect(queries).toHaveLength(1);
      expect(queries[0]?.params).toEqual([eventId, nowIso]);
      expect(queries[0]?.text).toContain('SET park_count =');
      expect(queries[0]?.text).not.toMatch(/\battempts\s*=/);
      expect(queries[0]?.text).not.toMatch(/\bstatus\s*=/);
      // SQL scheduling/counter behavior is proven by EV-16..EV-20, not this recorder.
    },
  );

  it('keeps the database clock fallback for a direct caller', async () => {
    const { exec, queries } = recorder();
    await deliverClaimedEvent(exec, {
      claimed: { envelope, delivery: { status: 'pending', attempts: 0 } },
      consumer: 'synthetic-consumer',
      capabilityAllowed: false,
      seen: new Set(),
      retryPolicy: { maxAttempts: 3 },
    });
    expect(queries[0]?.params).toEqual([eventId, null]);
    expect(queries[0]?.text).toContain('COALESCE($2::timestamptz, now())');
  });

  it.each(['published', 'dead'] as const)(
    'a denied terminal %s event does not even park',
    async (status) => {
      const { exec, queries } = recorder();
      const sideEffect = vi.fn();
      const outcome = await deliverClaimedEvent(exec, {
        claimed: { envelope, delivery: { status: status as DeliveryStatus, attempts: 3 } },
        consumer: 'synthetic-consumer',
        capabilityAllowed: false,
        seen: new Set(),
        retryPolicy: { maxAttempts: 3 },
        sideEffect,
      });
      expect(outcome).toEqual({ action: 'noop', effected: false });
      expect(queries).toHaveLength(0);
      expect(sideEffect).not.toHaveBeenCalled();
    },
  );

  it.each([
    [0, 'retry-later', 'failed'],
    [1, 'retry-later', 'failed'],
    [2, 'dead-letter', 'dead'],
  ] as const)(
    'records one genuine failure after %i earlier failures',
    async (attempts, action, status) => {
      const { exec, queries } = recorder();
      expect(
        await markDeliveryFailed(exec, {
          eventId,
          delivery: { status: 'failed', attempts },
          retryPolicy: { maxAttempts: 3 },
          errorRef: 'synthetic:publish-failure',
        }),
      ).toBe(action);
      expect(queries[0]?.params).toEqual([
        eventId,
        status,
        attempts + 1,
        'synthetic:publish-failure',
      ]);
      expect(queries[0]?.text).not.toContain('park_count');
    },
  );
});
