/**
 * Expected-volume heartbeat modeling (WP-028), the kit half.
 *
 * The three claims the gate rests on:
 *   1. the band is a WIDENING of the WP-021 `reconciliationAlarm` rule, not a
 *      fork — pinned as an equivalence over a grid at tolerance 0;
 *   2. no declarable model can make total silence quiet;
 *   3. a rail emitting liveness with no traffic (lost volume) and a rail
 *      emitting neither (gone) are different faults, and both are loud.
 */

import { describe, expect, it } from 'vitest';

import { reconciliationAlarm } from '@practicehub/platform';

import { VendorSimEngine } from './engine.js';
import {
  assertRailHeartbeatModel,
  evaluateRailHeartbeat,
  RailHeartbeatError,
  sweepRailHeartbeats,
  type RailHeartbeatModel,
} from './heartbeat.js';
import type { RailSim } from './rail.js';
import { InMemorySimStateStore } from './store.js';

const band = (
  expectedEffectsPerWindow: number,
  volumeTolerance = 0,
  emitsIdleHeartbeat = false,
): RailHeartbeatModel => ({ expectedEffectsPerWindow, volumeTolerance, emitsIdleHeartbeat });

const railWith = (heartbeat: RailHeartbeatModel): RailSim => ({
  railId: 'RAIL-000',
  authorityId: 'AUTH-000',
  name: 'kit-heartbeat-rail',
  pinnedVendorVersion: 'kit-v1',
  operations: ['send'],
  presets: [],
  heartbeat,
  effectKeyFor: (operation, request) => `synthetic:rail-000/${operation}/${request.idempotencyKey}`,
});

describe('heartbeat model declaration', () => {
  it('refuses a rail with no expectation — it could never raise a silence alarm', () => {
    expect(() => assertRailHeartbeatModel('RAIL-000', band(0))).toThrow(RailHeartbeatError);
    expect(() => assertRailHeartbeatModel('RAIL-000', band(0))).toThrow(/integer >= 1/);
  });

  it('refuses a tolerance whose band would contain zero — silence must stay loud', () => {
    expect(() => assertRailHeartbeatModel('RAIL-000', band(5, 5))).toThrow(
      /total silence must never evaluate quiet/,
    );
    expect(() => assertRailHeartbeatModel('RAIL-000', band(5, 6))).toThrow(RailHeartbeatError);
    expect(() => assertRailHeartbeatModel('RAIL-000', band(5, 4))).not.toThrow();
  });

  it('refuses the model at ENGINE CONSTRUCTION, so no sim can be built around one', () => {
    expect(() => new VendorSimEngine({ rails: [railWith(band(3, 3))] })).toThrow(
      RailHeartbeatError,
    );
  });

  it('refuses an observation carrying anything but non-negative integer counts', () => {
    expect(() =>
      evaluateRailHeartbeat(band(2), {
        railId: 'RAIL-000',
        observedEffects: -1,
        observedHeartbeats: 0,
        reconciliationRan: true,
      }),
    ).toThrow(/carries counts, never values/);
  });
});

describe('window evaluation', () => {
  const observe = (
    observedEffects: number,
    observedHeartbeats = 0,
    reconciliationRan = true,
  ): Parameters<typeof evaluateRailHeartbeat>[1] => ({
    railId: 'RAIL-000',
    observedEffects,
    observedHeartbeats,
    reconciliationRan,
  });

  it('is quiet only when the volume sits inside the band', () => {
    const model = band(10, 2);
    expect(evaluateRailHeartbeat(model, observe(10)).verdict).toBe('quiet');
    expect(evaluateRailHeartbeat(model, observe(8)).verdict).toBe('quiet');
    expect(evaluateRailHeartbeat(model, observe(12)).verdict).toBe('quiet');
    expect(evaluateRailHeartbeat(model, observe(7)).reasons).toEqual(['volume-below-band']);
    expect(evaluateRailHeartbeat(model, observe(13)).reasons).toEqual(['volume-above-band']);
  });

  it('separates lost traffic from a dead rail', () => {
    const model = band(10, 2, true);
    // Liveness, no traffic: the rail is up and its volume vanished.
    expect(evaluateRailHeartbeat(model, observe(0, 3)).reasons).toEqual(['volume-below-band']);
    // Neither: the rail itself is gone, and that is a different page.
    expect(evaluateRailHeartbeat(model, observe(0, 0)).reasons).toEqual([
      'volume-below-band',
      'idle-heartbeat-missing',
      'rail-dark',
    ]);
  });

  it('alarms when the sweep did not run, and does not pretend to know the volume', () => {
    const evaluation = evaluateRailHeartbeat(band(10, 2), observe(10, 1, false));
    expect(evaluation.verdict).toBe('alarm');
    expect(evaluation.reasons).toEqual(['reconciliation-did-not-run']);
  });

  it('never returns quiet for a silent window, whatever the model declares', () => {
    for (let expected = 1; expected <= 8; expected += 1) {
      for (let tolerance = 0; tolerance < expected; tolerance += 1) {
        for (const idle of [false, true]) {
          const evaluation = evaluateRailHeartbeat(band(expected, tolerance, idle), observe(0, 0));
          expect(evaluation.verdict, `expected=${expected} tolerance=${tolerance}`).toBe('alarm');
          expect(evaluation.reasons).toContain('rail-dark');
        }
      }
    }
  });

  it('is exactly the WP-021 reconciliation rule at tolerance 0 — widened, never forked', () => {
    for (let expected = 1; expected <= 4; expected += 1) {
      for (let observed = 0; observed <= 6; observed += 1) {
        for (const ran of [true, false]) {
          const evaluation = evaluateRailHeartbeat(band(expected), observe(observed, 0, ran));
          expect(
            evaluation.verdict === 'alarm',
            `expected=${expected} observed=${observed} ran=${String(ran)}`,
          ).toBe(reconciliationAlarm({ expectedVolume: expected, observedVolume: observed, ran }));
        }
      }
    }
  });
});

describe('fleet sweep', () => {
  it('alarms a rail with no observation rather than skipping it', () => {
    const swept = sweepRailHeartbeats(
      [
        { railId: 'RAIL-000', heartbeat: band(2) },
        { railId: 'RAIL-001', heartbeat: band(2) },
      ],
      [{ railId: 'RAIL-000', observedEffects: 2, observedHeartbeats: 0, reconciliationRan: true }],
    );
    expect(swept.map((entry) => entry.verdict)).toEqual(['quiet', 'alarm']);
    expect(swept[1]?.reasons).toEqual(['reconciliation-did-not-run', 'rail-dark']);
  });
});

describe('observation derived from the ledger', () => {
  const request = (key: string): Parameters<VendorSimEngine['dispatch']>[0] => ({
    railId: 'RAIL-000',
    operation: 'send',
    idempotencyKey: `synthetic-heartbeat-${key}`,
    payloadRef: `synthetic-heartbeat-payload-${key}`,
    requestedAt: '2026-01-01T00:00:00Z',
    synthetic: true,
  });

  it('counts only effects that actually landed — an uncertain outcome reads as loss', () => {
    const engine = new VendorSimEngine({
      rails: [railWith(band(2))],
      store: new InMemorySimStateStore(),
    });
    engine.dispatch(request('a'));
    expect(engine.observeWindow('RAIL-000').observedEffects).toBe(1);

    engine.controller.armScenario({
      railId: 'RAIL-000',
      primitiveId: 'X-05',
      dataPolicy: 'synthetic-only',
    });
    engine.dispatch(request('b'));
    expect(engine.observeWindow('RAIL-000').observedEffects).toBe(1);
    expect(engine.heartbeatSweep()[0]?.reasons).toEqual(['volume-below-band']);

    engine.dispatch(request('c'));
    expect(engine.heartbeatSweep()[0]?.verdict).toBe('quiet');
  });

  it('records idle ticks and clears them on the rollback path', () => {
    const engine = new VendorSimEngine({
      rails: [railWith(band(2, 0, true))],
      store: new InMemorySimStateStore(),
    });
    expect(engine.heartbeatSweep()[0]?.reasons).toEqual([
      'volume-below-band',
      'idle-heartbeat-missing',
      'rail-dark',
    ]);

    engine.recordHeartbeat('RAIL-000', '2026-01-01T00:00:00Z');
    expect(engine.observeWindow('RAIL-000').observedHeartbeats).toBe(1);
    expect(engine.heartbeatSweep()[0]?.reasons).toEqual(['volume-below-band']);

    engine.reset();
    expect(engine.snapshot().heartbeats).toEqual([]);
  });

  it('refuses a heartbeat for a rail the service does not declare', () => {
    const engine = new VendorSimEngine({ rails: [railWith(band(2))] });
    expect(() => engine.recordHeartbeat('RAIL-999', '2026-01-01T00:00:00Z')).toThrow(
      /unknown rail/,
    );
  });
});
