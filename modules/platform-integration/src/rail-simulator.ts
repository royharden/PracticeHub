/**
 * Rail-simulator control PORT (WP-027, M07). Contract:
 * docs/contracts/vendor-sim-scenario-api.md (FROZEN) §3/§9.
 *
 * The module declares the port; the simulator implements it (the WP-024
 * `InboundFaxPort` / WP-025 `RecordsExportGuard` precedent), so no module ever
 * depends on a sim package. What lives here is the AUTHORITY half:
 *
 *   - the frozen id grammars and the kill-point vocabulary (one source of truth,
 *     imported by the sim kit rather than re-declared there);
 *   - `validateRailScenarioRequest` — arming a failure mode is refused outright
 *     unless the environment declares itself synthetic-only. That check is
 *     BELOW the capability gate on purpose: a capability grant can be wrong, and
 *     a simulator scenario must never be armable against a non-synthetic
 *     environment whatever the registry says (fail closed, no override path).
 *
 * The capability gate itself lives on `injectRailScenario`
 * (`platform.rail-simulator`, floored `simulated`). Reads and the RESET
 * direction are never gated — a rollback must always be available.
 */

import { railIdPattern } from './adapters.js';

export const railSimulatorPrimitiveIdPattern = /^X-\d{2}$/;

/**
 * Where an armed process-crash primitive kills the rail. The ledger write order
 * around these points is the durability contract (§6 of the frozen contract).
 */
export const railSimulatorKillPoints = [
  'before-effect',
  'after-effect-before-receipt',
  'after-receipt',
] as const;
export type RailSimulatorKillPoint = (typeof railSimulatorKillPoints)[number];

/** The only data policy under which a scenario may be armed. */
export const syntheticOnlyDataPolicy = 'synthetic-only';

export interface RailScenarioOptions {
  /** Arm only from this attempt onward (default 1 — the first request). */
  readonly afterAttempts?: number;
  /** How many requests the primitive shapes; 0 means until it is disarmed (default 1). */
  readonly count?: number;
  /** Declared latency for the latency primitive (never a wall-clock sleep in tests). */
  readonly delayMs?: number;
  /** Retry allowance surfaced by the throttling primitive. */
  readonly retryAfterSeconds?: number;
  /** Where the process-crash primitive kills the rail. */
  readonly killPoint?: RailSimulatorKillPoint;
}

export interface RailScenarioRequest {
  readonly railId: string;
  readonly primitiveId: string;
  /** The environment's declared data policy; anything but synthetic-only fails closed. */
  readonly dataPolicy: string;
  readonly options?: RailScenarioOptions;
}

export interface ArmedRailScenario {
  readonly railId: string;
  readonly primitiveId: string;
  readonly appliedCount: number;
}

/**
 * The control surface a simulator exposes to the platform. Arming is
 * authority-bearing (it changes what an external rail does); listing and
 * disarming are not.
 */
export interface RailSimulatorControlPort {
  armScenario(request: RailScenarioRequest): ArmedRailScenario;
  listArmed(): readonly ArmedRailScenario[];
  disarmAll(): void;
}

export class RailScenarioError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RailScenarioError';
  }
}

/**
 * Validate a scenario-arming request. Fails closed on a non-synthetic data
 * policy, an unknown id grammar, or nonsensical options — there is no override
 * path (the WP-026 egress-guard posture).
 */
export function validateRailScenarioRequest(request: RailScenarioRequest): void {
  if (request.dataPolicy !== syntheticOnlyDataPolicy) {
    throw new RailScenarioError(
      `a rail scenario may be armed only against a ${syntheticOnlyDataPolicy} environment; received ${JSON.stringify(request.dataPolicy)}`,
    );
  }
  if (!railIdPattern.test(request.railId)) {
    throw new RailScenarioError(`railId ${JSON.stringify(request.railId)} is not a RAIL-### id`);
  }
  if (!railSimulatorPrimitiveIdPattern.test(request.primitiveId)) {
    throw new RailScenarioError(
      `primitiveId ${JSON.stringify(request.primitiveId)} is not an X-## injection primitive id`,
    );
  }
  const options = request.options;
  if (options === undefined) {
    return;
  }
  if (
    options.afterAttempts !== undefined &&
    (!Number.isInteger(options.afterAttempts) || options.afterAttempts < 1)
  ) {
    throw new RailScenarioError('afterAttempts must be a positive integer');
  }
  if (options.count !== undefined && (!Number.isInteger(options.count) || options.count < 0)) {
    throw new RailScenarioError('count must be a non-negative integer (0 = until disarmed)');
  }
  if (
    options.delayMs !== undefined &&
    (!Number.isInteger(options.delayMs) || options.delayMs < 0)
  ) {
    throw new RailScenarioError('delayMs must be a non-negative integer');
  }
  if (
    options.retryAfterSeconds !== undefined &&
    (!Number.isInteger(options.retryAfterSeconds) || options.retryAfterSeconds < 0)
  ) {
    throw new RailScenarioError('retryAfterSeconds must be a non-negative integer');
  }
  if (
    options.killPoint !== undefined &&
    !(railSimulatorKillPoints as readonly string[]).includes(options.killPoint)
  ) {
    throw new RailScenarioError(`unknown kill point ${JSON.stringify(options.killPoint)}`);
  }
}
