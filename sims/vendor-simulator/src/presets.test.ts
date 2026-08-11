/**
 * The WP-028 gate, executable: "per-rail injection presets green" +
 * "expected-volume heartbeat modeling".
 *
 * The primitive x rail matrix (matrix.test.ts) proves every primitive behaves on
 * every rail. That is NOT the same claim as this file's: a preset is the binding
 * between a rail and one ORDINAL of its authority's row in the private join — the
 * named failure story that authority owes a simulator for. This file EXECUTES
 * each preset, primitive by primitive in its declared order, and asserts the
 * observed behaviour against each primitive's declared outcome class, plus the
 * two structural invariants that must survive every story: one ledger record per
 * idempotency key, and no dispatch path that re-sends an external effect.
 *
 * A preset naming a primitive whose engine branch drifted, an ordinal claimed
 * twice, or a story the engine cannot actually run therefore fails HERE, in the
 * public suite, rather than at the private join gate alone.
 */

import { describe, expect, it } from 'vitest';

import {
  evaluateRailHeartbeat,
  injectionPrimitivesV1,
  InMemorySimStateStore,
  SimProcessKill,
  VendorSimEngine,
  type InjectionPrimitive,
  type RailRequest,
  type RailSim,
} from '@practicehub/vendor-sim-kit';

import { railSimsV1 } from './rails.js';

const primitiveById = new Map(
  injectionPrimitivesV1.map((primitive) => [primitive.primitiveId, primitive] as const),
);

/** Outcome classes under which the external effect genuinely landed. */
const landingClasses = new Set([
  'delivered-slow',
  'deduplicated',
  'extra-receipt',
  'withheld-receipt',
  'reordered-receipts',
  'late-receipt',
  'superseding-receipt',
  'reversing-receipt',
  'split-effect',
  'version-drift',
]);

function requestFor(rail: RailSim, key: string, operation?: string): RailRequest {
  const chosen = operation ?? rail.operations[0];
  if (chosen === undefined) {
    throw new Error(`rail ${rail.railId} declares no operations`);
  }
  // The sim ref grammar is lower-case by construction (the WP-020 audit grammar).
  const slug = key.toLowerCase();
  return {
    railId: rail.railId,
    operation: chosen,
    idempotencyKey: `synthetic-preset-${slug}`,
    payloadRef: `synthetic-preset-payload-${slug}`,
    requestedAt: '2026-01-01T00:00:00Z',
    payload: { synthetic: true, ref: 'synthetic-preset-body' },
    synthetic: true,
  };
}

function driveStep(
  engine: VendorSimEngine,
  rail: RailSim,
  primitive: InjectionPrimitive,
  key: string,
): void {
  engine.controller.armScenario({
    railId: rail.railId,
    primitiveId: primitive.primitiveId,
    dataPolicy: 'synthetic-only',
  });
  const request = requestFor(rail, key);

  if (primitive.primitiveId === 'X-02') {
    // The crash step never answers; what matters is what it leaves behind.
    expect(() => engine.dispatch(request)).toThrow(SimProcessKill);
    const record = engine
      .snapshot()
      .effects.find((effect) => effect.idempotencyKey === request.idempotencyKey);
    expect(record?.state, `${rail.railId}: crash leaves an unknown effect`).toBe('unknown');
    expect(record?.receiptRef).toBeNull();
    return;
  }

  const response = engine.dispatch(request);
  // The replay primitive answers from the ledger branch, which carries no
  // injection attribution by design (the same allowance the matrix makes).
  expect(
    response.outcomeClass ?? primitive.outcomeClass,
    `${rail.railId}/${primitive.primitiveId}: outcome class`,
  ).toBe(primitive.outcomeClass);
  expect(response.resendsExternalEffect).toBe(false);
  expect(response.effectState === 'landed' || response.effectState === 'partial').toBe(
    landingClasses.has(primitive.outcomeClass),
  );
  expect(response.vendorVersion.startsWith(rail.pinnedVendorVersion)).toBe(true);
}

describe('per-rail injection presets', () => {
  it('every rail declares at least one preset bound to a distinct authority ordinal', () => {
    for (const rail of railSimsV1) {
      expect(rail.presets.length, rail.railId).toBeGreaterThan(0);
      const ordinals = rail.presets.map((preset) => preset.authorityScenarioIndex);
      expect(new Set(ordinals).size, rail.railId).toBe(ordinals.length);
      for (const ordinal of ordinals) {
        expect(Number.isInteger(ordinal) && ordinal >= 0, rail.railId).toBe(true);
      }
    }
  });

  for (const rail of railSimsV1) {
    for (const preset of rail.presets) {
      it(`${rail.railId} (${rail.name}) preset ${preset.presetId}`, () => {
        const engine = new VendorSimEngine({ rails: [rail], store: new InMemorySimStateStore() });

        preset.primitiveIds.forEach((primitiveId, index) => {
          const primitive = primitiveById.get(primitiveId);
          expect(
            primitive,
            `${preset.presetId} names unknown primitive ${primitiveId}`,
          ).toBeDefined();
          if (primitive === undefined) {
            return;
          }
          // Each step is its own caller intent, so a story of two failures is
          // two effects rather than one effect the engine silently re-sends.
          driveStep(engine, rail, primitive, `${rail.railId}-${preset.presetId}-${String(index)}`);
        });

        const effects = engine.snapshot().effects;
        expect(effects).toHaveLength(preset.primitiveIds.length);
        expect(new Set(effects.map((effect) => effect.idempotencyKey)).size).toBe(effects.length);
        for (const effect of effects) {
          expect(effect.synthetic).toBe(true);
          expect(effect.railId).toBe(rail.railId);
        }

        // Re-delivering every key of the story adds no external effect: the
        // preset cannot manufacture a duplicate however its primitives compose.
        engine.controller.disarmAll();
        for (const effect of effects) {
          const replay = engine.dispatch({
            ...requestFor(rail, 'replay'),
            idempotencyKey: effect.idempotencyKey,
            requestedAt: '2026-01-01T01:00:00Z',
          });
          expect(replay.resendsExternalEffect).toBe(false);
          expect(['deduplicated', 'uncertain', 'accepted']).toContain(replay.status);
        }
        expect(engine.snapshot().effects).toHaveLength(preset.primitiveIds.length);
      });
    }
  }

  it('summaries stay neutral — a preset never mirrors the private join text', () => {
    for (const rail of railSimsV1) {
      for (const preset of rail.presets) {
        expect(preset.summary.trim().length, `${rail.railId}/${preset.presetId}`).toBeGreaterThan(
          40,
        );
        expect(preset.summary, `${rail.railId}/${preset.presetId}`).not.toMatch(/\bSIM-[A-Z]/);
      }
    }
  });
});

describe('expected-volume heartbeat modeling, per rail', () => {
  it('every rail declares a band under which total silence is loud', () => {
    for (const rail of railSimsV1) {
      const silent = evaluateRailHeartbeat(rail.heartbeat, {
        railId: rail.railId,
        observedEffects: 0,
        observedHeartbeats: 0,
        reconciliationRan: true,
      });
      expect(silent.verdict, rail.railId).toBe('alarm');
      expect(silent.reasons, rail.railId).toContain('rail-dark');
      expect(rail.heartbeat.volumeTolerance, rail.railId).toBeLessThan(
        rail.heartbeat.expectedEffectsPerWindow,
      );
    }
  });

  it('a fleet with no traffic alarms on every rail, and naming one rail is not enough', () => {
    const engine = new VendorSimEngine({
      rails: railSimsV1,
      store: new InMemorySimStateStore(),
    });
    const swept = engine.heartbeatSweep();
    expect(swept).toHaveLength(railSimsV1.length);
    expect(swept.every((entry) => entry.verdict === 'alarm')).toBe(true);
  });

  it('carrying a rail to its expectation quiets THAT rail and no other', () => {
    const engine = new VendorSimEngine({
      rails: railSimsV1,
      store: new InMemorySimStateStore(),
    });
    // The licensed-content rail declares the smallest honest band (a rights check
    // per window), which makes it the cheap end-to-end proof of the mechanism.
    const rail = railSimsV1.find((entry) => entry.railId === 'RAIL-016');
    expect(rail).toBeDefined();
    if (rail === undefined) {
      return;
    }
    for (let index = 0; index < rail.heartbeat.expectedEffectsPerWindow; index += 1) {
      engine.dispatch(requestFor(rail, `band-${String(index)}`));
    }
    if (rail.heartbeat.emitsIdleHeartbeat) {
      engine.recordHeartbeat(rail.railId, '2026-01-01T00:00:00Z');
    }

    const swept = engine.heartbeatSweep();
    const quiet = swept.filter((entry) => entry.verdict === 'quiet').map((entry) => entry.railId);
    expect(quiet).toEqual([rail.railId]);
  });

  it('an outage on a carried rail takes it back out of its band', () => {
    const rail = railSimsV1.find((entry) => entry.railId === 'RAIL-016');
    expect(rail).toBeDefined();
    if (rail === undefined) {
      return;
    }
    const engine = new VendorSimEngine({ rails: [rail], store: new InMemorySimStateStore() });
    engine.controller.armScenario({
      railId: rail.railId,
      primitiveId: 'X-16',
      dataPolicy: 'synthetic-only',
    });
    engine.dispatch(requestFor(rail, 'outage'));
    engine.recordHeartbeat(rail.railId, '2026-01-01T00:00:00Z');

    const evaluation = engine.heartbeatSweep()[0];
    expect(evaluation?.verdict).toBe('alarm');
    // Liveness without traffic: the rail answers and carries nothing.
    expect(evaluation?.reasons).toEqual(['volume-below-band']);
  });
});
