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
      rails: 5,
      primitives: 18,
      synthetic: true,
    });
  });

  it('serves the primitive catalog with its draft status, and the rail declarations', () => {
    const catalog = call(service(), 'GET', '/primitives');
    expect((catalog.body.catalog as unknown[]).length).toBe(18);
    expect(catalog.body.catalogStatus).toMatchObject({ version: 'v1', status: 'draft' });

    const rails = call(service(), 'GET', '/rails');
    const declared = rails.body.rails as { railId: string; authorityId: string }[];
    expect(declared.map((rail) => rail.railId)).toEqual([
      'RAIL-002',
      'RAIL-003',
      'RAIL-008',
      'RAIL-009',
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
      synthetic: true,
    });
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
