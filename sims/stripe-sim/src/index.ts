import { InMemorySimStateStore, VendorSimEngine } from '@practicehub/vendor-sim-kit';
import { handleSimRequest, stripeSim } from '@practicehub/vendor-simulator';
import type { SimHttpRequest, SimHttpResponse } from '@practicehub/vendor-simulator';

/** In-process RAIL-008 stripe-sim. Does not copy or rewrite vendor-simulator sources. */
export function createStripeSimEngine(): VendorSimEngine {
  return new VendorSimEngine({ rails: [stripeSim], store: new InMemorySimStateStore() });
}

export function handleStripeSimRequest(
  engine: VendorSimEngine,
  request: SimHttpRequest,
): SimHttpResponse {
  return handleSimRequest(engine, request);
}

export { stripeSim };
