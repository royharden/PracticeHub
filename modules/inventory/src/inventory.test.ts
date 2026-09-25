import { describe, expect, it } from 'vitest';

import { Inventory, type InventoryError } from './inventory.js';

const stock = (): Inventory => {
  const inventory = new Inventory();
  inventory.addProduct({ tenantId: 'northwind-synthetic', productRef: 'product:nwind-panel-01' });
  inventory.receiveLot(
    {
      tenantId: 'northwind-synthetic',
      lotRef: 'lot:nwind-lot-0001',
      productRef: 'product:nwind-panel-01',
      expiryDate: '2026-06-30',
    },
    ['unit:nwind-0001', 'unit:nwind-0002', 'unit:nwind-0003'],
  );
  return inventory;
};

describe('WP-075 inventory lots', () => {
  it('dispenses on the expiry date and refuses the following day', () => {
    const inventory = stock();
    expect(
      inventory.dispense({
        tenantId: 'northwind-synthetic',
        dispenseRef: 'dispense:nwind-0001',
        unitRefs: ['unit:nwind-0001'],
        dispensedOn: '2026-06-30',
      }),
    ).toEqual(['unit:nwind-0001']);
    expect(() =>
      inventory.dispense({
        tenantId: 'northwind-synthetic',
        dispenseRef: 'dispense:nwind-0002',
        unitRefs: ['unit:nwind-0002'],
        dispensedOn: '2026-07-01',
      }),
    ).toThrow(expect.objectContaining({ code: 'LOT_EXPIRED' } satisfies Partial<InventoryError>));
    const drill = inventory.recallDrill({
      tenantId: 'northwind-synthetic',
      drillRef: 'drill:nwind-0001',
      lotRef: 'lot:nwind-lot-0001',
    });
    expect(drill.units.find((unit) => unit.unitRef === 'unit:nwind-0002')?.dispenseRef).toBeNull();
  });

  it('refuses a second dispense of the same unit', () => {
    const inventory = stock();
    inventory.dispense({
      tenantId: 'northwind-synthetic',
      dispenseRef: 'dispense:nwind-0001',
      unitRefs: ['unit:nwind-0001'],
      dispensedOn: '2026-06-01',
    });
    expect(() =>
      inventory.dispense({
        tenantId: 'northwind-synthetic',
        dispenseRef: 'dispense:nwind-0002',
        unitRefs: ['unit:nwind-0001'],
        dispensedOn: '2026-06-02',
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'UNIT_ALREADY_DISPENSED',
      } satisfies Partial<InventoryError>),
    );
  });

  it('recall drill returns every unit of the lot, including dispensed units', () => {
    const inventory = stock();
    inventory.dispense({
      tenantId: 'northwind-synthetic',
      dispenseRef: 'dispense:nwind-0001',
      unitRefs: ['unit:nwind-0001', 'unit:nwind-0003'],
      dispensedOn: '2026-06-15',
    });
    const drill = inventory.recallDrill({
      tenantId: 'northwind-synthetic',
      drillRef: 'drill:nwind-0001',
      lotRef: 'lot:nwind-lot-0001',
    });
    expect(drill.units).toEqual([
      {
        unitRef: 'unit:nwind-0001',
        dispenseRef: 'dispense:nwind-0001',
        dispensedOn: '2026-06-15',
      },
      { unitRef: 'unit:nwind-0002', dispenseRef: null, dispensedOn: null },
      {
        unitRef: 'unit:nwind-0003',
        dispenseRef: 'dispense:nwind-0001',
        dispensedOn: '2026-06-15',
      },
    ]);
  });
});
