import { RcmShadowError } from '../contracts.js';

/** The two systems that can own a financial event during a per-payer cutover. */
export type EraSystem = 'legacy' | 'native';

export interface EraCutover {
  readonly tenantId: string;
  readonly payerId: string;
  /** First service date owned by the native system (inclusive). */
  readonly cutoverOn: string;
  readonly legacySystem: string;
}

export interface EraRoutable {
  readonly tenantId: string;
  readonly payerId: string;
  readonly serviceDate: string;
  readonly arrivedVia: EraSystem;
}

export interface EraRoute {
  readonly owner: EraSystem;
  /** The event arrived through the system that does not own it. */
  readonly crossEra: boolean;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

function payerKey(tenantId: string, payerId: string): string {
  return `${tenantId}\u001f${payerId}`;
}

/**
 * WP-090 split-brain era registry (frozen). Each tenant and payer has one
 * cutover date, fixed at construction. An event belongs to the era of its
 * episode's service date, never to the rail it arrived on or the day it
 * arrived, so every cross-era event resolves to exactly one owning system.
 * A payer with no registered cutover fails closed.
 */
export class EraRegistry {
  // A true private field: unreachable from outside, so the registry cannot change after construction.
  readonly #cutovers: ReadonlyMap<string, EraCutover>;

  public constructor(entries: readonly EraCutover[]) {
    const cutovers = new Map<string, EraCutover>();
    for (const entry of entries) {
      if (
        !TOKEN.test(entry.tenantId) ||
        !TOKEN.test(entry.payerId) ||
        !TOKEN.test(entry.legacySystem)
      ) {
        throw new RcmShadowError(
          'ERA_INVALID',
          'tenantId, payerId and legacySystem must be tokens',
        );
      }
      if (!DAY.test(entry.cutoverOn)) {
        throw new RcmShadowError('ERA_INVALID', 'cutoverOn must be YYYY-MM-DD');
      }
      const id = payerKey(entry.tenantId, entry.payerId);
      if (cutovers.has(id)) {
        throw new RcmShadowError('ERA_DUPLICATE', 'a payer has exactly one cutover');
      }
      cutovers.set(id, Object.freeze({ ...entry }));
    }
    this.#cutovers = cutovers;
    Object.freeze(this);
  }

  public cutover(tenantId: string, payerId: string): EraCutover {
    const entry = this.#cutovers.get(payerKey(tenantId, payerId));
    if (!entry) {
      throw new RcmShadowError('ERA_UNREGISTERED', 'payer has no registered era cutover');
    }
    return entry;
  }

  public route(event: EraRoutable): EraRoute {
    if (!DAY.test(event.serviceDate)) {
      throw new RcmShadowError('ERA_INVALID', 'serviceDate must be YYYY-MM-DD');
    }
    const owner: EraSystem =
      event.serviceDate >= this.cutover(event.tenantId, event.payerId).cutoverOn
        ? 'native'
        : 'legacy';
    return { owner, crossEra: owner !== event.arrivedVia };
  }

  /** A copy of the frozen entries; changing the returned array changes nothing here. */
  public entries(): readonly EraCutover[] {
    return [...this.#cutovers.values()];
  }
}
