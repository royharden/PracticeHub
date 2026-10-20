import { CrmError, type DerivedFlag } from './crm.js';
import type { IdentityReadPort } from './ports.js';

/** Membership value fact (WP-052 placeholder input): what a derived flag is computed from. */
export interface MembershipValueFact {
  readonly tenantId: string;
  readonly personId: string;
  readonly lifetimeValueMinor: number;
}

export interface StoredDerivedFlag extends DerivedFlag {
  readonly tenantId: string;
  readonly computedFrom: 'membership-lifetime-value';
  readonly thresholdMinor: number;
}

/**
 * CRM-owned projection of derived flags, keyed by (tenant, person). It reads
 * identity only through `IdentityReadPort`, which has no write method, so a
 * derived flag can never be written back onto the identity aggregate.
 */
export class DerivedFlagProjection {
  readonly #flags = new Map<string, StoredDerivedFlag>();

  public constructor(
    private readonly identity: IdentityReadPort,
    private readonly highValueThresholdMinor: number,
  ) {
    if (!Number.isSafeInteger(highValueThresholdMinor) || highValueThresholdMinor <= 0) {
      throw new CrmError('CRM_FLAG', 'high-value threshold must be a positive safe integer');
    }
  }

  public project(fact: MembershipValueFact): StoredDerivedFlag | null {
    if (!Number.isSafeInteger(fact.lifetimeValueMinor) || fact.lifetimeValueMinor < 0) {
      throw new CrmError('CRM_FLAG', 'lifetime value must be a non-negative safe integer');
    }
    if (this.identity.read(fact.tenantId, fact.personId) === undefined) {
      throw new CrmError(
        'CRM_FLAG',
        `person ${fact.personId} is not an identity in tenant ${fact.tenantId}`,
      );
    }
    const key = `${fact.tenantId}|${fact.personId}`;
    if (fact.lifetimeValueMinor < this.highValueThresholdMinor) {
      this.#flags.delete(key);
      return null;
    }
    const flag: StoredDerivedFlag = {
      tenantId: fact.tenantId,
      personId: fact.personId,
      name: 'high-value',
      value: true,
      computedFrom: 'membership-lifetime-value',
      thresholdMinor: this.highValueThresholdMinor,
    };
    this.#flags.set(key, flag);
    return flag;
  }

  public get(tenantId: string, personId: string): StoredDerivedFlag | undefined {
    return this.#flags.get(`${tenantId}|${personId}`);
  }
}
