/**
 * Rail-scenario injection command (WP-027, M07). Contract:
 * docs/contracts/vendor-sim-scenario-api.md (FROZEN) §9.
 *
 * Arming a failure mode on a rail is AUTHORITY-BEARING: it changes what an
 * external rail does to whatever traffic that rail carries. So it moves under
 * `platform.rail-simulator`, floored at `simulated`. WP-027 seeds the capability
 * at `scaffolded` (the package ceiling), so the seeded local grant DENIES a live
 * injection; the activation walk belongs to the packages that take the rails
 * into the reference loops. Riverbend (disabled) is the standing opposite-state
 * proof.
 *
 * Two independent refusals guard the same act: `validateRailScenarioRequest`
 * refuses any environment that is not synthetic-only (below the registry — a
 * grant cannot buy its way past it), and the capability gate decides who may
 * arm at all. Reads (catalog, rails, ledger dump) and the RESET direction are
 * NEVER gated — a rollback must always be available (the audit.emit precedent).
 */

import { defineCommandHandler } from '@practicehub/platform-core';

import { validateRailScenarioRequest, type RailScenarioRequest } from '../rail-simulator.js';

export interface InjectRailScenarioCommandInput {
  readonly scenario: RailScenarioRequest;
}

export const injectRailScenarioCommand = defineCommandHandler<
  InjectRailScenarioCommandInput,
  RailScenarioRequest
>({
  capabilityId: 'platform.rail-simulator',
  minimumState: 'simulated',
  handle: (_context, input) => {
    validateRailScenarioRequest(input.scenario);
    return input.scenario;
  },
});
