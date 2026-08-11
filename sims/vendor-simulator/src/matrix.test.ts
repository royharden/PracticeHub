/**
 * The WP-027 gate, executable: "X-01..X-18 primitives drive each sim".
 *
 * Every primitive is armed against every rail (5 x 18 = 90 cells) and the
 * observed behaviour is checked against the CATALOG's own declared outcome
 * class — so a primitive whose engine branch drifts from its declaration fails
 * here, and a primitive added to the catalog with no branch fails loudly (the
 * dispatcher's `default` throws) rather than behaving like a clean send.
 *
 * Two invariants are asserted in every cell: no dispatch path re-sends an
 * external effect, and one idempotency key never yields two ledger records.
 */

import { describe, expect, it } from 'vitest';

import {
  injectionPrimitivesV1,
  InMemorySimStateStore,
  SimProcessKill,
  VendorSimEngine,
  type InjectionOutcomeClass,
  type RailRequest,
  type RailResponse,
  type RailSim,
  type SimReceipt,
} from '@practicehub/vendor-sim-kit';

import { railSimsV1 } from './rails.js';

interface CellExpectation {
  readonly status: RailResponse['status'];
  readonly effectState: RailResponse['effectState'];
  readonly receiptKinds: readonly string[];
  readonly receiptRefPresent: boolean;
  readonly requiresReconciliation: boolean;
}

const expectationByOutcomeClass: Readonly<Record<InjectionOutcomeClass, CellExpectation>> = {
  'delivered-slow': {
    status: 'accepted',
    effectState: 'landed',
    receiptKinds: ['primary'],
    receiptRefPresent: true,
    requiresReconciliation: false,
  },
  'transport-failure': {
    status: 'uncertain',
    effectState: 'unknown',
    receiptKinds: [],
    receiptRefPresent: false,
    requiresReconciliation: true,
  },
  deduplicated: {
    status: 'deduplicated',
    effectState: 'landed',
    receiptKinds: ['primary'],
    receiptRefPresent: true,
    requiresReconciliation: false,
  },
  'extra-receipt': {
    status: 'accepted',
    effectState: 'landed',
    receiptKinds: ['primary', 'duplicate'],
    receiptRefPresent: true,
    requiresReconciliation: false,
  },
  'withheld-receipt': {
    status: 'accepted',
    effectState: 'landed',
    receiptKinds: [],
    receiptRefPresent: false,
    requiresReconciliation: true,
  },
  'reordered-receipts': {
    status: 'accepted',
    effectState: 'landed',
    receiptKinds: ['late', 'primary'],
    receiptRefPresent: true,
    requiresReconciliation: false,
  },
  'late-receipt': {
    status: 'accepted',
    effectState: 'landed',
    receiptKinds: ['late'],
    receiptRefPresent: true,
    requiresReconciliation: true,
  },
  'superseding-receipt': {
    status: 'accepted',
    effectState: 'landed',
    receiptKinds: ['primary', 'corrected'],
    receiptRefPresent: true,
    requiresReconciliation: true,
  },
  'reversing-receipt': {
    status: 'accepted',
    effectState: 'landed',
    receiptKinds: ['primary', 'reversal'],
    receiptRefPresent: true,
    requiresReconciliation: true,
  },
  'split-effect': {
    status: 'accepted',
    effectState: 'partial',
    receiptKinds: ['partial'],
    receiptRefPresent: true,
    requiresReconciliation: true,
  },
  'business-rejection': {
    status: 'rejected',
    effectState: 'not-landed',
    receiptKinds: [],
    receiptRefPresent: false,
    requiresReconciliation: false,
  },
  throttled: {
    status: 'throttled',
    effectState: 'not-landed',
    receiptKinds: [],
    receiptRefPresent: false,
    requiresReconciliation: false,
  },
  unauthorized: {
    status: 'unauthorized',
    effectState: 'not-landed',
    receiptKinds: [],
    receiptRefPresent: false,
    requiresReconciliation: false,
  },
  conflict: {
    status: 'conflict',
    effectState: 'not-landed',
    receiptKinds: [],
    receiptRefPresent: false,
    requiresReconciliation: false,
  },
  unavailable: {
    status: 'unavailable',
    effectState: 'not-landed',
    receiptKinds: [],
    receiptRefPresent: false,
    requiresReconciliation: false,
  },
  'contract-violation': {
    status: 'malformed',
    effectState: 'unknown',
    receiptKinds: [],
    receiptRefPresent: false,
    requiresReconciliation: true,
  },
  'version-drift': {
    status: 'accepted',
    effectState: 'landed',
    receiptKinds: ['primary'],
    receiptRefPresent: true,
    requiresReconciliation: true,
  },
};

function requestFor(rail: RailSim, key: string): RailRequest {
  const operation = rail.operations[0];
  if (operation === undefined) {
    throw new Error(`rail ${rail.railId} declares no operations`);
  }
  return {
    railId: rail.railId,
    operation,
    idempotencyKey: `synthetic-matrix-${key}`,
    payloadRef: `synthetic-payload-${key}`,
    requestedAt: '2026-01-01T00:00:00Z',
    payload: { synthetic: true, note: 'synthetic-matrix-payload' },
    synthetic: true,
  };
}

function freshEngine(rail: RailSim): VendorSimEngine {
  return new VendorSimEngine({ rails: [rail], store: new InMemorySimStateStore() });
}

describe('primitive x rail matrix — every primitive drives every sim', () => {
  it('covers the whole declared fleet and eighteen primitives', () => {
    expect(railSimsV1).toHaveLength(17);
    expect(injectionPrimitivesV1).toHaveLength(18);
  });

  for (const rail of railSimsV1) {
    for (const primitive of injectionPrimitivesV1) {
      it(`${rail.railId} (${rail.name}) under ${primitive.primitiveId} ${primitive.name}`, () => {
        const sim = freshEngine(rail);
        const key = `${rail.railId}-${primitive.primitiveId}`.toLowerCase();
        sim.controller.armScenario({
          railId: rail.railId,
          primitiveId: primitive.primitiveId,
          dataPolicy: 'synthetic-only',
        });

        if (primitive.primitiveId === 'X-02') {
          // The crash primitive is the one that never returns.
          expect(() => sim.dispatch(requestFor(rail, key))).toThrow(SimProcessKill);
          const record = sim.snapshot().effects[0];
          expect(record?.state).toBe('unknown');
          expect(record?.receiptRef).toBeNull();
          expect(sim.snapshot().effects).toHaveLength(1);
          return;
        }

        const response = sim.dispatch(requestFor(rail, key));
        const expectation = expectationByOutcomeClass[primitive.outcomeClass];
        expect(response.outcomeClass ?? primitive.outcomeClass).toBe(primitive.outcomeClass);
        expect(response.status).toBe(expectation.status);
        expect(response.effectState).toBe(expectation.effectState);
        expect(response.requiresReconciliation).toBe(expectation.requiresReconciliation);
        expect(response.receiptRef === null).toBe(!expectation.receiptRefPresent);

        const drained: readonly SimReceipt[] = sim.drainReceipts(rail.railId);
        expect(drained.map((receipt) => receipt.kind)).toEqual(expectation.receiptKinds);

        // Structural, every cell: never a second send, never a second record.
        expect(response.resendsExternalEffect).toBe(false);
        expect(sim.snapshot().effects.length).toBeLessThanOrEqual(1);
        expect(response.vendorVersion.startsWith(rail.pinnedVendorVersion)).toBe(true);

        if (primitive.primitiveId === 'X-01') {
          expect(response.declaredDelayMs).toBeGreaterThan(0);
        }
        if (primitive.primitiveId === 'X-03') {
          expect(response.attempts).toBe(2);
          expect(response.duplicateOf).toBe(response.receiptRef);
        }
        if (primitive.primitiveId === 'X-07') {
          expect(drained.map((receipt) => receipt.sequence)).toEqual([2, 1]);
        }
        if (primitive.primitiveId === 'X-09') {
          expect(drained[1]?.supersedesRef).toBe(response.receiptRef);
        }
        if (primitive.primitiveId === 'X-10') {
          expect(drained[1]?.reversesRef).toBe(response.receiptRef);
        }
        if (primitive.primitiveId === 'X-13') {
          expect(response.retryAfterSeconds).toBeGreaterThan(0);
        }
        if (primitive.primitiveId === 'X-18') {
          expect(response.vendorVersion).not.toBe(rail.pinnedVendorVersion);
        }
      });
    }
  }
});

describe('rail declarations', () => {
  it('declares unique RAIL-### ids bound to AUTH-### authorities, with operations and presets', () => {
    const railIds = railSimsV1.map((rail) => rail.railId);
    expect(new Set(railIds).size).toBe(railIds.length);
    for (const rail of railSimsV1) {
      expect(rail.railId).toMatch(/^RAIL-\d{3}$/);
      expect(rail.authorityId).toMatch(/^AUTH-\d{3}$/);
      expect(rail.operations.length).toBeGreaterThan(0);
      expect(rail.presets.length).toBeGreaterThan(0);
      for (const preset of rail.presets) {
        expect(preset.primitiveIds.length).toBeGreaterThan(0);
        for (const primitiveId of preset.primitiveIds) {
          expect(injectionPrimitivesV1.map((entry) => entry.primitiveId)).toContain(primitiveId);
        }
        expect(preset.authorityScenarioIndex).toBeGreaterThanOrEqual(0);
      }
      // Preset ordinals within a rail are distinct — one preset per named scenario.
      const indexes = rail.presets.map((preset) => preset.authorityScenarioIndex);
      expect(new Set(indexes).size).toBe(indexes.length);
    }
  });

  it('produces ref-grammar effect keys for every operation', () => {
    for (const rail of railSimsV1) {
      for (const operation of rail.operations) {
        const key = rail.effectKeyFor(operation, requestFor(rail, 'effect-key'));
        expect(key).toMatch(/^[a-z0-9][a-z0-9:._/-]{0,199}$/);
      }
    }
  });
});
