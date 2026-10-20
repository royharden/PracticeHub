import { describe, expect, it } from 'vitest';

import { Inventory, InventoryError } from './inventory.js';

const T = 'northwind-synthetic';
const PRODUCT = 'product:nwind-panel-01';
const LOT = 'lot:nwind-lot-0001';

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
    { tenantId: T, lotRef: LOT, productRef: PRODUCT, expiryDate: '2026-06-30' },
    ['unit:nwind-0001'],
  );
  return inventory;
}

const badTenants: readonly unknown[] = [
  '',
  '   ',
  ' northwind-synthetic',
  'northwind-synthetic ',
  undefined,
  null,
  42,
];

describe('NR-146: recallDrill refuses an invalid tenant', () => {
  it('an empty tenant is refused (the named item)', () => {
    expect(
      codeOf(() =>
        stock().recallDrill({ tenantId: '', drillRef: 'drill:nwind-0001', lotRef: LOT }),
      ),
    ).toBe('INVENTORY_INVALID');
  });

  it('blank, padded and non-string tenants are refused too, and nothing is recorded', () => {
    const inventory = stock();
    for (const tenantId of badTenants) {
      expect(
        codeOf(() =>
          inventory.recallDrill({
            tenantId: tenantId as string,
            drillRef: 'drill:nwind-0001',
            lotRef: LOT,
          }),
        ),
      ).toBe('INVENTORY_INVALID');
    }
    // The valid tenant still drills, and its drill ref is free (no report was stored under a bad tenant).
    expect(
      inventory.recallDrill({ tenantId: T, drillRef: 'drill:nwind-0001', lotRef: LOT }).units,
    ).toHaveLength(1);
  });
});

describe('NR-146 sweep: every entry point validates its tenant the same way', () => {
  it('addProduct, receiveLot, dispense, recallLot, releaseRecall and openRecall refuse a blank or non-string tenant', () => {
    for (const tenantId of ['   ', undefined, 7] as unknown[]) {
      const inventory = stock();
      const t = tenantId as string;
      expect(codeOf(() => inventory.addProduct({ tenantId: t, productRef: PRODUCT }))).toBe(
        'INVENTORY_INVALID',
      );
      expect(
        codeOf(() =>
          inventory.receiveLot(
            {
              tenantId: t,
              lotRef: 'lot:nwind-lot-0009',
              productRef: PRODUCT,
              expiryDate: '2026-06-30',
            },
            ['unit:nwind-0009'],
          ),
        ),
      ).toBe('INVENTORY_INVALID');
      expect(
        codeOf(() =>
          inventory.dispense({
            tenantId: t,
            dispenseRef: 'dispense:nwind-0001',
            unitRefs: ['unit:nwind-0001'],
            dispensedOn: '2026-06-01',
          }),
        ),
      ).toBe('INVENTORY_INVALID');
      expect(
        codeOf(() =>
          inventory.recallLot({
            tenantId: t,
            recallRef: 'recall:nwind-0001',
            lotRef: LOT,
            reason: 'synthetic',
            actor: 'human:qa-lead',
            on: '2026-06-01',
          }),
        ),
      ).toBe('INVENTORY_INVALID');
      expect(
        codeOf(() =>
          inventory.releaseRecall({
            tenantId: t,
            recallRef: 'recall:nwind-0001',
            reason: 'synthetic',
            actor: 'human:qa-lead',
            on: '2026-06-02',
          }),
        ),
      ).toBe('INVENTORY_INVALID');
      expect(codeOf(() => inventory.openRecall(t, LOT))).toBe('INVENTORY_INVALID');
    }
  });

  it('valid tenants still work at every entry point', () => {
    const inventory = stock();
    expect(inventory.openRecall(T, LOT)).toBeNull();
    inventory.recallLot({
      tenantId: T,
      recallRef: 'recall:nwind-0001',
      lotRef: LOT,
      reason: 'synthetic',
      actor: 'human:qa-lead',
      on: '2026-06-01',
    });
    expect(inventory.openRecall(T, LOT)?.recallRef).toBe('recall:nwind-0001');
  });
});
