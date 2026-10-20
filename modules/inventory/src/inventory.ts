const productRefPattern = /^product:[a-z0-9][a-z0-9-]{7,63}$/;
const lotRefPattern = /^lot:[a-z0-9][a-z0-9-]{7,63}$/;
const unitRefPattern = /^unit:[a-z0-9][a-z0-9-]{7,63}$/;
const dispenseRefPattern = /^dispense:[a-z0-9][a-z0-9-]{7,63}$/;
const drillRefPattern = /^drill:[a-z0-9][a-z0-9-]{7,63}$/;
const recallRefPattern = /^recall:[a-z0-9][a-z0-9-]{7,63}$/;
/** `<kind>:<name>`, for example `human:noor-pm` or `system:mfr-notice`. */
const actorPattern = /^[a-z][a-z0-9-]{1,31}:[a-z0-9][a-z0-9-]{1,63}$/;
const humanActorPattern = /^human:[a-z0-9][a-z0-9-]{1,63}$/;
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
      | 'DRILL_CONFLICT'
      | 'LOT_RECALLED'
      | 'RECALL_CONFLICT'
      | 'RECALL_UNKNOWN'
      | 'RELEASE_REQUIRES_HUMAN',
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

/** A point-in-time report. A drill ref is frozen: a later drill needs a new ref. */
export interface RecallDrill {
  readonly tenantId: string;
  readonly drillRef: string;
  readonly lotRef: string;
  readonly units: readonly RecallUnit[];
}

/** Containment of one lot. While `releasedOn` is null the lot's undispensed units cannot be dispensed. */
export interface LotRecall {
  readonly tenantId: string;
  readonly recallRef: string;
  readonly lotRef: string;
  readonly reason: string;
  readonly recalledBy: string;
  readonly recalledOn: string;
  readonly releasedBy: string | null;
  readonly releasedOn: string | null;
  readonly releaseReason: string | null;
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

/**
 * Tenant validation shared by every entry point (NR-146): a string token with no surrounding or
 * blank-only whitespace. An empty, blank or non-string tenant is refused everywhere.
 */
const tenantPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const validTenant = (tenantId: unknown): boolean =>
  typeof tenantId === 'string' && tenantPattern.test(tenantId);

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
  readonly #unitsByLot = new Map<string, readonly string[]>();
  readonly #dispensed = new Map<string, StoredDispense>();
  readonly #drills = new Map<string, RecallDrill>();
  readonly #recalls = new Map<string, LotRecall>();
  /** The open recall ref per lot key, if any. */
  readonly #openRecallByLot = new Map<string, string>();

  public addProduct(product: InventoryProduct): InventoryProduct {
    if (!validTenant(product.tenantId) || !productRefPattern.test(product.productRef)) {
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

  /**
   * Receives units into a lot. Every check runs before any write, so a refused receive leaves
   * no lot, no unit and no index change behind.
   */
  public receiveLot(lot: InventoryLot, unitRefs: readonly string[]): InventoryLot {
    assertDate(lot.expiryDate);
    if (
      !validTenant(lot.tenantId) ||
      !lotRefPattern.test(lot.lotRef) ||
      !productRefPattern.test(lot.productRef) ||
      unitRefs.length === 0 ||
      new Set(unitRefs).size !== unitRefs.length
    ) {
      throw new InventoryError('INVENTORY_INVALID');
    }
    for (const unitRef of unitRefs) {
      if (!unitRefPattern.test(unitRef)) throw new InventoryError('INVENTORY_INVALID');
      if (this.#units.has(JSON.stringify([lot.tenantId, unitRef]))) {
        throw new InventoryError('INVENTORY_INVALID');
      }
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
    if (this.#openRecallByLot.has(lotKey)) throw new InventoryError('LOT_RECALLED');

    this.#lots.set(lotKey, stored);
    for (const unitRef of unitRefs) {
      this.#units.set(
        JSON.stringify([lot.tenantId, unitRef]),
        Object.freeze({ tenantId: lot.tenantId, unitRef, lotRef: lot.lotRef }),
      );
    }
    this.#unitsByLot.set(
      lotKey,
      Object.freeze([...(this.#unitsByLot.get(lotKey) ?? []), ...unitRefs]),
    );
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
      !validTenant(input.tenantId) ||
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
      const lotKey = JSON.stringify([input.tenantId, unit.lotRef]);
      const lot = this.#lots.get(lotKey);
      if (lot === undefined) throw new InventoryError('LOT_UNKNOWN');
      if (this.#openRecallByLot.has(lotKey)) throw new InventoryError('LOT_RECALLED');
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

  /**
   * Opens a recall on a lot. From now until a named human releases it, no undispensed unit of
   * the lot can be dispensed and no unit can be received into it. Units already dispensed stay
   * tied, and the recall drill still lists them.
   */
  public recallLot(input: {
    readonly tenantId: string;
    readonly recallRef: string;
    readonly lotRef: string;
    readonly reason: string;
    readonly actor: string;
    readonly on: string;
  }): LotRecall {
    assertDate(input.on);
    if (
      !validTenant(input.tenantId) ||
      !recallRefPattern.test(input.recallRef) ||
      !lotRefPattern.test(input.lotRef) ||
      input.reason.trim() === '' ||
      !actorPattern.test(input.actor)
    ) {
      throw new InventoryError('INVENTORY_INVALID');
    }
    const lotKey = JSON.stringify([input.tenantId, input.lotRef]);
    if (!this.#lots.has(lotKey)) throw new InventoryError('LOT_UNKNOWN');
    const recallKey = JSON.stringify([input.tenantId, input.recallRef]);
    if (this.#recalls.has(recallKey) || this.#openRecallByLot.has(lotKey)) {
      throw new InventoryError('RECALL_CONFLICT');
    }
    const recall: LotRecall = Object.freeze({
      tenantId: input.tenantId,
      recallRef: input.recallRef,
      lotRef: input.lotRef,
      reason: input.reason,
      recalledBy: input.actor,
      recalledOn: input.on,
      releasedBy: null,
      releasedOn: null,
      releaseReason: null,
    });
    this.#recalls.set(recallKey, recall);
    this.#openRecallByLot.set(lotKey, input.recallRef);
    return recall;
  }

  /** Releases an open recall. Only a named human may release recalled stock (REQ-INV-001). */
  public releaseRecall(input: {
    readonly tenantId: string;
    readonly recallRef: string;
    readonly reason: string;
    readonly actor: string;
    readonly on: string;
  }): LotRecall {
    assertDate(input.on);
    if (
      !validTenant(input.tenantId) ||
      !recallRefPattern.test(input.recallRef) ||
      input.reason.trim() === ''
    ) {
      throw new InventoryError('INVENTORY_INVALID');
    }
    if (!humanActorPattern.test(input.actor)) throw new InventoryError('RELEASE_REQUIRES_HUMAN');
    const recallKey = JSON.stringify([input.tenantId, input.recallRef]);
    const recall = this.#recalls.get(recallKey);
    if (recall === undefined) throw new InventoryError('RECALL_UNKNOWN');
    if (recall.releasedOn !== null) throw new InventoryError('RECALL_CONFLICT');
    if (input.on < recall.recalledOn) throw new InventoryError('INVENTORY_INVALID');
    const released: LotRecall = Object.freeze({
      ...recall,
      releasedBy: input.actor,
      releasedOn: input.on,
      releaseReason: input.reason,
    });
    this.#recalls.set(recallKey, released);
    this.#openRecallByLot.delete(JSON.stringify([input.tenantId, recall.lotRef]));
    return released;
  }

  /** The open recall on a lot, or null. */
  public openRecall(tenantId: string, lotRef: string): LotRecall | null {
    if (!validTenant(tenantId)) throw new InventoryError('INVENTORY_INVALID');
    const lotKey = JSON.stringify([tenantId, lotRef]);
    const recallRef = this.#openRecallByLot.get(lotKey);
    return recallRef === undefined
      ? null
      : (this.#recalls.get(JSON.stringify([tenantId, recallRef])) ?? null);
  }

  public recallDrill(input: {
    readonly tenantId: string;
    readonly drillRef: string;
    readonly lotRef: string;
  }): RecallDrill {
    if (
      !validTenant(input.tenantId) ||
      !drillRefPattern.test(input.drillRef) ||
      !lotRefPattern.test(input.lotRef)
    ) {
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
