/**
 * Adapter framework (WP-026, M07). Architecture: ADR-014 Decision 1 (every
 * adapter declares the CDX integration-contract minimum; vendor SDK types never
 * escape the adapter; egress passes the vendor-BAA guard). Contract:
 * docs/contracts/adapter-registry-api.md (FROZEN).
 *
 * This module owns the PUBLIC, generic pieces of the framework:
 *   - `AdapterContract` — the frozen integration-contract-minimum shape every
 *     external adapter declares, plus its authority-rail JOIN key (`authorityId`);
 *   - `validateAdapterContract` — the contract-presence check (an adapter that
 *     declares a contract must declare a COMPLETE one);
 *   - `reconcileLateOutcome` — the executable late-outcome harness that encodes
 *     the universal rail invariant a late external outcome must obey (no
 *     duplicate external send; never overwrite authoritative/signed truth).
 *
 * The authority-rail JOIN itself (docs/architecture/authority-rail-join.csv:
 * rail ids, effect-key contract, simulator scenarios, late-outcome rule prose,
 * activation evidence) is the private source of truth. An adapter references it
 * ONLY by its neutral `authorityId`; the `verify:adapters` gate cross-checks the
 * declaration against that private join and enforces its freeze.
 */

import type { PhiClass } from '@practicehub/contracts';

export const adapterDirections = ['inbound', 'outbound', 'bidirectional'] as const;
export type AdapterDirection = (typeof adapterDirections)[number];

/**
 * The reconciliation posture a late external outcome must follow. A generalized
 * (public) vocabulary — the concrete per-rail prose lives in the private join's
 * `late_outcome_rule` column; each rail maps to exactly one of these classes.
 */
export const lateOutcomeRuleClasses = [
  'reconcile-under-original-epoch',
  'quarantine-and-reconcile',
  'open-review-never-overwrite',
  'revocation-tombstone-dominates',
  'dedupe-idempotent',
  'attach-to-frozen-attempt',
  'preserve-prior-version-reopen-review',
  'suppress-future-no-resubscribe',
  'stale-evidence-no-authority',
  'new-projection-version',
  'future-effective-pinned-edition',
] as const;
export type LateOutcomeRuleClass = (typeof lateOutcomeRuleClasses)[number];

/**
 * The CDX integration-contract minimum (ADR-014 Decision 1). Every field is
 * required — `validateAdapterContract` refuses a partial declaration, so an
 * adapter cannot ship a half-specified contract (contract-presence).
 */
export interface AdapterContract {
  readonly adapterId: string;
  /** Authority-rail JOIN key — the neutral `AUTH-###` id in the private join. */
  readonly authorityId: string;
  readonly direction: AdapterDirection;
  readonly systemOfRecord: string;
  readonly identityMatch: string;
  /** Highest PHI class the adapter's payloads may carry (the egress-guard input). */
  readonly fieldClassificationCeiling: PhiClass;
  readonly retryIdempotency: string;
  readonly ordering: string;
  readonly reconciliation: string;
  readonly errorOwnership: string;
  readonly monitoring: string;
  readonly downtimeBehavior: string;
  readonly exportFormat: string;
  readonly livenessProof: string;
  readonly lateOutcomeRuleClass: LateOutcomeRuleClass;
}

/** The field names a complete AdapterContract must carry (contract-presence). */
export const adapterContractRequiredFields: readonly (keyof AdapterContract)[] = [
  'adapterId',
  'authorityId',
  'direction',
  'systemOfRecord',
  'identityMatch',
  'fieldClassificationCeiling',
  'retryIdempotency',
  'ordering',
  'reconciliation',
  'errorOwnership',
  'monitoring',
  'downtimeBehavior',
  'exportFormat',
  'livenessProof',
  'lateOutcomeRuleClass',
];

/** The columns the frozen authority-rail join (private CSV) must carry. */
export const authorityRailJoinColumns: readonly string[] = [
  'authority_id',
  'rail_ids',
  'no_external_rail_basis',
  'effect_key_contract',
  'simulator_scenarios',
  'late_outcome_rule',
  'activation_evidence',
];

export const authorityIdPattern = /^AUTH-\d{3}$/;
export const railIdPattern = /^RAIL-\d{3}$/;

const phiClasses: readonly PhiClass[] = ['none', 'demographic', 'PHI', 'PHI-restricted', 'secret'];

export class AdapterContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AdapterContractError';
  }
}

/**
 * Contract-presence check: a declared adapter contract must carry every
 * required field, non-empty, with the authority id, direction, classification
 * ceiling, and late-outcome class drawn from their vocabularies. Returns the
 * list of problems (empty = complete) so the `verify:adapters` gate can name
 * exactly what an incomplete adapter is missing.
 */
export function validateAdapterContract(contract: Partial<AdapterContract>): readonly string[] {
  const problems: string[] = [];
  for (const field of adapterContractRequiredFields) {
    const value = contract[field];
    if (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '')
    ) {
      problems.push(`missing ${String(field)}`);
    }
  }
  if (contract.authorityId !== undefined && !authorityIdPattern.test(contract.authorityId)) {
    problems.push(`authorityId ${JSON.stringify(contract.authorityId)} is not an AUTH-### id`);
  }
  if (
    contract.direction !== undefined &&
    !(adapterDirections as readonly string[]).includes(contract.direction)
  ) {
    problems.push(`direction ${JSON.stringify(contract.direction)} is not a known direction`);
  }
  if (
    contract.fieldClassificationCeiling !== undefined &&
    !phiClasses.includes(contract.fieldClassificationCeiling)
  ) {
    problems.push(
      `fieldClassificationCeiling ${JSON.stringify(contract.fieldClassificationCeiling)} is not a PhiClass`,
    );
  }
  if (
    contract.lateOutcomeRuleClass !== undefined &&
    !(lateOutcomeRuleClasses as readonly string[]).includes(contract.lateOutcomeRuleClass)
  ) {
    problems.push(
      `lateOutcomeRuleClass ${JSON.stringify(contract.lateOutcomeRuleClass)} is not a known class`,
    );
  }
  return problems;
}

export interface LateOutcomeEvent {
  readonly ruleClass: LateOutcomeRuleClass;
  /** Whether the original external effect already published (the recovery fence). */
  readonly effectAlreadyPublished: boolean;
  /** Whether an authoritative/signed prior version exists for the aggregate. */
  readonly hasAuthoritativePriorVersion: boolean;
}

export type LateOutcomeAction =
  | 'attach-and-reconcile'
  | 'quarantine-for-review'
  | 'open-review'
  | 'suppress-future'
  | 'supersede-new-version'
  | 'discard-stale'
  | 'no-op';

/**
 * The disposition of a late outcome. Two invariants are LITERAL `false` by
 * type: a late outcome never re-sends the external effect (no-duplicate-submission,
 * ADR C-class) and never overwrites authoritative/signed truth (SoR matrix). The
 * `action` classifies HOW it reconciles, per the rule class.
 */
export interface LateOutcomeDisposition {
  readonly action: LateOutcomeAction;
  readonly resendsExternalEffect: false;
  readonly overwritesAuthoritativeTruth: false;
}

const lateOutcomeActionByClass: Readonly<Record<LateOutcomeRuleClass, LateOutcomeAction>> = {
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

/**
 * Reconcile a late external outcome. Whatever the rule class and whatever the
 * fence state, the disposition NEVER re-sends the external effect and NEVER
 * overwrites authoritative truth — those invariants are structural (literal
 * `false`). The action reflects the rail's declared reconciliation posture.
 */
export function reconcileLateOutcome(event: LateOutcomeEvent): LateOutcomeDisposition {
  if (!(lateOutcomeRuleClasses as readonly string[]).includes(event.ruleClass)) {
    throw new AdapterContractError(
      `unknown late-outcome rule class ${JSON.stringify(event.ruleClass)}`,
    );
  }
  return {
    action: lateOutcomeActionByClass[event.ruleClass],
    resendsExternalEffect: false,
    overwritesAuthoritativeTruth: false,
  };
}
