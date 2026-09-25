const productRefPattern = /^product:[a-z0-9][a-z0-9-]{7,63}$/;
const lotRefPattern = /^lot:[a-z0-9][a-z0-9-]{7,63}$/;
const unitRefPattern = /^unit:[a-z0-9][a-z0-9-]{7,63}$/;
const dispenseRefPattern = /^dispense:[a-z0-9][a-z0-9-]{7,63}$/;
const drillRefPattern = /^drill:[a-z0-9][a-z0-9-]{7,63}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export class InventoryError extends Error {
  public constructor(
    public readonly code:
      | 'INVENTORY_INVALID'
      | 'PRODUCT_UNKNOWN'
      | 'LOT_UNKNOWN'
      | 'UNIT_UNKNOWN'
      | 'UNIT_ALREADY_DISPENSED'
      | 'LOT_EXPIRED'
      | 'DRILL_CONFLICT',
  ) {
    super(code);
    this.name = 'InventoryError';
  }
}

export interface InventoryProduct {
  readonly tenantId: string;
  readonly productRef: string;
}

export interface InventoryLot {
  readonly tenantId: string;
  readonly lotRef: string;
  readonly productRef: string;
  readonly expiryDate: string;
}

export interface RecallUnit {
  readonly unitRef: string;
  readonly dispenseRef: string | null;
  readonly dispensedOn: string | null;
}

export interface RecallDrill {
  readonly tenantId: string;
  readonly drillRef: string;
  readonly lotRef: string;
  readonly units: readonly RecallUnit[];
}

interface StoredUnit {
  readonly tenantId: string;
  readonly unitRef: string;
  readonly lotRef: string;
}

interface StoredDispense {
  readonly dispenseRef: string;
  readonly dispensedOn: string;
}

const assertDate = (value: string): void => {
  if (!datePattern.test(value)) throw new InventoryError('INVENTORY_INVALID');
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new InventoryError('INVENTORY_INVALID');
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new InventoryError('INVENTORY_INVALID');
  }
};

export class Inventory {
  readonly #products = new Map<string, InventoryProduct>();
  readonly #lots = new Map<string, InventoryLot>();
  readonly #units = new Map<string, StoredUnit>();
  readonly #unitsByLot = new Map<string, string[]>();
  readonly #dispensed = new Map<string, StoredDispense>();
  readonly #drills = new Map<string, RecallDrill>();

  public addProduct(product: InventoryProduct): InventoryProduct {
    if (product.tenantId === '' || !productRefPattern.test(product.productRef)) {
      throw new InventoryError('INVENTORY_INVALID');
    }
    const key = JSON.stringify([product.tenantId, product.productRef]);
    const stored = Object.freeze({ ...product });
    const prior = this.#products.get(key);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(stored)) {
      throw new InventoryError('INVENTORY_INVALID');
    }
    this.#products.set(key, stored);
    return stored;
  }

  public receiveLot(lot: InventoryLot, unitRefs: readonly string[]): InventoryLot {
    assertDate(lot.expiryDate);
    if (
      lot.tenantId === '' ||
      !lotRefPattern.test(lot.lotRef) ||
      !productRefPattern.test(lot.productRef) ||
      unitRefs.length === 0 ||
      new Set(unitRefs).size !== unitRefs.length
    ) {
      throw new InventoryError('INVENTORY_INVALID');
    }
    for (const unitRef of unitRefs) {
      if (!unitRefPattern.test(unitRef)) throw new InventoryError('INVENTORY_INVALID');
    }
    if (!this.#products.has(JSON.stringify([lot.tenantId, lot.productRef]))) {
      throw new InventoryError('PRODUCT_UNKNOWN');
    }
    const lotKey = JSON.stringify([lot.tenantId, lot.lotRef]);
    const stored = Object.freeze({ ...lot });
    const prior = this.#lots.get(lotKey);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(stored)) {
      throw new InventoryError('INVENTORY_INVALID');
    }
    this.#lots.set(lotKey, stored);
    const existing = this.#unitsByLot.get(lotKey) ?? [];
    for (const unitRef of unitRefs) {
      const unitKey = JSON.stringify([lot.tenantId, unitRef]);
      if (this.#units.has(unitKey)) throw new InventoryError('INVENTORY_INVALID');
      this.#units.set(
        unitKey,
        Object.freeze({ tenantId: lot.tenantId, unitRef, lotRef: lot.lotRef }),
      );
      existing.push(unitRef);
    }
    this.#unitsByLot.set(lotKey, existing);
    return stored;
  }

  public dispense(input: {
    readonly tenantId: string;
    readonly dispenseRef: string;
    readonly unitRefs: readonly string[];
    readonly dispensedOn: string;
  }): readonly string[] {
    assertDate(input.dispensedOn);
    if (
      input.tenantId === '' ||
      !dispenseRefPattern.test(input.dispenseRef) ||
      input.unitRefs.length === 0 ||
      new Set(input.unitRefs).size !== input.unitRefs.length
    ) {
      throw new InventoryError('INVENTORY_INVALID');
    }
    const resolved: StoredUnit[] = [];
    for (const unitRef of input.unitRefs) {
      const unit = this.#units.get(JSON.stringify([input.tenantId, unitRef]));
      if (unit === undefined) throw new InventoryError('UNIT_UNKNOWN');
      if (this.#dispensed.has(JSON.stringify([input.tenantId, unitRef]))) {
        throw new InventoryError('UNIT_ALREADY_DISPENSED');
      }
      const lot = this.#lots.get(JSON.stringify([input.tenantId, unit.lotRef]));
      if (lot === undefined) throw new InventoryError('LOT_UNKNOWN');
      if (input.dispensedOn > lot.expiryDate) throw new InventoryError('LOT_EXPIRED');
      resolved.push(unit);
    }
    for (const unit of resolved) {
      this.#dispensed.set(
        JSON.stringify([input.tenantId, unit.unitRef]),
        Object.freeze({ dispenseRef: input.dispenseRef, dispensedOn: input.dispensedOn }),
      );
    }
    return Object.freeze(resolved.map((unit) => unit.unitRef));
  }

  public recallDrill(input: {
    readonly tenantId: string;
    readonly drillRef: string;
    readonly lotRef: string;
  }): RecallDrill {
    if (!drillRefPattern.test(input.drillRef) || !lotRefPattern.test(input.lotRef)) {
      throw new InventoryError('INVENTORY_INVALID');
    }
    const lotKey = JSON.stringify([input.tenantId, input.lotRef]);
    if (!this.#lots.has(lotKey)) throw new InventoryError('LOT_UNKNOWN');
    const units = Object.freeze(
      [...(this.#unitsByLot.get(lotKey) ?? [])]
        .sort((left, right) => left.localeCompare(right))
        .map((unitRef) => {
          const tie = this.#dispensed.get(JSON.stringify([input.tenantId, unitRef]));
          return Object.freeze({
            unitRef,
            dispenseRef: tie === undefined ? null : tie.dispenseRef,
            dispensedOn: tie === undefined ? null : tie.dispensedOn,
          });
        }),
    );
    const report = Object.freeze({
      tenantId: input.tenantId,
      drillRef: input.drillRef,
      lotRef: input.lotRef,
      units,
    });
    const drillKey = JSON.stringify([input.tenantId, input.drillRef]);
    const prior = this.#drills.get(drillKey);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(report)) {
      throw new InventoryError('DRILL_CONFLICT');
    }
    this.#drills.set(drillKey, report);
    return report;
  }
}
