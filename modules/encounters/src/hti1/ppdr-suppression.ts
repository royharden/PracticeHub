/**
 * Patient-Provider Dispute Resolution (PPDR) suppression (WP-096; R6-REQ-051).
 *
 * A PPDR dispute opens only on a GFE variance at or above the $400 threshold
 * and retains its artifact pack. While a dispute is active, collections and
 * late fees on the disputed bill are suppressed. This module does not edit the
 * ledger: it publishes `LedgerSuppressionFlag`, a PLACEHOLDER shape the
 * payments ledger (WP-057 statements/dunning) consumes on the integration pass.
 */

/** Mirrors catalog-cash CASH_PPDR_THRESHOLD_MINOR (read-only; not imported). */
export const PPDR_THRESHOLD_MINOR = 40_000;

export class PpdrError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PpdrError';
  }
}

export interface GfeVarianceInput {
  readonly purchaseKey: string;
  readonly gfeTotalMinor: number;
  readonly actualTotalMinor: number;
}

export interface PpdrArtifactPack {
  readonly gfeRef: string;
  readonly billRef: string;
  readonly gfeTotalMinor: number;
  readonly actualTotalMinor: number;
  readonly deltaMinor: number;
  readonly noticeRefs: readonly string[];
}

export type DisputeStatus =
  'active' | 'resolved-for-patient' | 'resolved-for-provider' | 'withdrawn';

export interface PpdrDispute {
  readonly disputeId: string;
  readonly tenantId: string;
  readonly accountRef: string;
  readonly billRef: string;
  readonly openedAt: string;
  readonly status: DisputeStatus;
  readonly artifacts: PpdrArtifactPack;
  readonly determinedAmountMinor: number | null;
  readonly closedAt: string | null;
}

/** PLACEHOLDER consumer contract for WP-057 (payments ledger). */
export interface LedgerSuppressionFlag {
  readonly tenantId: string;
  readonly accountRef: string;
  readonly billRef: string;
  readonly suppressCollections: boolean;
  readonly suppressLateFees: boolean;
  readonly reasonRef: string;
  readonly placeholderFor: 'WP-057';
}

export type LedgerAction = 'collections-referral' | 'late-fee' | 'dunning-notice';

export class PpdrDisputeDesk {
  private readonly disputes = new Map<string, PpdrDispute>();

  public open(input: {
    readonly disputeId: string;
    readonly tenantId: string;
    readonly accountRef: string;
    readonly billRef: string;
    readonly gfeRef: string;
    readonly variance: GfeVarianceInput;
    readonly noticeRefs: readonly string[];
    readonly openedAt: string;
  }): PpdrDispute {
    for (const amount of [input.variance.gfeTotalMinor, input.variance.actualTotalMinor]) {
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new PpdrError(
          'GFE and billed totals must be non-negative safe-integer minor-unit amounts',
        );
      }
    }
    const deltaMinor = input.variance.actualTotalMinor - input.variance.gfeTotalMinor;
    if (deltaMinor < PPDR_THRESHOLD_MINOR) {
      throw new PpdrError(`variance ${deltaMinor} is below the PPDR threshold`);
    }
    if (this.disputes.has(input.disputeId)) {
      throw new PpdrError(`dispute ${input.disputeId} already open`);
    }
    const dispute: PpdrDispute = {
      disputeId: input.disputeId,
      tenantId: input.tenantId,
      accountRef: input.accountRef,
      billRef: input.billRef,
      openedAt: input.openedAt,
      status: 'active',
      artifacts: Object.freeze({
        gfeRef: input.gfeRef,
        billRef: input.billRef,
        gfeTotalMinor: input.variance.gfeTotalMinor,
        actualTotalMinor: input.variance.actualTotalMinor,
        deltaMinor,
        noticeRefs: Object.freeze([...input.noticeRefs]),
      }),
      determinedAmountMinor: null,
      closedAt: null,
    };
    this.disputes.set(input.disputeId, dispute);
    return dispute;
  }

  public resolve(
    disputeId: string,
    status: Exclude<DisputeStatus, 'active'>,
    at: string,
    determinedAmountMinor: number | null = null,
  ): PpdrDispute {
    const current = this.require(disputeId);
    if (current.status !== 'active') {
      throw new PpdrError(`dispute ${disputeId} is already ${current.status}`);
    }
    if (
      determinedAmountMinor !== null &&
      (!Number.isSafeInteger(determinedAmountMinor) || determinedAmountMinor < 0)
    ) {
      throw new PpdrError(
        'the determined amount must be a non-negative safe-integer minor-unit amount',
      );
    }
    const atMs = typeof at === 'string' ? Date.parse(at) : Number.NaN;
    if (!Number.isFinite(atMs)) {
      throw new PpdrError(`resolution time is not a valid instant: ${String(at)}`);
    }
    const openedMs = Date.parse(current.openedAt);
    if (Number.isFinite(openedMs) && atMs < openedMs) {
      throw new PpdrError('a dispute cannot be resolved before it was opened');
    }
    const next: PpdrDispute = { ...current, status, determinedAmountMinor, closedAt: at };
    this.disputes.set(disputeId, next);
    return next;
  }

  /** Flags the ledger consumes: one per bill with an active dispute. */
  public suppressionFlags(tenantId: string, accountRef: string): readonly LedgerSuppressionFlag[] {
    return [...this.disputes.values()]
      .filter(
        (d) => d.tenantId === tenantId && d.accountRef === accountRef && d.status === 'active',
      )
      .map((d) => ({
        tenantId,
        accountRef,
        billRef: d.billRef,
        suppressCollections: true,
        suppressLateFees: true,
        reasonRef: `ppdr:${d.disputeId}`,
        placeholderFor: 'WP-057' as const,
      }));
  }

  /** Reference gate a ledger action must pass; retained artifacts are untouched. */
  public mayTakeLedgerAction(
    tenantId: string,
    accountRef: string,
    billRef: string,
    action: LedgerAction,
  ): { readonly allowed: boolean; readonly reasonRef: string | null } {
    const flag = this.suppressionFlags(tenantId, accountRef).find((f) => f.billRef === billRef);
    if (flag === undefined) {
      return { allowed: true, reasonRef: null };
    }
    const suppressed = action === 'late-fee' ? flag.suppressLateFees : flag.suppressCollections;
    return { allowed: !suppressed, reasonRef: suppressed ? flag.reasonRef : null };
  }

  public get(disputeId: string): PpdrDispute {
    return this.require(disputeId);
  }

  private require(disputeId: string): PpdrDispute {
    const dispute = this.disputes.get(disputeId);
    if (dispute === undefined) {
      throw new PpdrError(`unknown dispute ${disputeId}`);
    }
    return dispute;
  }
}
