import { RcmShadowError } from './contracts.js';

export type RailId = 'ch-sim-A' | 'ch-sim-B';
export type RailMode = 'dual-rail' | 'single-rail';
export type RailTransaction = '835' | '837';

const RAIL_IDS: readonly RailId[] = ['ch-sim-A', 'ch-sim-B'];

/** Enrollment for one payer on one rail (EW-CH-01 is per payer and clearinghouse). */
export interface RailEnrollment {
  readonly railId: RailId;
  readonly transactions: readonly RailTransaction[];
}

export interface PayerRoute {
  readonly payerId: string;
  readonly primary: RailId;
  readonly secondary: RailId | null;
  /**
   * Legacy route-wide enrollment. Used for both rails when `enrollment` is absent, so routes
   * written before per-rail enrollment keep their meaning.
   */
  readonly enrolledTransactions: readonly RailTransaction[];
  /** Per-rail enrollment. When present it is the only enrollment the router trusts. */
  readonly enrollment?: readonly RailEnrollment[];
}

export interface RoutedClaim {
  readonly claimId: string;
  readonly payerId: string;
  /** Scopes claim identity; claims without a tenant share the default scope. */
  readonly tenantId?: string;
}

export interface SubmittedClaim {
  readonly claimId: string;
  readonly payerId: string;
  readonly railId: RailId;
}

export interface RailAcknowledgment {
  readonly railId: RailId;
  readonly mode: RailMode;
  readonly claimCount: number;
}

export interface ManualSwitch {
  readonly payerId: string;
  readonly target: RailId;
  readonly reason: string;
  readonly actor?: string;
  readonly at?: string;
  readonly previousPrimary?: RailId;
}

/** Ledger state of a claim id the router has already put on a rail. */
export type LedgerState = 'in-flight' | 'acknowledged' | 'rejected-by-rail' | 'released';

export interface LedgerEntry {
  readonly tenantId: string;
  readonly payerId: string;
  readonly claimId: string;
  readonly railId: RailId;
  readonly state: LedgerState;
}

export type HoldReason = 'primary-not-enrolled' | 'secondary-not-enrolled' | 'no-available-rail';

export interface HeldClaim {
  readonly claimId: string;
  readonly payerId: string;
  readonly reason: HoldReason;
}

export interface BatchResult {
  /** Claims a rail acknowledged in this batch. */
  readonly submitted: readonly SubmittedClaim[];
  /** One entry per rail that acknowledged claims; none for an empty batch. */
  readonly acknowledgments: readonly RailAcknowledgment[];
  /** Repeats within the batch plus claims already on a rail from an earlier batch. */
  readonly duplicateCount: number;
  /** Sent but unacknowledged: never resent until a status inquiry resolves them. */
  readonly inFlight?: readonly SubmittedClaim[];
  /** Claims not sent: routing, enrollment or rail availability kept them back. Safe to retry. */
  readonly held?: readonly HeldClaim[];
  /** Claims a rail rejected at rail level in this batch. Recorded; may be resubmitted. */
  readonly railRejected?: readonly SubmittedClaim[];
  /** Earlier-batch claims skipped here, with where they already are. */
  readonly alreadySubmitted?: readonly LedgerEntry[];
}

export interface RemitDecision {
  readonly accepted: boolean;
  readonly reason: 'enrollment-constraint' | null;
}

/**
 * What a (simulated) rail answers when a claim is sent:
 * `ack` accepted and acknowledged; `timeout` sent but no answer (may be held by the rail);
 * `refused` connection refused, definitely not received; `rejected` rail-level rejection.
 */
export type RailSendResult = 'ack' | 'timeout' | 'refused' | 'rejected';

export interface RailTransport {
  send(railId: RailId, claim: RoutedClaim): RailSendResult;
}

export interface RouterOptions {
  readonly transport?: RailTransport;
  readonly clock?: () => string;
}

/** Default simulated transport: every send is acknowledged. */
export const ACKNOWLEDGING_TRANSPORT: RailTransport = { send: () => 'ack' };

interface MutableRoute {
  payerId: string;
  primary: RailId;
  secondary: RailId | null;
  enrolledTransactions: readonly RailTransaction[];
  enrollment: readonly RailEnrollment[] | null;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DEFAULT_TENANT = '';
const KNOWN_SEND_RESULTS: readonly unknown[] = ['ack', 'timeout', 'refused', 'rejected'];

function assertRail(value: unknown, code: string): asserts value is RailId {
  if (!RAIL_IDS.includes(value as RailId)) {
    throw new RcmShadowError(code, 'rail must be ch-sim-A or ch-sim-B');
  }
}

function enrolledOn(
  route: MutableRoute | PayerRoute,
  railId: RailId,
  transaction: RailTransaction,
): boolean {
  const perRail = 'enrollment' in route ? route.enrollment : undefined;
  if (perRail !== undefined && perRail !== null) {
    return perRail.some(
      (entry) => entry.railId === railId && entry.transactions.includes(transaction),
    );
  }
  const onRoute = railId === route.primary || railId === route.secondary;
  return onRoute && route.enrolledTransactions.includes(transaction);
}

function ledgerKey(tenantId: string, payerId: string, claimId: string): string {
  return `${tenantId}\u001f${payerId}\u001f${claimId}`;
}

export class ClearinghouseRouter {
  private readonly routes = new Map<string, MutableRoute>();
  private readonly switches: ManualSwitch[] = [];
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly transport: RailTransport;
  private readonly clock: () => string;

  public constructor(
    routes: readonly PayerRoute[],
    private readonly mode: RailMode,
    options: RouterOptions = {},
  ) {
    if (mode !== 'dual-rail' && mode !== 'single-rail') {
      throw new RcmShadowError('ROUTER_MODE', 'mode must be dual-rail or single-rail');
    }
    this.transport = options.transport ?? ACKNOWLEDGING_TRANSPORT;
    this.clock = options.clock ?? (() => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
    for (const route of routes) {
      if (this.routes.has(route.payerId)) {
        throw new RcmShadowError('ROUTER_ROUTE', 'payer route must be unique');
      }
      if (!TOKEN.test(route.payerId)) {
        throw new RcmShadowError('ROUTER_ROUTE', 'payerId must be a token');
      }
      assertRail(route.primary, 'ROUTER_ROUTE');
      if (route.secondary !== null) {
        assertRail(route.secondary, 'ROUTER_ROUTE');
      }
      // Validated up front so a failover can never discover a missing secondary mid-batch.
      if (mode === 'dual-rail' && (route.secondary === null || route.secondary === route.primary)) {
        throw new RcmShadowError(
          'ROUTER_ROUTE',
          'dual-rail requires a distinct secondary for every payer',
        );
      }
      for (const entry of route.enrollment ?? []) {
        assertRail(entry.railId, 'ROUTER_ROUTE');
      }
      this.routes.set(route.payerId, {
        payerId: route.payerId,
        primary: route.primary,
        secondary: route.secondary,
        enrolledTransactions: [...route.enrolledTransactions],
        enrollment:
          route.enrollment === undefined ? null : route.enrollment.map((entry) => ({ ...entry })),
      });
    }
  }

  /**
   * Changes the payer's primary for later batches. Switching to the current secondary swaps the
   * two, so dual-rail always keeps a distinct secondary. The target must be enrolled for 837.
   */
  public manualSwitch(
    payerId: string,
    target: RailId,
    reason: string,
    actor = 'unattributed',
  ): void {
    const route = this.requireRoute(payerId);
    assertRail(target, 'ROUTER_SWITCH');
    if (reason.length === 0) {
      throw new RcmShadowError('ROUTER_SWITCH', 'manual switch requires a reason');
    }
    if (!enrolledOn(route, target, '837')) {
      throw new RcmShadowError(
        'ROUTER_SWITCH',
        'cannot switch to a rail the payer is not enrolled on for 837',
      );
    }
    const previousPrimary = route.primary;
    if (target === route.secondary) {
      route.secondary = previousPrimary;
    }
    route.primary = target;
    this.switches.push(
      Object.freeze({ payerId, target, reason, actor, at: this.clock(), previousPrimary }),
    );
  }

  public switchLog(): readonly ManualSwitch[] {
    return Object.freeze([...this.switches]);
  }

  /** Where the router believes a claim is. Undefined when the router never sent it. */
  public ledgerEntry(
    claimId: string,
    payerId: string,
    tenantId = DEFAULT_TENANT,
  ): LedgerEntry | undefined {
    return this.ledger.get(ledgerKey(tenantId, payerId, claimId));
  }

  /**
   * Records the result of a claim-status inquiry for an in-flight claim. `holds` marks it
   * acknowledged on the rail that holds it; `not-held` releases it for resubmission.
   */
  public resolveInFlight(
    claimId: string,
    payerId: string,
    finding:
      { readonly result: 'holds'; readonly railId: RailId } | { readonly result: 'not-held' },
    tenantId = DEFAULT_TENANT,
  ): LedgerEntry {
    const key = ledgerKey(tenantId, payerId, claimId);
    const entry = this.ledger.get(key);
    if (!entry || entry.state !== 'in-flight') {
      throw new RcmShadowError(
        'ROUTER_INQUIRY',
        'only an in-flight claim is resolved by status inquiry',
      );
    }
    const next: LedgerEntry =
      finding.result === 'holds'
        ? { ...entry, railId: finding.railId, state: 'acknowledged' }
        : { ...entry, state: 'released' };
    this.setLedger(key, next);
    return next;
  }

  public submitBatch(
    claims: readonly RoutedClaim[],
    failPrimaryAfter: number | null = null,
  ): BatchResult {
    // Every claim's route is checked before anything is sent, so no send is ever lost to a throw.
    for (const claim of claims) {
      this.requireRoute(claim.payerId);
      if (claim.tenantId !== undefined && !TOKEN.test(claim.tenantId)) {
        throw new RcmShadowError('ROUTER_CLAIM', 'tenantId must be a token');
      }
    }
    const seen = new Set<string>();
    const submitted: SubmittedClaim[] = [];
    const inFlight: SubmittedClaim[] = [];
    const held: HeldClaim[] = [];
    const railRejected: SubmittedClaim[] = [];
    const alreadySubmitted: LedgerEntry[] = [];
    let duplicateCount = 0;
    const primaryCounts = new Map<string, number>();
    const failedPayers = new Set<string>();

    for (const claim of claims) {
      const tenantId = claim.tenantId ?? DEFAULT_TENANT;
      const key = ledgerKey(tenantId, claim.payerId, claim.claimId);
      if (seen.has(key)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(key);
      const prior = this.ledger.get(key);
      if (prior && (prior.state === 'in-flight' || prior.state === 'acknowledged')) {
        duplicateCount += 1;
        alreadySubmitted.push(prior);
        continue;
      }
      const route = this.requireRoute(claim.payerId);
      const sentOnPrimary = primaryCounts.get(claim.payerId) ?? 0;
      if (
        this.mode === 'dual-rail' &&
        failPrimaryAfter !== null &&
        !failedPayers.has(claim.payerId) &&
        sentOnPrimary >= failPrimaryAfter
      ) {
        failedPayers.add(claim.payerId);
      }

      let outcome: 'done' | 'held' = 'held';
      let holdReason: HoldReason = 'no-available-rail';
      // At most two attempts: the chosen rail, then the secondary if the first definitely refused.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const onSecondary = this.mode === 'dual-rail' && failedPayers.has(claim.payerId);
        const railId = onSecondary ? route.secondary : route.primary;
        if (railId === null) {
          holdReason = 'no-available-rail';
          break;
        }
        if (!enrolledOn(route, railId, '837')) {
          holdReason = onSecondary ? 'secondary-not-enrolled' : 'primary-not-enrolled';
          break;
        }
        // Persist before the call: a crash mid-send leaves the claim in-flight, never forgotten.
        this.setLedger(key, {
          tenantId,
          payerId: claim.payerId,
          claimId: claim.claimId,
          railId,
          state: 'in-flight',
        });
        let result: RailSendResult;
        try {
          result = this.transport.send(railId, claim);
        } catch {
          // A send that died without an answer may have reached the rail: same as a timeout.
          result = 'timeout';
        }
        const placed: SubmittedClaim = { claimId: claim.claimId, payerId: claim.payerId, railId };
        if (!KNOWN_SEND_RESULTS.includes(result)) {
          // A malformed or unknown answer says nothing about delivery: the claim stays in-flight
          // and needs a status inquiry before any resend. It is never read as refused, so there is
          // no failover on it, and it is not evidence of a rail outage.
          inFlight.push(placed);
          outcome = 'done';
          break;
        }
        if (result === 'ack') {
          this.setLedger(key, {
            tenantId,
            payerId: claim.payerId,
            claimId: claim.claimId,
            railId,
            state: 'acknowledged',
          });
          submitted.push(placed);
          if (!onSecondary) {
            primaryCounts.set(claim.payerId, sentOnPrimary + 1);
          }
          outcome = 'done';
          break;
        }
        if (result === 'timeout') {
          // The rail may hold it: stays in-flight, and later claims for this payer fail over.
          inFlight.push(placed);
          if (this.mode === 'dual-rail' && !onSecondary) {
            failedPayers.add(claim.payerId);
          }
          outcome = 'done';
          break;
        }
        if (result === 'rejected') {
          this.setLedger(key, {
            tenantId,
            payerId: claim.payerId,
            claimId: claim.claimId,
            railId,
            state: 'rejected-by-rail',
          });
          railRejected.push(placed);
          outcome = 'done';
          break;
        }
        // refused: definitely not received, so it is safe to try the secondary once.
        this.ledger.delete(key);
        if (this.mode === 'dual-rail' && !onSecondary) {
          failedPayers.add(claim.payerId);
          continue;
        }
        holdReason = 'no-available-rail';
        break;
      }
      if (outcome === 'held') {
        held.push({ claimId: claim.claimId, payerId: claim.payerId, reason: holdReason });
      }
    }

    const counts = new Map<RailId, number>();
    for (const claim of submitted) {
      counts.set(claim.railId, (counts.get(claim.railId) ?? 0) + 1);
    }
    const acknowledgments: RailAcknowledgment[] = RAIL_IDS.filter((railId) =>
      counts.has(railId),
    ).map((railId) => ({ railId, mode: this.mode, claimCount: counts.get(railId) ?? 0 }));

    return {
      submitted,
      acknowledgments,
      duplicateCount,
      inFlight,
      held,
      railRejected,
      alreadySubmitted,
    };
  }

  /** Accepts an 835 only when it arrived on a rail the payer is enrolled on for 835. */
  public acceptRemitOn(payerId: string, railId: RailId): RemitDecision {
    assertRail(railId, 'ROUTER_REMIT');
    return enrolledOn(this.requireRoute(payerId), railId, '835')
      ? { accepted: true, reason: null }
      : { accepted: false, reason: 'enrollment-constraint' };
  }

  /** Ledger entries are frozen when written, so no caller can alter the router's record. */
  private setLedger(key: string, entry: LedgerEntry): void {
    this.ledger.set(key, Object.freeze({ ...entry }));
  }

  private requireRoute(payerId: string): MutableRoute {
    const route = this.routes.get(payerId);
    if (!route) {
      throw new RcmShadowError('ROUTER_ROUTE', 'payer has no route');
    }
    return route;
  }
}

/**
 * Rejects an 835 that fails the enrollment constraint. With `railId`, enrollment is checked for
 * that exact rail (per-rail enrollment when the route has it); without it, the route-wide check
 * the router has always made.
 */
export function acceptRemit(route: PayerRoute, railId?: RailId): RemitDecision {
  const enrolled =
    railId === undefined
      ? route.enrollment !== undefined
        ? route.enrollment.some((entry) => entry.transactions.includes('835'))
        : route.enrolledTransactions.includes('835')
      : enrolledOn(route, railId, '835');
  if (!enrolled) {
    return { accepted: false, reason: 'enrollment-constraint' };
  }
  return { accepted: true, reason: null };
}
