import {
  requireCapability,
  type CapabilityGrant,
  type CapabilityRegistry,
} from '@practicehub/platform-core';

import { GatewayRefusal } from './guards.js';
import type { InferenceAuthorizationPort } from './ports.js';

/** Runtime adapter for the integrator-owned `ai.gateway` capability definition. */
export class RegistryInferenceAuthorization implements InferenceAuthorizationPort {
  public constructor(
    private readonly registry: CapabilityRegistry,
    private readonly grants: readonly CapabilityGrant[],
  ) {}

  public authorize(request: Parameters<InferenceAuthorizationPort['authorize']>[0]) {
    try {
      const decision = requireCapability(
        this.registry,
        this.grants,
        {
          tenantId: request.tenantId,
          scope: { feature: request.useCase, cohort: request.cohortRef },
        },
        'ai.gateway',
        { minimumState: 'simulated', checkpoint: 'enqueue', purpose: request.purpose },
      );
      return { allowed: decision.allowed, reason: decision.reason };
    } catch (error) {
      return {
        allowed: false,
        reason: error instanceof Error ? error.name : 'capability-denied',
      };
    }
  }
}

export function requireInferenceAuthorization(
  port: InferenceAuthorizationPort,
  request: Parameters<InferenceAuthorizationPort['authorize']>[0],
): void {
  if (!port.authorize(request).allowed) {
    throw new GatewayRefusal('capability-denied', 'ai.gateway is below the simulated floor');
  }
}
