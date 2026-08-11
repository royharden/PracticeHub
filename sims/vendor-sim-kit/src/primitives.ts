/**
 * Failure-injection primitive catalog (WP-027). Contract:
 * docs/contracts/vendor-sim-scenario-api.md (FROZEN) §1.
 *
 * The catalog is DATA of record, versioned `v1`, status ACCEPTED by ruling
 * ADR-ADJ-010 (remediation item R-1, applied by WP-028). Four ids are PINNED by
 * in-repo sources (the event-spine contract's forward-obligation and the
 * matching register row fix crash / replay / duplicate / out-of-order as
 * X-02/03/04/07, in that order); the remaining fourteen are derived from the
 * failure shapes the authority-rail join names across its rows. The ruling found
 * that derivation faithful to every in-repo source that governed it.
 *
 * The catalog ADR-009 cites now resolves in-repo, at
 * `docs/architecture/simulator-failure-catalog.md`. It is a DIFFERENT 18-member
 * set that does not agree id-for-id with this table — a coverage register traced
 * to exception stories, where this is the implementation vocabulary. Per the
 * ruling: an unqualified `X-##` anywhere in this repository means the primitive
 * below, and the graduated catalog's ids are cited `C-X-##`. The two sets are
 * never merged and neither is renumbered; the coverage delta between them is
 * carried by `FWD-SIM-COVERAGE-CATALOG`.
 *
 * Primitives are RAIL-AGNOSTIC: the dispatcher applies them, so "every primitive
 * drives every sim" is a full matrix, not per-rail special cases.
 */

export const injectionPrimitiveFamilies = [
  'transport',
  'outcome',
  'availability',
  'drift',
] as const;
export type InjectionPrimitiveFamily = (typeof injectionPrimitiveFamilies)[number];

/**
 * What the caller observes. Each primitive declares exactly one class, and the
 * dispatcher's behaviour is asserted against this declaration for every rail —
 * a primitive whose implementation drifts from its declared class fails the
 * matrix test.
 */
export const injectionOutcomeClasses = [
  'delivered-slow',
  'transport-failure',
  'deduplicated',
  'extra-receipt',
  'withheld-receipt',
  'reordered-receipts',
  'late-receipt',
  'superseding-receipt',
  'reversing-receipt',
  'split-effect',
  'business-rejection',
  'throttled',
  'unauthorized',
  'conflict',
  'unavailable',
  'contract-violation',
  'version-drift',
] as const;
export type InjectionOutcomeClass = (typeof injectionOutcomeClasses)[number];

export interface InjectionPrimitive {
  /** `X-##` — frozen id grammar (mirrored by the M07 control port). */
  readonly primitiveId: string;
  readonly family: InjectionPrimitiveFamily;
  readonly name: string;
  readonly outcomeClass: InjectionOutcomeClass;
  readonly description: string;
  /** The in-repo source that FIXES this id's meaning (pinned ids only). */
  readonly pinnedBy?: string;
}

export const injectionPrimitiveIdPattern = /^X-\d{2}$/;

export const injectionPrimitiveCatalogStatus = {
  version: 'v1',
  status: 'accepted',
  ruledBy: 'ADR-ADJ-010',
} as const;

const eventSpinePin = 'docs/contracts/event-spine.md#forward-obligations';

export const injectionPrimitivesV1: readonly InjectionPrimitive[] = [
  {
    primitiveId: 'X-01',
    family: 'transport',
    name: 'latency',
    outcomeClass: 'delivered-slow',
    description:
      'The rail answers, slowly. The effect lands and the receipt is issued; the response declares the delay so a caller can assert its own timeout behaviour deterministically.',
  },
  {
    primitiveId: 'X-02',
    family: 'transport',
    name: 'process-crash',
    outcomeClass: 'transport-failure',
    description:
      'The rail process dies at the armed kill point. What the ledger holds at death is the contract: nothing before the effect, `unknown` between effect and receipt, `landed` after the receipt.',
    pinnedBy: eventSpinePin,
  },
  {
    primitiveId: 'X-03',
    family: 'transport',
    name: 'replay',
    outcomeClass: 'deduplicated',
    description:
      'The same logical request is re-delivered. The ledger resolves it to the original effect: one effect, one receipt, a second attempt recorded.',
    pinnedBy: eventSpinePin,
  },
  {
    primitiveId: 'X-04',
    family: 'transport',
    name: 'duplicate',
    outcomeClass: 'extra-receipt',
    description:
      'The rail emits a second receipt for ONE effect (the carrier/webhook double-fire). The ledger still holds a single effect.',
    pinnedBy: eventSpinePin,
  },
  {
    primitiveId: 'X-05',
    family: 'transport',
    name: 'timeout-uncertain',
    outcomeClass: 'transport-failure',
    description:
      'No response reaches the caller and the effect state is unknown. Recovery is reconciliation; a blind resend is structurally unavailable.',
  },
  {
    primitiveId: 'X-06',
    family: 'transport',
    name: 'receipt-gap',
    outcomeClass: 'withheld-receipt',
    description:
      'The effect lands but its asynchronous receipt never arrives (the webhook-loss shape). A landed effect without a receipt demands reconciliation.',
  },
  {
    primitiveId: 'X-07',
    family: 'transport',
    name: 'out-of-order',
    outcomeClass: 'reordered-receipts',
    description:
      'Receipts arrive in reversed sequence. The drained order is the injected order; sequence numbers carry the truth.',
    pinnedBy: eventSpinePin,
  },
  {
    primitiveId: 'X-08',
    family: 'outcome',
    name: 'late-outcome',
    outcomeClass: 'late-receipt',
    description:
      'The outcome arrives across the reconciliation fence. It attaches to the original effect and never re-sends it (the WP-026 late-outcome harness classifies the disposition).',
  },
  {
    primitiveId: 'X-09',
    family: 'outcome',
    name: 'corrected-outcome',
    outcomeClass: 'superseding-receipt',
    description:
      'A corrected result supersedes a prior one. Both receipts are retained; the correction names what it supersedes.',
  },
  {
    primitiveId: 'X-10',
    family: 'outcome',
    name: 'reversal',
    outcomeClass: 'reversing-receipt',
    description:
      'A completed effect is reversed or voided by the rail. The reversal names what it reverses; the original receipt is preserved.',
  },
  {
    primitiveId: 'X-11',
    family: 'outcome',
    name: 'partial-batch',
    outcomeClass: 'split-effect',
    description:
      'A batch splits: part of the effect lands, part does not. The ledger records a partial effect and demands reconciliation before any further mutation.',
  },
  {
    primitiveId: 'X-12',
    family: 'outcome',
    name: 'rejected',
    outcomeClass: 'business-rejection',
    description:
      'The rail rejects on business grounds (bounce, destination reject, validation failure). No effect lands.',
  },
  {
    primitiveId: 'X-13',
    family: 'availability',
    name: 'throttled',
    outcomeClass: 'throttled',
    description: 'The rail rate-limits and names a retry allowance. No effect lands.',
  },
  {
    primitiveId: 'X-14',
    family: 'availability',
    name: 'credential-failure',
    outcomeClass: 'unauthorized',
    description:
      'The rail refuses the credential (expired, revoked, wrong environment). No effect lands and no retry can fix it without a credential change.',
  },
  {
    primitiveId: 'X-15',
    family: 'availability',
    name: 'version-conflict',
    outcomeClass: 'conflict',
    description:
      'An optimistic-concurrency conflict: the caller held a stale version. No effect lands; the caller must re-read.',
  },
  {
    primitiveId: 'X-16',
    family: 'availability',
    name: 'outage',
    outcomeClass: 'unavailable',
    description: 'The rail is unavailable for the armed window. No effect lands.',
  },
  {
    primitiveId: 'X-17',
    family: 'drift',
    name: 'malformed-response',
    outcomeClass: 'contract-violation',
    description:
      'The rail answers with a payload its own contract forbids. The effect state is unknown — a contract violation proves nothing about what happened externally.',
  },
  {
    primitiveId: 'X-18',
    family: 'drift',
    name: 'vendor-version-change',
    outcomeClass: 'version-drift',
    description:
      'The rail answers from a version other than the pinned one. The effect lands, and the version divergence is surfaced for reconciliation rather than silently accepted.',
  },
];

const primitivesById = new Map(
  injectionPrimitivesV1.map((primitive) => [primitive.primitiveId, primitive] as const),
);

export class InjectionPrimitiveError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InjectionPrimitiveError';
  }
}

export function findInjectionPrimitive(primitiveId: string): InjectionPrimitive | undefined {
  return primitivesById.get(primitiveId);
}

/** Resolve a primitive id, failing closed on anything the catalog does not declare. */
export function requireInjectionPrimitive(primitiveId: string): InjectionPrimitive {
  const primitive = primitivesById.get(primitiveId);
  if (!primitive) {
    throw new InjectionPrimitiveError(
      `unknown injection primitive ${JSON.stringify(primitiveId)} — the catalog declares ${injectionPrimitivesV1.length}`,
    );
  }
  return primitive;
}

export function injectionPrimitiveIds(): readonly string[] {
  return injectionPrimitivesV1.map((primitive) => primitive.primitiveId);
}
