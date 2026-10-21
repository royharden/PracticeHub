/**
 * Split-billing routing for Medicare concierge physicals (R6-REQ-024;
 * REQ-RCM-081, REQ-MEM-002).
 *
 * Every composition element sits in exactly one bucket. Covered elements
 * (AWV, IPPE) reach the Medicare claim; non-covered-enhanced elements reach
 * membership or cash. One element is never billed both ways: any element
 * charged on two rails blocks submission and routes to biller review. An
 * unclassified element holds the claim for compliance review.
 *
 * `CompositionElement` mirrors the catalog ComponentMap (WP-050) structurally;
 * `@practicehub/rcm` has no package edge to `@practicehub/catalog`.
 */

import type { CoveredVisitWindow } from './awv-timing.js';

export type CoverageBucket = 'awv-covered' | 'ippe-covered' | 'non-covered-enhanced';

export interface CompositionElement {
  readonly componentRef: string;
  /** null when the catalog has not classified the element. */
  readonly bucket: CoverageBucket | null;
}

/** Catalog ComponentKind → bucket; lab/other need an explicit classification. */
export function bucketForCatalogKind(
  kind: 'awv' | 'ippe' | 'cash-service' | 'lab' | 'other',
): CoverageBucket | null {
  switch (kind) {
    case 'awv':
      return 'awv-covered';
    case 'ippe':
      return 'ippe-covered';
    case 'cash-service':
      return 'non-covered-enhanced';
    case 'lab':
    case 'other':
      return null;
  }
}

export type BillingRail = 'medicare-claim' | 'membership' | 'cash';

export interface ProposedCharge {
  readonly chargeRef: string;
  readonly componentRef: string;
  readonly rail: BillingRail;
}

export interface SplitHold {
  readonly componentRef: string;
  readonly reason:
    | 'unclassified-element'
    | 'element-billed-both-ways'
    | 'element-charged-twice'
    | 'claim-for-non-beneficiary'
    | 'covered-element-off-claim'
    | 'noncovered-element-on-claim'
    | 'charge-not-in-composition'
    | 'covered-element-unbilled'
    | 'covered-visit-not-eligible'
    | 'manual-eligibility-confirmation';
  readonly queue: 'biller-review' | 'compliance-review' | 'eligibility-confirmation';
}

export interface SplitDecision {
  readonly submit: boolean;
  readonly claimLines: readonly ProposedCharge[];
  readonly membershipLines: readonly ProposedCharge[];
  readonly cashLines: readonly ProposedCharge[];
  readonly holds: readonly SplitHold[];
  /** Adjudication record for the OIG no-double-billing report. */
  readonly adjudication: readonly {
    readonly componentRef: string;
    readonly bucket: CoverageBucket | null;
    readonly rails: readonly BillingRail[];
  }[];
}

const isCovered = (bucket: CoverageBucket | null): boolean =>
  bucket === 'awv-covered' || bucket === 'ippe-covered';

export function routeSplitBilling(input: {
  readonly medicarePatient: boolean;
  readonly elements: readonly CompositionElement[];
  readonly charges: readonly ProposedCharge[];
  /** Timing for the covered visit kinds present in the composition. */
  readonly windows: Readonly<Partial<Record<'awv' | 'ippe', CoveredVisitWindow>>>;
}): SplitDecision {
  const elements = new Map<string, CompositionElement>();
  for (const element of input.elements) {
    if (elements.has(element.componentRef)) {
      throw new Error(`composition lists ${element.componentRef} twice`);
    }
    elements.set(element.componentRef, element);
  }
  const holds: SplitHold[] = [];
  const hold = (
    componentRef: string,
    reason: SplitHold['reason'],
    queue: SplitHold['queue'],
  ): void => {
    if (!holds.some((item) => item.componentRef === componentRef && item.reason === reason)) {
      holds.push({ componentRef, reason, queue });
    }
  };

  const railsByElement = new Map<string, Set<BillingRail>>();
  const chargesPerRail = new Map<string, number>();
  for (const charge of input.charges) {
    const element = elements.get(charge.componentRef);
    if (element === undefined) {
      hold(charge.componentRef, 'charge-not-in-composition', 'biller-review');
      continue;
    }
    const rails = railsByElement.get(charge.componentRef) ?? new Set<BillingRail>();
    rails.add(charge.rail);
    railsByElement.set(charge.componentRef, rails);
    const railKey = JSON.stringify([charge.componentRef, charge.rail]);
    chargesPerRail.set(railKey, (chargesPerRail.get(railKey) ?? 0) + 1);
  }
  for (const [railKey, count] of chargesPerRail) {
    const [componentRef] = JSON.parse(railKey) as [string, BillingRail];
    if (count > 1) hold(componentRef, 'element-charged-twice', 'biller-review');
  }

  for (const element of elements.values()) {
    const rails = railsByElement.get(element.componentRef) ?? new Set<BillingRail>();
    if (element.bucket === null) {
      hold(element.componentRef, 'unclassified-element', 'compliance-review');
      continue;
    }
    const onClaim = rails.has('medicare-claim');
    const offClaim = rails.has('membership') || rails.has('cash');
    if (rails.size > 1) {
      hold(element.componentRef, 'element-billed-both-ways', 'biller-review');
    }
    if (!input.medicarePatient) {
      // A Medicare claim line for a patient who is not a beneficiary is never submitted.
      if (onClaim) hold(element.componentRef, 'claim-for-non-beneficiary', 'biller-review');
      continue;
    }
    if (isCovered(element.bucket)) {
      if (offClaim) hold(element.componentRef, 'covered-element-off-claim', 'compliance-review');
      if (!onClaim) hold(element.componentRef, 'covered-element-unbilled', 'biller-review');
      const window = input.windows[element.bucket === 'awv-covered' ? 'awv' : 'ippe'];
      if (onClaim && (window === undefined || window.manualConfirmationRequired)) {
        hold(element.componentRef, 'manual-eligibility-confirmation', 'eligibility-confirmation');
      } else if (onClaim && window !== undefined && window.status !== 'eligible') {
        hold(element.componentRef, 'covered-visit-not-eligible', 'biller-review');
      }
    } else if (onClaim) {
      hold(element.componentRef, 'noncovered-element-on-claim', 'biller-review');
    }
  }

  const railOf = (rail: BillingRail): ProposedCharge[] =>
    input.charges.filter((charge) => charge.rail === rail && elements.has(charge.componentRef));
  return {
    submit: holds.length === 0,
    claimLines: railOf('medicare-claim'),
    membershipLines: railOf('membership'),
    cashLines: railOf('cash'),
    holds,
    adjudication: [...elements.values()].map((element) => ({
      componentRef: element.componentRef,
      bucket: element.bucket,
      rails: [...(railsByElement.get(element.componentRef) ?? [])].sort(),
    })),
  };
}
