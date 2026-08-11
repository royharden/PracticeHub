import { describe, expect, it } from 'vitest';

import {
  InMemorySimStateStore,
  SimProcessKill,
  VendorSimEngine,
} from '@practicehub/vendor-sim-kit';

import { railSimsV1 } from './rails.js';
import { handleSimRequest, type SimHttpRequest } from './service.js';

function service(dataPolicy = 'synthetic-only'): VendorSimEngine {
  return new VendorSimEngine({
    rails: railSimsV1,
    store: new InMemorySimStateStore(),
    dataPolicy,
  });
}

function call(
  engine: VendorSimEngine,
  method: string,
  path: string,
  body?: unknown,
): ReturnType<typeof handleSimRequest> {
  const request: SimHttpRequest = { method, path, ...(body === undefined ? {} : { body }) };
  return handleSimRequest(engine, request);
}

const dispatchBody = {
  idempotencyKey: 'synthetic-service-0001',
  payloadRef: 'synthetic-payload-service-0001',
  requestedAt: '2026-01-01T00:00:00Z',
  payload: { synthetic: true },
  synthetic: true,
};

describe('scenario-control surface', () => {
  it('reports health with the data policy, rail count, and primitive count', () => {
    const response = call(service(), 'GET', '/healthz');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      service: 'practicehub-vendor-simulator',
      status: 'ok',
      dataPolicy: 'synthetic-only',
      rails: 17,
      primitives: 18,
      synthetic: true,
    });
  });

  it('serves the primitive catalog with its accepted status, and the rail declarations', () => {
    const catalog = call(service(), 'GET', '/primitives');
    expect((catalog.body.catalog as unknown[]).length).toBe(18);
    expect(catalog.body.catalogStatus).toMatchObject({
      version: 'v1',
      status: 'accepted',
      ruledBy: 'ADR-ADJ-010',
    });

    const rails = call(service(), 'GET', '/rails');
    const declared = rails.body.rails as { railId: string; authorityId: string }[];
    expect(declared.map((rail) => rail.railId)).toEqual([
      'RAIL-002',
      'RAIL-003',
      'RAIL-005',
      'RAIL-006',
      'RAIL-007',
      'RAIL-008',
      'RAIL-009',
      'RAIL-010',
      'RAIL-011',
      'RAIL-012',
      'RAIL-013',
      'RAIL-014',
      'RAIL-015',
      'RAIL-016',
      'RAIL-017',
      'RAIL-018',
      'RAIL-022',
    ]);
    expect(declared.every((rail) => /^AUTH-\d{3}$/.test(rail.authorityId))).toBe(true);
  });

  it('arms, lists, and disarms a scenario', () => {
    const engine = service();
    expect(call(engine, 'POST', '/scenarios/RAIL-008/X-16').status).toBe(200);
    expect(call(engine, 'GET', '/scenarios').body.armed).toEqual([
      { railId: 'RAIL-008', primitiveId: 'X-16', appliedCount: 0 },
    ]);
    expect(call(engine, 'DELETE', '/scenarios').body.armed).toEqual([]);
  });

  it('refuses to arm against a non-synthetic environment — the fail-closed floor', () => {
    const engine = service('production');
    const response = call(engine, 'POST', '/scenarios/RAIL-008/X-16');
    expect(response.status).toBe(400);
    expect(String(response.body.error)).toMatch(/synthetic-only environment/);
    expect(call(engine, 'GET', '/scenarios').body.armed).toEqual([]);
  });

  it('refuses an unknown primitive, an unknown rail, and a non-synthetic request body', () => {
    const engine = service();
    expect(call(engine, 'POST', '/scenarios/RAIL-008/X-99').status).toBe(400);
    expect(call(engine, 'POST', '/rails/RAIL-777/create-payment-intent', dispatchBody).status).toBe(
      400,
    );
    const unwatermarked = call(engine, 'POST', '/rails/RAIL-008/create-payment-intent', {
      ...dispatchBody,
      synthetic: false,
    });
    expect(unwatermarked.status).toBe(400);
    expect(String(unwatermarked.body.error)).toMatch(/synthetic data only/);
  });

  it('drives a rail, drains its receipts, and dumps a PHI-free ledger', () => {
    const engine = service();
    const dispatched = call(engine, 'POST', '/rails/RAIL-008/create-payment-intent', dispatchBody);
    expect(dispatched.status).toBe(200);
    expect(dispatched.body.response).toMatchObject({ status: 'accepted', effectState: 'landed' });

    const receipts = call(engine, 'GET', '/receipts/RAIL-008').body.receipts as unknown[];
    expect(receipts).toHaveLength(1);

    const state = call(engine, 'GET', '/state').body.state as { effects: unknown[] };
    expect(state.effects).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain('payload"');
  });

  it('resets the ledger (the rollback path) without any capability of its own', () => {
    const engine = service();
    call(engine, 'POST', '/rails/RAIL-008/create-payment-intent', dispatchBody);
    const reset = call(engine, 'POST', '/control/reset');
    expect(reset.body.reset).toBe(true);
    expect(call(engine, 'GET', '/state').body.state).toEqual({
      effects: [],
      receipts: [],
      heartbeats: [],
      synthetic: true,
    });
  });

  it('serves the heartbeat sweep: a fleet with no traffic is loud on every rail', () => {
    const engine = service();
    const swept = call(engine, 'GET', '/heartbeat').body.heartbeat as {
      railId: string;
      verdict: string;
      reasons: string[];
    }[];
    expect(swept).toHaveLength(railSimsV1.length);
    expect(swept.every((entry) => entry.verdict === 'alarm')).toBe(true);
    expect(swept.every((entry) => entry.reasons.includes('rail-dark'))).toBe(true);
  });

  it('records an idle tick, which separates a quiet rail from a dead one', () => {
    const engine = service();
    const recorded = call(engine, 'POST', '/heartbeat/RAIL-016', {
      recordedAt: '2026-01-01T00:00:00Z',
    });
    expect(recorded.status).toBe(200);
    expect(recorded.body.heartbeat).toMatchObject({
      railId: 'RAIL-016',
      sequence: 1,
      synthetic: true,
    });

    const swept = call(engine, 'GET', '/heartbeat').body.heartbeat as {
      railId: string;
      reasons: string[];
    }[];
    const rail = swept.find((entry) => entry.railId === 'RAIL-016');
    expect(rail?.reasons).toEqual(['volume-below-band']);
    // The heartbeat surface carries counts, never a payload field.
    expect(JSON.stringify(swept)).not.toContain('payload');
  });

  it('refuses a heartbeat for an undeclared rail rather than inventing one', () => {
    expect(
      call(service(), 'POST', '/heartbeat/RAIL-999', { recordedAt: '2026-01-01T00:00:00Z' }).status,
    ).toBe(400);
  });

  it('lets an armed process-crash escape to the bootstrap instead of answering 400', () => {
    const engine = service();
    call(engine, 'POST', '/scenarios/RAIL-008/X-02', { killPoint: 'after-effect-before-receipt' });
    expect(() =>
      call(engine, 'POST', '/rails/RAIL-008/create-payment-intent', dispatchBody),
    ).toThrow(SimProcessKill);
    // The ledger still recorded the unknown effect before the death.
    const state = call(engine, 'GET', '/state').body.state as {
      effects: { state: string }[];
    };
    expect(state.effects[0]?.state).toBe('unknown');
  });

  it('signals the kill hook to the bootstrap rather than answering politely', () => {
    const killed = call(service(), 'POST', '/control/kill');
    expect(killed.kill).toBe(true);
    expect(killed.status).toBe(500);
  });

  it('answers 404 for anything the frozen surface does not declare', () => {
    expect(call(service(), 'GET', '/admin').status).toBe(404);
    expect(call(service(), 'POST', '/rails/RAIL-008').status).toBe(404);
  });
});
