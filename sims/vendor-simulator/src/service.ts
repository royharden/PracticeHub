/**
 * The scenario-control surface (WP-027) as a PURE request handler over the
 * engine, so every route is unit-testable without a socket and the HTTP
 * bootstrap stays a thin shell. Contract:
 * docs/contracts/vendor-sim-scenario-api.md (FROZEN) §3.
 *
 * `SimProcessKill` is deliberately NOT caught here: an armed process-crash
 * primitive must reach the bootstrap, which kills the process without answering
 * — a simulator that politely reports its own death simulates nothing.
 */

import {
  injectionPrimitiveCatalogStatus,
  injectionPrimitivesV1,
  SimProcessKill,
  type RailRequest,
  type VendorSimEngine,
} from '@practicehub/vendor-sim-kit';
import type { RailScenarioOptions } from '@practicehub/platform-integration';

export interface SimHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

export interface SimHttpResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  /** The bootstrap kills the process when this is set (the /control/kill hook). */
  readonly kill?: true;
}

const notFound: SimHttpResponse = {
  status: 404,
  body: { error: 'not-found', synthetic: true },
};

function ok(body: Record<string, unknown>): SimHttpResponse {
  return { status: 200, body: { ...body, synthetic: true } };
}

function badRequest(error: unknown): SimHttpResponse {
  return {
    status: 400,
    body: { error: error instanceof Error ? error.message : String(error), synthetic: true },
  };
}

function segments(path: string): readonly string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function railRequestFrom(railId: string, operation: string, body: unknown): RailRequest {
  const payload = (body ?? {}) as Record<string, unknown>;
  return {
    railId,
    operation,
    idempotencyKey: String(payload.idempotencyKey ?? ''),
    payloadRef: String(payload.payloadRef ?? ''),
    requestedAt: String(payload.requestedAt ?? ''),
    payload: payload.payload,
    synthetic: payload.synthetic === true,
  } as RailRequest;
}

export function handleSimRequest(
  engine: VendorSimEngine,
  request: SimHttpRequest,
): SimHttpResponse {
  const parts = segments(request.path);
  const [head, first, second] = parts;

  if (request.method === 'GET' && head === 'healthz' && parts.length === 1) {
    return ok({
      service: 'practicehub-vendor-simulator',
      status: 'ok',
      dataPolicy: engine.dataPolicy,
      rails: engine.rails().length,
      primitives: injectionPrimitivesV1.length,
    });
  }

  if (request.method === 'GET' && head === 'primitives' && parts.length === 1) {
    return ok({
      catalog: injectionPrimitivesV1,
      catalogStatus: injectionPrimitiveCatalogStatus,
    });
  }

  if (request.method === 'GET' && head === 'rails' && parts.length === 1) {
    return ok({
      rails: engine.rails().map((rail) => ({
        railId: rail.railId,
        authorityId: rail.authorityId,
        name: rail.name,
        pinnedVendorVersion: rail.pinnedVendorVersion,
        operations: rail.operations,
        presets: rail.presets,
      })),
    });
  }

  if (request.method === 'GET' && head === 'scenarios' && parts.length === 1) {
    return ok({ armed: engine.controller.listArmed() });
  }

  if (request.method === 'DELETE' && head === 'scenarios' && parts.length === 1) {
    engine.controller.disarmAll();
    return ok({ armed: engine.controller.listArmed() });
  }

  if (
    request.method === 'POST' &&
    head === 'scenarios' &&
    parts.length === 3 &&
    first !== undefined &&
    second !== undefined
  ) {
    try {
      const armed = engine.controller.armScenario({
        railId: first,
        primitiveId: second,
        dataPolicy: engine.dataPolicy,
        options: (request.body ?? {}) as RailScenarioOptions,
      });
      return ok({ armed });
    } catch (error) {
      return badRequest(error);
    }
  }

  if (
    request.method === 'POST' &&
    head === 'rails' &&
    parts.length === 3 &&
    first !== undefined &&
    second !== undefined
  ) {
    try {
      return ok({ response: engine.dispatch(railRequestFrom(first, second, request.body)) });
    } catch (error) {
      if (error instanceof SimProcessKill) {
        // Never answered: an armed crash must reach the bootstrap and kill the
        // process. Reporting it as a tidy 400 would simulate nothing.
        throw error;
      }
      return badRequest(error);
    }
  }

  if (
    request.method === 'GET' &&
    head === 'receipts' &&
    parts.length === 2 &&
    first !== undefined
  ) {
    try {
      return ok({ receipts: engine.drainReceipts(first) });
    } catch (error) {
      return badRequest(error);
    }
  }

  if (request.method === 'GET' && head === 'state' && parts.length === 1) {
    return ok({ state: engine.snapshot() });
  }

  // WP-028 heartbeat surface. Additive to the WP-027 route table: it changes no
  // frozen route's meaning, and it carries COUNTS only — a rail's liveness is
  // observable without anything that could hold a value.
  if (request.method === 'GET' && head === 'heartbeat' && parts.length === 1) {
    return ok({
      heartbeat: engine.heartbeatSweep(),
      models: engine.rails().map((rail) => ({ railId: rail.railId, ...rail.heartbeat })),
    });
  }

  if (
    request.method === 'POST' &&
    head === 'heartbeat' &&
    parts.length === 2 &&
    first !== undefined
  ) {
    try {
      const body = (request.body ?? {}) as Record<string, unknown>;
      return ok({ heartbeat: engine.recordHeartbeat(first, String(body.recordedAt ?? '')) });
    } catch (error) {
      return badRequest(error);
    }
  }

  if (request.method === 'POST' && head === 'control' && first === 'reset' && parts.length === 2) {
    engine.reset();
    return ok({ reset: true, state: engine.snapshot() });
  }

  if (request.method === 'POST' && head === 'control' && first === 'kill' && parts.length === 2) {
    return { status: 500, body: { killed: true, synthetic: true }, kill: true };
  }

  return notFound;
}
