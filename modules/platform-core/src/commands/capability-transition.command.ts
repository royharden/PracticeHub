/**
 * Applying a capability transition is itself a governed side effect: the
 * command moves under `platform.capability-registry`, floored at `simulated`
 * (the local synthetic stack operates the registry in simulated mode; a
 * tenant whose registry capability is disabled — Riverbend, the standing
 * opposite-state proof — cannot apply transitions at all).
 */

import {
  applyCapabilityTransition,
  type CapabilityGrant,
  type CapabilityRegistry,
  type CapabilityTransitionEvent,
  type CapabilityTransitionRequest,
} from '../capability.js';
import { defineCommandHandler } from '../commands.js';

export interface CapabilityTransitionCommandInput {
  readonly registry: CapabilityRegistry;
  readonly grants: readonly CapabilityGrant[];
  readonly request: CapabilityTransitionRequest;
  readonly eventId: string;
}

export const capabilityTransitionCommand = defineCommandHandler<
  CapabilityTransitionCommandInput,
  CapabilityTransitionEvent
>({
  capabilityId: 'platform.capability-registry',
  minimumState: 'simulated',
  handle: (_context, input) =>
    applyCapabilityTransition(input.registry, input.grants, input.request, input.eventId),
});
