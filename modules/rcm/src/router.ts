import { RcmShadowError } from './contracts.js';

export type RailId = 'ch-sim-A' | 'ch-sim-B';
export type RailMode = 'dual-rail' | 'single-rail';
export type RailTransaction = '835' | '837';

export interface PayerRoute {
  readonly payerId: string;
  readonly primary: RailId;
  readonly secondary: RailId | null;
  readonly enrolledTransactions: readonly RailTransaction[];
}

export interface RoutedClaim {
  readonly claimId: string;
  readonly payerId: string;
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
}

export interface BatchResult {
  readonly submitted: readonly SubmittedClaim[];
  readonly acknowledgments: readonly RailAcknowledgment[];
  readonly duplicateCount: number;
}

export interface RemitDecision {
  readonly accepted: boolean;
  readonly reason: 'enrollment-constraint' | null;
}

interface MutableRoute {
  payerId: string;
  primary: RailId;
  secondary: RailId | null;
  enrolledTransactions: readonly RailTransaction[];
}

export class ClearinghouseRouter {
  private readonly routes = new Map<string, MutableRoute>();
  private readonly switches: ManualSwitch[] = [];

  public constructor(
    routes: readonly PayerRoute[],
    private readonly mode: RailMode,
  ) {
    if (mode !== 'dual-rail' && mode !== 'single-rail') {
      throw new RcmShadowError('ROUTER_MODE', 'mode must be dual-rail or single-rail');
    }
    for (const route of routes) {
      if (this.routes.has(route.payerId)) {
        throw new RcmShadowError('ROUTER_ROUTE', 'payer route must be unique');
      }
      this.routes.set(route.payerId, { ...route });
    }
  }

  public manualSwitch(payerId: string, target: RailId, reason: string): void {
    const route = this.requireRoute(payerId);
    if (reason.length === 0) {
      throw new RcmShadowError('ROUTER_SWITCH', 'manual switch requires a reason');
    }
    route.primary = target;
    this.switches.push({ payerId, target, reason });
  }

  public switchLog(): readonly ManualSwitch[] {
    return this.switches;
  }

  public submitBatch(
    claims: readonly RoutedClaim[],
    failPrimaryAfter: number | null = null,
  ): BatchResult {
    const seen = new Set<string>();
    const submitted: SubmittedClaim[] = [];
    let duplicateCount = 0;
    const primaryCounts = new Map<string, number>();
    const failedPayers = new Set<string>();

    for (const claim of claims) {
      if (seen.has(claim.claimId)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(claim.claimId);
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
      const railId = this.railFor(route, failedPayers.has(claim.payerId));
      if (railId === route.primary && !failedPayers.has(claim.payerId)) {
        primaryCounts.set(claim.payerId, sentOnPrimary + 1);
      }
      submitted.push({ claimId: claim.claimId, payerId: claim.payerId, railId });
    }

    const counts = new Map<RailId, number>();
    for (const claim of submitted) {
      counts.set(claim.railId, (counts.get(claim.railId) ?? 0) + 1);
    }
    const acknowledgments: RailAcknowledgment[] =
      this.mode === 'single-rail'
        ? [
            {
              railId: submitted[0]?.railId ?? 'ch-sim-A',
              mode: 'single-rail',
              claimCount: submitted.length,
            },
          ]
        : [...counts.entries()].map(([railId, claimCount]) => ({
            railId,
            mode: 'dual-rail' as const,
            claimCount,
          }));

    return { submitted, acknowledgments, duplicateCount };
  }

  private railFor(route: MutableRoute, primaryFailed: boolean): RailId {
    if (this.mode === 'single-rail' || !primaryFailed) {
      return route.primary;
    }
    if (route.secondary === null || route.secondary === route.primary) {
      throw new RcmShadowError(
        'ROUTER_FAILOVER',
        'dual-rail failover requires a distinct secondary',
      );
    }
    return route.secondary;
  }

  private requireRoute(payerId: string): MutableRoute {
    const route = this.routes.get(payerId);
    if (!route) {
      throw new RcmShadowError('ROUTER_ROUTE', 'payer has no route');
    }
    return route;
  }
}

export function acceptRemit(route: PayerRoute): RemitDecision {
  if (!route.enrolledTransactions.includes('835')) {
    return { accepted: false, reason: 'enrollment-constraint' };
  }
  return { accepted: true, reason: null };
}
