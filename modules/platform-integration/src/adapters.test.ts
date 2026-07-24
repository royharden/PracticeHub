import { describe, expect, it } from 'vitest';

import {
  AdapterContractError,
  adapterContractRequiredFields,
  lateOutcomeRuleClasses,
  reconcileLateOutcome,
  validateAdapterContract,
  type AdapterContract,
  type LateOutcomeRuleClass,
} from './adapters.js';

function contract(overrides: Partial<AdapterContract> = {}): AdapterContract {
  return {
    adapterId: 'synthetic-adapter',
    authorityId: 'AUTH-006',
    direction: 'outbound',
    systemOfRecord: 'stripe',
    identityMatch: 'processor-customer-id',
    fieldClassificationCeiling: 'demographic',
    retryIdempotency: 'idempotency-key-per-intent',
    ordering: 'per-aggregate',
    reconciliation: 'nightly-gap-check',
    errorOwnership: 'payments-team',
    monitoring: 'webhook-lag',
    downtimeBehavior: 'queue-and-retry',
    exportFormat: 'balance-transaction-export',
    livenessProof: 'scheduled-tranche',
    lateOutcomeRuleClass: 'dedupe-idempotent',
    ...overrides,
  };
}

describe('validateAdapterContract (contract-presence)', () => {
  it('accepts a complete contract', () => {
    expect(validateAdapterContract(contract())).toEqual([]);
  });

  it('names every missing required field', () => {
    const problems = validateAdapterContract({ adapterId: 'x' });
    for (const field of adapterContractRequiredFields) {
      if (field === 'adapterId') {
        continue;
      }
      expect(problems).toContain(`missing ${String(field)}`);
    }
  });

  it('refuses a malformed authority id', () => {
    expect(validateAdapterContract(contract({ authorityId: 'stripe' }))).toContain(
      'authorityId "stripe" is not an AUTH-### id',
    );
  });

  it('refuses an unknown late-outcome class', () => {
    expect(
      validateAdapterContract(contract({ lateOutcomeRuleClass: 'made-up' as never })),
    ).toContain('lateOutcomeRuleClass "made-up" is not a known class');
  });

  it('refuses a blank required field', () => {
    expect(validateAdapterContract(contract({ systemOfRecord: '   ' }))).toContain(
      'missing systemOfRecord',
    );
  });
});

describe('reconcileLateOutcome (late-outcome scenario harness)', () => {
  const fences: readonly {
    readonly effectAlreadyPublished: boolean;
    readonly hasAuthoritativePriorVersion: boolean;
  }[] = [
    { effectAlreadyPublished: false, hasAuthoritativePriorVersion: false },
    { effectAlreadyPublished: true, hasAuthoritativePriorVersion: false },
    { effectAlreadyPublished: false, hasAuthoritativePriorVersion: true },
    { effectAlreadyPublished: true, hasAuthoritativePriorVersion: true },
  ];

  it('NEVER re-sends the external effect and NEVER overwrites authoritative truth, for every class x fence', () => {
    for (const ruleClass of lateOutcomeRuleClasses) {
      for (const fence of fences) {
        const disposition = reconcileLateOutcome({ ruleClass, ...fence });
        expect(disposition.resendsExternalEffect).toBe(false);
        expect(disposition.overwritesAuthoritativeTruth).toBe(false);
      }
    }
  });

  it('maps each rule class to a reconciliation action', () => {
    const expected: Readonly<Record<LateOutcomeRuleClass, string>> = {
      'reconcile-under-original-epoch': 'attach-and-reconcile',
      'quarantine-and-reconcile': 'quarantine-for-review',
      'open-review-never-overwrite': 'open-review',
      'revocation-tombstone-dominates': 'suppress-future',
      'dedupe-idempotent': 'attach-and-reconcile',
      'attach-to-frozen-attempt': 'attach-and-reconcile',
      'preserve-prior-version-reopen-review': 'open-review',
      'suppress-future-no-resubscribe': 'suppress-future',
      'stale-evidence-no-authority': 'discard-stale',
      'new-projection-version': 'supersede-new-version',
      'future-effective-pinned-edition': 'no-op',
    };
    for (const ruleClass of lateOutcomeRuleClasses) {
      expect(
        reconcileLateOutcome({
          ruleClass,
          effectAlreadyPublished: true,
          hasAuthoritativePriorVersion: true,
        }).action,
      ).toBe(expected[ruleClass]);
    }
  });

  it('throws on an unknown rule class', () => {
    expect(() =>
      reconcileLateOutcome({
        ruleClass: 'nope' as never,
        effectAlreadyPublished: false,
        hasAuthoritativePriorVersion: false,
      }),
    ).toThrow(AdapterContractError);
  });
});
