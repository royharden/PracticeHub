import type { EntitlementCyclePort } from '../types.js';

export interface RecordedGrant {
  readonly tenantId: string;
  readonly memberRef: string;
  readonly vintageId: string;
  readonly componentRefs: readonly string[];
  readonly authorityJournalId: string;
  readonly reversed: boolean;
}

/** Versioned WP-031 entitlement double. Does not import membership-entitlements. */
export class Wp031EntitlementDoubleV1 implements EntitlementCyclePort {
  readonly #grants: RecordedGrant[] = [];

  public grantForVintage(input: {
    readonly tenantId: string;
    readonly memberRef: string;
    readonly vintageId: string;
    readonly componentRefs: readonly string[];
    readonly authorityJournalId: string;
  }): void {
    const index = this.#grants.findIndex(
      (grant) => grant.tenantId === input.tenantId && grant.vintageId === input.vintageId,
    );
    const prior = this.#grants[index];
    if (prior !== undefined) {
      if (
        prior.memberRef !== input.memberRef ||
        prior.authorityJournalId !== input.authorityJournalId ||
        prior.componentRefs.join('\0') !== input.componentRefs.join('\0')
      ) {
        throw new Error('ENTITLEMENT_DOUBLE_CONFLICT');
      }
      return;
    }
    this.#grants.push({ ...input, reversed: false });
  }

  public reverseForVintage(input: {
    readonly tenantId: string;
    readonly memberRef: string;
    readonly vintageId: string;
    readonly authorityJournalId: string;
  }): void {
    const index = this.#grants.findIndex(
      (grant) => grant.tenantId === input.tenantId && grant.vintageId === input.vintageId,
    );
    const prior = this.#grants[index];
    if (prior === undefined) throw new Error('ENTITLEMENT_DOUBLE_MISSING_GRANT');
    if (prior.memberRef !== input.memberRef) throw new Error('ENTITLEMENT_DOUBLE_MEMBER_MISMATCH');
    if (prior.reversed) return;
    this.#grants[index] = { ...prior, reversed: true };
    void input.authorityJournalId;
  }

  public snapshot(): readonly RecordedGrant[] {
    return this.#grants.map((grant) => ({ ...grant, componentRefs: [...grant.componentRefs] }));
  }
}
