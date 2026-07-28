/**
 * Scenario controller (WP-027) — the armed-primitive half of the frozen
 * scenario-control API (docs/contracts/vendor-sim-scenario-api.md §3).
 *
 * Deterministic by construction: no wall clock and no randomness. Whether an
 * armed primitive applies to a given request is decided from the request's
 * ATTEMPT number (which the ledger owns) and the scenario's own applied count,
 * so the same sequence of requests always produces the same sequence of
 * injections — which is what makes a simulator usable as a test oracle.
 */

import {
  validateRailScenarioRequest,
  type ArmedRailScenario,
  type RailScenarioOptions,
  type RailScenarioRequest,
  type RailSimulatorControlPort,
} from '@practicehub/platform-integration';

import { requireInjectionPrimitive, type InjectionPrimitive } from './primitives.js';

export interface ArmedScenario {
  readonly railId: string;
  readonly primitiveId: string;
  readonly options: RailScenarioOptions;
  appliedCount: number;
}

export class ScenarioController implements RailSimulatorControlPort {
  private readonly armed = new Map<string, ArmedScenario>();

  /**
   * Arm a primitive on a rail. The request is validated by the M07-owned
   * validator FIRST (synthetic-only environment, id grammars, option shapes) —
   * the sim never re-derives that policy.
   */
  public armScenario(request: RailScenarioRequest): ArmedRailScenario {
    validateRailScenarioRequest(request);
    requireInjectionPrimitive(request.primitiveId);
    const scenario: ArmedScenario = {
      railId: request.railId,
      primitiveId: request.primitiveId,
      options: request.options ?? {},
      appliedCount: 0,
    };
    this.armed.set(request.railId, scenario);
    return { railId: scenario.railId, primitiveId: scenario.primitiveId, appliedCount: 0 };
  }

  public listArmed(): readonly ArmedRailScenario[] {
    return [...this.armed.values()]
      .map((scenario) => ({
        railId: scenario.railId,
        primitiveId: scenario.primitiveId,
        appliedCount: scenario.appliedCount,
      }))
      .sort((left, right) => left.railId.localeCompare(right.railId));
  }

  public disarmAll(): void {
    this.armed.clear();
  }

  public armedFor(railId: string): ArmedScenario | undefined {
    return this.armed.get(railId);
  }

  /**
   * Decide whether the rail's armed primitive shapes THIS request, and record
   * the application. `afterAttempts` delays the injection until a retry;
   * `count` bounds how many requests it shapes (0 = until disarmed).
   */
  public consume(
    railId: string,
    attempt: number,
  ): { readonly primitive: InjectionPrimitive; readonly options: RailScenarioOptions } | null {
    const scenario = this.armed.get(railId);
    if (!scenario) {
      return null;
    }
    const afterAttempts = scenario.options.afterAttempts ?? 1;
    if (attempt < afterAttempts) {
      return null;
    }
    const count = scenario.options.count ?? 1;
    if (count !== 0 && scenario.appliedCount >= count) {
      return null;
    }
    scenario.appliedCount += 1;
    return {
      primitive: requireInjectionPrimitive(scenario.primitiveId),
      options: scenario.options,
    };
  }
}
