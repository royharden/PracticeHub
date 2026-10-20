import { describe, expect, it } from 'vitest';

import { Inventory, InventoryError } from './inventory.js';

const T = 'northwind-synthetic';
const PRODUCT = 'product:nwind-panel-01';

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof InventoryError ? error.code : 'NOT_INVENTORY_ERROR';
  }
}

function stock(): Inventory {
  const inventory = new Inventory();
  inventory.addProduct({ tenantId: T, productRef: PRODUCT });
  inventory.receiveLot(
    { tenantId: T, lotRef: 'lot:nwind-lot-0001', productRef: PRODUCT, expiryDate: '2026-06-30' },
    ['unit:nwind-0001', 'unit:nwind-0002', 'unit:nwind-0003'],
  );
  return inventory;
}

describe('WP-075 rework F1: receiveLot is atomic', () => {
  it('a receive refused on a colliding unit leaves no new lot, no new unit and the original drill unchanged', () => {
    const inventory = stock();
    const before = inventory.recallDrill({
      tenantId: T,
      drillRef: 'drill:nwind-before',
      lotRef: 'lot:nwind-lot-0001',
    });
    expect(
      codeOf(() =>
        inventory.receiveLot(
          {
            tenantId: T,
            lotRef: 'lot:nwind-lot-0002',
            productRef: PRODUCT,
            expiryDate: '2026-12-31',
          },
          ['unit:nwind-0009', 'unit:nwind-0001'],
        ),
      ),
    ).toBe('INVENTORY_INVALID');
    expect(
      codeOf(() =>
        inventory.recallDrill({
          tenantId: T,
          drillRef: 'drill:nwind-0002',
          lotRef: 'lot:nwind-lot-0002',
        }),
      ),
    ).toBe('LOT_UNKNOWN');
    expect(
      codeOf(() =>
        inventory.dispense({
          tenantId: T,
          dispenseRef: 'dispense:nwind-0009',
          unitRefs: ['unit:nwind-0009'],
          dispensedOn: '2026-06-01',
        }),
      ),
    ).toBe('UNIT_UNKNOWN');
    expect(
      inventory.recallDrill({
        tenantId: T,
        drillRef: 'drill:nwind-after',
        lotRef: 'lot:nwind-lot-0001',
      }).units,
    ).toEqual(before.units);
  });

  it('a refused top-up of an existing lot does not mutate that lot', () => {
    const inventory = stock();
    expect(
      codeOf(() =>
        inventory.receiveLot(
          {
            tenantId: T,
            lotRef: 'lot:nwind-lot-0001',
            productRef: PRODUCT,
            expiryDate: '2026-06-30',
          },
          ['unit:nwind-0004', 'unit:nwind-0002'],
        ),
      ),
    ).toBe('INVENTORY_INVALID');
    const drill = inventory.recallDrill({
      tenantId: T,
      drillRef: 'drill:nwind-0001',
      lotRef: 'lot:nwind-lot-0001',
    });
    expect(drill.units.map((unit) => unit.unitRef)).toEqual([
      'unit:nwind-0001',
      'unit:nwind-0002',
      'unit:nwind-0003',
    ]);
    // A clean top-up still works and appears on a new drill.
    inventory.receiveLot(
      { tenantId: T, lotRef: 'lot:nwind-lot-0001', productRef: PRODUCT, expiryDate: '2026-06-30' },
      ['unit:nwind-0004'],
    );
    expect(
      inventory
        .recallDrill({ tenantId: T, drillRef: 'drill:nwind-0002', lotRef: 'lot:nwind-lot-0001' })
        .units.map((unit) => unit.unitRef),
    ).toEqual(['unit:nwind-0001', 'unit:nwind-0002', 'unit:nwind-0003', 'unit:nwind-0004']);
  });

  it('a receive with an unknown product or a changed expiry writes nothing', () => {
    const inventory = stock();
    expect(
      codeOf(() =>
        inventory.receiveLot(
          {
            tenantId: T,
            lotRef: 'lot:nwind-lot-0003',
            productRef: 'product:nwind-unknown-1',
            expiryDate: '2026-06-30',
          },
          ['unit:nwind-0006'],
        ),
      ),
    ).toBe('PRODUCT_UNKNOWN');
    expect(
      codeOf(() =>
        inventory.recallDrill({
          tenantId: T,
          drillRef: 'drill:nwind-0003',
          lotRef: 'lot:nwind-lot-0003',
        }),
      ),
    ).toBe('LOT_UNKNOWN');
    expect(
      codeOf(() =>
        inventory.receiveLot(
          {
            tenantId: T,
            lotRef: 'lot:nwind-lot-0001',
            productRef: PRODUCT,
            expiryDate: '2027-01-01',
          },
          ['unit:nwind-0005'],
        ),
      ),
    ).toBe('INVENTORY_INVALID');
    expect(
      codeOf(() =>
        inventory.dispense({
          tenantId: T,
          dispenseRef: 'dispense:nwind-0005',
          unitRefs: ['unit:nwind-0005'],
          dispensedOn: '2026-06-01',
        }),
      ),
    ).toBe('UNIT_UNKNOWN');
  });
});

describe('WP-075 rework F2: a recall contains the lot', () => {
  it('blocks every undispensed unit of a recalled lot, keeps dispensed ones on the drill, and releases only by a named human', () => {
    const inventory = stock();
    inventory.dispense({
      tenantId: T,
      dispenseRef: 'dispense:nwind-0001',
      unitRefs: ['unit:nwind-0001'],
      dispensedOn: '2026-06-01',
    });
    const recall = inventory.recallLot({
      tenantId: T,
      recallRef: 'recall:nwind-0001',
      lotRef: 'lot:nwind-lot-0001',
      reason: 'manufacturer notice (synthetic)',
      actor: 'system:mfr-notice',
      on: '2026-06-02',
    });
    expect(recall.releasedOn).toBeNull();
    expect(inventory.openRecall(T, 'lot:nwind-lot-0001')?.recallRef).toBe('recall:nwind-0001');
    expect(
      codeOf(() =>
        inventory.dispense({
          tenantId: T,
          dispenseRef: 'dispense:nwind-0002',
          unitRefs: ['unit:nwind-0002'],
          dispensedOn: '2026-06-03',
        }),
      ),
    ).toBe('LOT_RECALLED');
    expect(
      codeOf(() =>
        inventory.receiveLot(
          {
            tenantId: T,
            lotRef: 'lot:nwind-lot-0001',
            productRef: PRODUCT,
            expiryDate: '2026-06-30',
          },
          ['unit:nwind-0004'],
        ),
      ),
    ).toBe('LOT_RECALLED');
    const drill = inventory.recallDrill({
      tenantId: T,
      drillRef: 'drill:nwind-0001',
      lotRef: 'lot:nwind-lot-0001',
    });
    expect(drill.units.map((unit) => `${unit.unitRef}:${unit.dispenseRef ?? '-'}`)).toEqual([
      'unit:nwind-0001:dispense:nwind-0001',
      'unit:nwind-0002:-',
      'unit:nwind-0003:-',
    ]);

    expect(
      codeOf(() =>
        inventory.releaseRecall({
          tenantId: T,
          recallRef: 'recall:nwind-0001',
          reason: 'cleared',
          actor: 'system:auto',
          on: '2026-06-04',
        }),
      ),
    ).toBe('RELEASE_REQUIRES_HUMAN');
    expect(
      codeOf(() =>
        inventory.releaseRecall({
          tenantId: T,
          recallRef: 'recall:nwind-0001',
          reason: 'cleared',
          actor: 'agent:rcm-bot',
          on: '2026-06-04',
        }),
      ),
    ).toBe('RELEASE_REQUIRES_HUMAN');
    expect(inventory.openRecall(T, 'lot:nwind-lot-0001')).not.toBeNull();

    const released = inventory.releaseRecall({
      tenantId: T,
      recallRef: 'recall:nwind-0001',
      reason: 'manufacturer withdrew notice (synthetic)',
      actor: 'human:noor-pm',
      on: '2026-06-05',
    });
    expect(released).toMatchObject({ releasedBy: 'human:noor-pm', releasedOn: '2026-06-05' });
    expect(inventory.openRecall(T, 'lot:nwind-lot-0001')).toBeNull();
    expect(
      inventory.dispense({
        tenantId: T,
        dispenseRef: 'dispense:nwind-0002',
        unitRefs: ['unit:nwind-0002'],
        dispensedOn: '2026-06-06',
      }),
    ).toEqual(['unit:nwind-0002']);
  });

  it('a multi-unit dispense touching a recalled lot ties nothing', () => {
    const inventory = stock();
    inventory.receiveLot(
      { tenantId: T, lotRef: 'lot:nwind-lot-0002', productRef: PRODUCT, expiryDate: '2026-12-31' },
      ['unit:nwind-0021'],
    );
    inventory.recallLot({
      tenantId: T,
      recallRef: 'recall:nwind-0002',
      lotRef: 'lot:nwind-lot-0002',
      reason: 'x',
      actor: 'human:noor-pm',
      on: '2026-06-01',
    });
    expect(
      codeOf(() =>
        inventory.dispense({
          tenantId: T,
          dispenseRef: 'dispense:nwind-0021',
          unitRefs: ['unit:nwind-0001', 'unit:nwind-0021'],
          dispensedOn: '2026-06-02',
        }),
      ),
    ).toBe('LOT_RECALLED');
    expect(
      inventory
        .recallDrill({ tenantId: T, drillRef: 'drill:nwind-0001', lotRef: 'lot:nwind-lot-0001' })
        .units.every((unit) => unit.dispenseRef === null),
    ).toBe(true);
  });

  it('refuses a second open recall, a reused recall ref, an unknown lot or recall, bad input and a release before the recall', () => {
    const inventory = stock();
    const base = {
      tenantId: T,
      lotRef: 'lot:nwind-lot-0001',
      reason: 'x',
      actor: 'human:noor-pm',
      on: '2026-06-02',
    };
    inventory.recallLot({ ...base, recallRef: 'recall:nwind-0001' });
    expect(codeOf(() => inventory.recallLot({ ...base, recallRef: 'recall:nwind-0002' }))).toBe(
      'RECALL_CONFLICT',
    );
    expect(
      codeOf(() =>
        inventory.recallLot({
          ...base,
          recallRef: 'recall:nwind-0003',
          lotRef: 'lot:nwind-lot-9999',
        }),
      ),
    ).toBe('LOT_UNKNOWN');
    expect(
      codeOf(() => inventory.recallLot({ ...base, recallRef: 'recall:nwind-0004', reason: ' ' })),
    ).toBe('INVENTORY_INVALID');
    expect(
      codeOf(() => inventory.recallLot({ ...base, recallRef: 'recall:nwind-0004', actor: 'noor' })),
    ).toBe('INVENTORY_INVALID');
    expect(
      codeOf(() =>
        inventory.releaseRecall({
          tenantId: T,
          recallRef: 'recall:nwind-0009',
          reason: 'x',
          actor: 'human:noor-pm',
          on: '2026-06-03',
        }),
      ),
    ).toBe('RECALL_UNKNOWN');
    expect(
      codeOf(() =>
        inventory.releaseRecall({
          tenantId: T,
          recallRef: 'recall:nwind-0001',
          reason: 'x',
          actor: 'human:noor-pm',
          on: '2026-06-01',
        }),
      ),
    ).toBe('INVENTORY_INVALID');
    inventory.releaseRecall({
      tenantId: T,
      recallRef: 'recall:nwind-0001',
      reason: 'x',
      actor: 'human:noor-pm',
      on: '2026-06-03',
    });
    expect(
      codeOf(() =>
        inventory.releaseRecall({
          tenantId: T,
          recallRef: 'recall:nwind-0001',
          reason: 'x',
          actor: 'human:noor-pm',
          on: '2026-06-04',
        }),
      ),
    ).toBe('RECALL_CONFLICT');
    expect(
      codeOf(() =>
        inventory.recallLot({ ...base, recallRef: 'recall:nwind-0001', on: '2026-06-05' }),
      ),
    ).toBe('RECALL_CONFLICT');
    expect(
      inventory.recallLot({ ...base, recallRef: 'recall:nwind-0005', on: '2026-06-05' }).recallRef,
    ).toBe('recall:nwind-0005');
  });

  it('a recall in one tenant does not touch another tenant', () => {
    const inventory = stock();
    inventory.addProduct({ tenantId: 'other-synthetic', productRef: PRODUCT });
    inventory.receiveLot(
      {
        tenantId: 'other-synthetic',
        lotRef: 'lot:nwind-lot-0001',
        productRef: PRODUCT,
        expiryDate: '2026-06-30',
      },
      ['unit:nwind-0001'],
    );
    inventory.recallLot({
      tenantId: T,
      recallRef: 'recall:nwind-0001',
      lotRef: 'lot:nwind-lot-0001',
      reason: 'x',
      actor: 'human:noor-pm',
      on: '2026-06-01',
    });
    expect(inventory.openRecall('other-synthetic', 'lot:nwind-lot-0001')).toBeNull();
    expect(
      inventory.dispense({
        tenantId: 'other-synthetic',
        dispenseRef: 'dispense:nwind-0001',
        unitRefs: ['unit:nwind-0001'],
        dispensedOn: '2026-06-02',
      }),
    ).toEqual(['unit:nwind-0001']);
  });
});

describe('WP-075 rework F4: a drill ref is a point-in-time snapshot', () => {
  it('replays the same snapshot while nothing changed, and refuses the ref once the lot has moved on', () => {
    const inventory = stock();
    const first = inventory.recallDrill({
      tenantId: T,
      drillRef: 'drill:nwind-0001',
      lotRef: 'lot:nwind-lot-0001',
    });
    expect(
      inventory.recallDrill({
        tenantId: T,
        drillRef: 'drill:nwind-0001',
        lotRef: 'lot:nwind-lot-0001',
      }),
    ).toEqual(first);
    inventory.dispense({
      tenantId: T,
      dispenseRef: 'dispense:nwind-0001',
      unitRefs: ['unit:nwind-0001'],
      dispensedOn: '2026-06-01',
    });
    expect(
      codeOf(() =>
        inventory.recallDrill({
          tenantId: T,
          drillRef: 'drill:nwind-0001',
          lotRef: 'lot:nwind-lot-0001',
        }),
      ),
    ).toBe('DRILL_CONFLICT');
    expect(
      inventory.recallDrill({
        tenantId: T,
        drillRef: 'drill:nwind-0002',
        lotRef: 'lot:nwind-lot-0001',
      }).units[0]?.dispenseRef,
    ).toBe('dispense:nwind-0001');
  });
});

/** Deterministic PRNG (mulberry32) so the property runs are reproducible. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function day(offset: number): string {
  return new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000).toISOString().slice(0, 10);
}

describe('WP-075 rework F3: lot/expiry/recall properties (seeded)', () => {
  it('dispense succeeds exactly when every unit is unexpired, undispensed and not recalled; the drill always equals what was received', () => {
    const random = prng(75);
    for (let run = 0; run < 300; run += 1) {
      const inventory = new Inventory();
      inventory.addProduct({ tenantId: T, productRef: PRODUCT });
      const lots = 1 + Math.floor(random() * 3);
      const received = new Map<string, { expiry: string; units: string[] }>();
      const dispensedBy = new Map<string, string>();
      let unitSeq = 0;
      for (let lot = 0; lot < lots; lot += 1) {
        const lotRef = `lot:run${String(run).padStart(4, '0')}-${String(lot)}`;
        const expiry = day(Math.floor(random() * 120));
        const units = Array.from({ length: 1 + Math.floor(random() * 4) }, () => {
          unitSeq += 1;
          return `unit:run${String(run).padStart(4, '0')}-${String(unitSeq)}`;
        });
        inventory.receiveLot(
          { tenantId: T, lotRef, productRef: PRODUCT, expiryDate: expiry },
          units,
        );
        received.set(lotRef, { expiry, units });
        // A colliding receive (F1) must change nothing.
        expect(() =>
          inventory.receiveLot(
            { tenantId: T, lotRef: `${lotRef}-dup`, productRef: PRODUCT, expiryDate: expiry },
            [`${units[0] ?? ''}x`, units[0] ?? ''],
          ),
        ).toThrow(InventoryError);
      }
      const recalled = new Set<string>();
      for (const lotRef of received.keys()) {
        if (random() < 0.3) {
          inventory.recallLot({
            tenantId: T,
            recallRef: `recall:${lotRef.slice(4)}`,
            lotRef,
            reason: 'synthetic',
            actor: 'human:noor-pm',
            on: day(0),
          });
          recalled.add(lotRef);
        }
      }
      const allUnits = [...received.entries()].flatMap(([lotRef, lot]) =>
        lot.units.map((unit) => ({ unit, lotRef, expiry: lot.expiry })),
      );
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const picks = allUnits.filter(() => random() < 0.4);
        if (picks.length === 0) continue;
        const on = day(Math.floor(random() * 150));
        const dispenseRef = `dispense:run${String(run).padStart(4, '0')}-${String(attempt)}`;
        const expectOk = picks.every(
          (pick) => !dispensedBy.has(pick.unit) && !recalled.has(pick.lotRef) && on <= pick.expiry,
        );
        const outcome = codeOf(() =>
          inventory.dispense({
            tenantId: T,
            dispenseRef,
            unitRefs: picks.map((pick) => pick.unit),
            dispensedOn: on,
          }),
        );
        expect(outcome === null).toBe(expectOk);
        if (expectOk) {
          for (const pick of picks) dispensedBy.set(pick.unit, dispenseRef);
        }
      }
      for (const [lotRef, lot] of received) {
        const drill = inventory.recallDrill({
          tenantId: T,
          drillRef: `drill:${lotRef.slice(4)}`,
          lotRef,
        });
        expect(drill.units.map((unit) => unit.unitRef)).toEqual(
          [...lot.units].sort((a, b) => a.localeCompare(b)),
        );
        for (const unit of drill.units) {
          expect(unit.dispenseRef).toBe(dispensedBy.get(unit.unitRef) ?? null);
        }
      }
    }
  });
});
