/**
 * Expected-volume heartbeat modeling (WP-028). Contract:
 * docs/contracts/rail-sim-fleet.md (FROZEN) §5.
 *
 * A rail that answers every request correctly and a rail that has silently
 * stopped carrying traffic look identical from the response side: both produce
 * no errors. The heartbeat model is how the difference becomes observable.
 *
 * Three deliberate properties:
 *
 *  1. NO FORK. The volume half composes `reconciliationAlarm` from
 *     `@practicehub/platform` (WP-021) — the band only ever WIDENS that exact
 *     -match rule, never narrows it, and a unit test pins the equivalence at
 *     tolerance 0. One model of "a dead reconciliation is not a clean night",
 *     extended, not re-derived (the WP-019 F4 discipline).
 *  2. SILENCE IS UNREPRESENTABLE AS CALM. `assertRailHeartbeatModel` refuses a
 *     model whose band could contain zero (`expectedEffectsPerWindow >= 1` and
 *     `volumeTolerance < expectedEffectsPerWindow`), so no rail can DECLARE
 *     itself into a posture where total silence evaluates quiet.
 *  3. TWO DIFFERENT FAULTS, DISTINGUISHED. A rail emitting its idle heartbeat
 *     but carrying no effects lost its traffic (`volume-below-band`); a rail
 *     emitting neither is itself gone (`rail-dark`). Collapsing them would hide
 *     the outage inside the loss.
 *
 * Counts only: an observation carries integers and ids, never a payload — the
 * store's PHI-free posture extends to the heartbeat surface by construction.
 */

import { reconciliationAlarm } from '@practicehub/platform';

export interface RailHeartbeatModel {
  /**
   * Effects this rail is expected to carry per reconciliation window at its
   * declared traffic band. Must be >= 1: a rail with no expectation could never
   * raise a silence alarm.
   */
  readonly expectedEffectsPerWindow: number;
  /**
   * How far the observed volume may sit from the expectation before the window
   * is alarmed. Must be < `expectedEffectsPerWindow`, so a band can never
   * swallow zero.
   */
  readonly volumeTolerance: number;
  /**
   * Whether the rail emits an idle heartbeat when it carries no effects. A rail
   * that does distinguishes "quiet" from "gone"; a rail that does not can only
   * be judged on volume.
   */
  readonly emitsIdleHeartbeat: boolean;
}

export interface RailWindowObservation {
  readonly railId: string;
  readonly observedEffects: number;
  readonly observedHeartbeats: number;
  /** False when the reconciliation sweep did not run for this rail at all. */
  readonly reconciliationRan: boolean;
}

export const railHeartbeatReasons = [
  'reconciliation-did-not-run',
  'volume-below-band',
  'volume-above-band',
  'idle-heartbeat-missing',
  'rail-dark',
] as const;
export type RailHeartbeatReason = (typeof railHeartbeatReasons)[number];

export const railHeartbeatVerdicts = ['quiet', 'alarm'] as const;
export type RailHeartbeatVerdict = (typeof railHeartbeatVerdicts)[number];

export interface RailHeartbeatEvaluation {
  readonly railId: string;
  readonly verdict: RailHeartbeatVerdict;
  /** Closed vocabulary, in declaration order; empty exactly when the verdict is quiet. */
  readonly reasons: readonly RailHeartbeatReason[];
  readonly expectedEffectsPerWindow: number;
  readonly observedEffects: number;
  readonly observedHeartbeats: number;
}

export class RailHeartbeatError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RailHeartbeatError';
  }
}

/**
 * A model is only declarable if a silent window must alarm under it. This is the
 * structural half of the gate: the property is not tested into existence, it is
 * refused at the boundary.
 */
export function assertRailHeartbeatModel(railId: string, model: RailHeartbeatModel): void {
  if (!Number.isInteger(model.expectedEffectsPerWindow) || model.expectedEffectsPerWindow < 1) {
    throw new RailHeartbeatError(
      `${railId}: expectedEffectsPerWindow must be an integer >= 1 — a rail with no expectation can never raise a silence alarm`,
    );
  }
  if (!Number.isInteger(model.volumeTolerance) || model.volumeTolerance < 0) {
    throw new RailHeartbeatError(`${railId}: volumeTolerance must be a non-negative integer`);
  }
  if (model.volumeTolerance >= model.expectedEffectsPerWindow) {
    throw new RailHeartbeatError(
      `${railId}: volumeTolerance ${model.volumeTolerance} would let the band contain zero — total silence must never evaluate quiet`,
    );
  }
}

function assertObservation(observation: RailWindowObservation): void {
  for (const [label, value] of [
    ['observedEffects', observation.observedEffects],
    ['observedHeartbeats', observation.observedHeartbeats],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RailHeartbeatError(
        `${observation.railId}: ${label} must be a non-negative integer (a heartbeat observation carries counts, never values)`,
      );
    }
  }
}

/**
 * Evaluate one rail's reconciliation window. Reasons accumulate — a window can
 * be both dark and unreconciled, and reporting one would hide the other.
 */
export function evaluateRailHeartbeat(
  model: RailHeartbeatModel,
  observation: RailWindowObservation,
): RailHeartbeatEvaluation {
  assertRailHeartbeatModel(observation.railId, model);
  assertObservation(observation);

  const reasons: RailHeartbeatReason[] = [];

  // The WP-021 primitive owns "did it run, and did the count match": composed,
  // never re-derived. Only the tolerance band is this module's addition.
  const volumeAlarm = reconciliationAlarm({
    expectedVolume: model.expectedEffectsPerWindow,
    observedVolume: observation.observedEffects,
    ran: observation.reconciliationRan,
  });

  if (!observation.reconciliationRan) {
    reasons.push('reconciliation-did-not-run');
  } else if (volumeAlarm) {
    const floor = model.expectedEffectsPerWindow - model.volumeTolerance;
    const ceiling = model.expectedEffectsPerWindow + model.volumeTolerance;
    if (observation.observedEffects < floor) {
      reasons.push('volume-below-band');
    } else if (observation.observedEffects > ceiling) {
      reasons.push('volume-above-band');
    }
  }

  if (model.emitsIdleHeartbeat && observation.observedHeartbeats === 0) {
    reasons.push('idle-heartbeat-missing');
  }
  if (observation.observedEffects === 0 && observation.observedHeartbeats === 0) {
    // Neither traffic nor liveness: the rail is not quiet, it is gone. The model
    // assertion above guarantees this branch can never coexist with a quiet
    // verdict, whatever a rail declares.
    reasons.push('rail-dark');
  }

  return {
    railId: observation.railId,
    verdict: reasons.length === 0 ? 'quiet' : 'alarm',
    reasons,
    expectedEffectsPerWindow: model.expectedEffectsPerWindow,
    observedEffects: observation.observedEffects,
    observedHeartbeats: observation.observedHeartbeats,
  };
}

export interface RailHeartbeatSubject {
  readonly railId: string;
  readonly heartbeat: RailHeartbeatModel;
}

/**
 * Sweep every declared rail. A rail with NO observation is alarmed rather than
 * skipped — a sweep that silently omits a rail is the failure this whole module
 * exists to catch.
 */
export function sweepRailHeartbeats(
  rails: readonly RailHeartbeatSubject[],
  observations: readonly RailWindowObservation[],
): readonly RailHeartbeatEvaluation[] {
  const byRail = new Map(observations.map((entry) => [entry.railId, entry] as const));
  return rails.map((rail) =>
    evaluateRailHeartbeat(
      rail.heartbeat,
      byRail.get(rail.railId) ?? {
        railId: rail.railId,
        observedEffects: 0,
        observedHeartbeats: 0,
        reconciliationRan: false,
      },
    ),
  );
}
