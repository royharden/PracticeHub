import { RcmShadowError } from '../contracts.js';
import type { PayerRoute } from '../router.js';

import type { EnrollmentTransaction, PathCatalog, PathId } from './paths.js';
import type { EnrollmentRegistry } from './registry.js';

export type RoutePurpose = 'claims' | 'eligibility';

export interface PathRoute {
  readonly payerId: string;
  readonly purpose: RoutePurpose;
  readonly primary: PathId;
  readonly secondary: PathId | null;
  readonly requiredTransactions: readonly EnrollmentTransaction[];
}

export type DiversityFindingCode =
  | 'shared-upstream'
  | 'same-path'
  | 'single-homed'
  | 'unsupported-transaction'
  | 'primary-not-enrolled'
  | 'secondary-not-enrolled';

export type FindingSeverity = 'block' | 'warn';

export interface DiversityFinding {
  readonly code: DiversityFindingCode;
  readonly severity: FindingSeverity;
  readonly leg: 'route' | 'primary' | 'secondary';
  readonly detail: string;
}

export interface DiversityResult {
  readonly payerId: string;
  readonly purpose: RoutePurpose;
  readonly primary: PathId;
  readonly secondary: PathId | null;
  /** True only when a distinct, independently-upstreamed, enrolled secondary exists. */
  readonly diverse: boolean;
  readonly sharedUpstreams: readonly string[];
  readonly findings: readonly DiversityFinding[];
}

/** WP-085 routes carry claims; the 837 is the transaction the secondary must actually carry. */
export function fromRouterRoutes(routes: readonly PayerRoute[]): readonly PathRoute[] {
  return routes.map((route) => ({
    payerId: route.payerId,
    purpose: 'claims',
    primary: route.primary,
    secondary: route.secondary,
    requiredTransactions: ['837'],
  }));
}

/** Canonical form of an upstream carrier label for comparison (trim, case-fold). */
export function normalizeUpstream(label: string): string {
  return label.trim().toLowerCase();
}

function checkRoute(
  route: PathRoute,
  catalog: PathCatalog,
  registry: EnrollmentRegistry | null,
): DiversityResult {
  if (route.requiredTransactions.length === 0) {
    throw new RcmShadowError('DIVERSITY_ROUTE', 'a route must name the transactions it carries');
  }
  const findings: DiversityFinding[] = [];
  const primary = catalog.get(route.primary);
  let sharedUpstreams: string[] = [];

  if (route.secondary === null) {
    findings.push({
      code: 'single-homed',
      severity: 'warn',
      leg: 'route',
      detail: `${route.payerId} ${route.purpose} has no secondary path`,
    });
  } else if (route.secondary === route.primary) {
    findings.push({
      code: 'same-path',
      severity: 'block',
      leg: 'route',
      detail: `${route.payerId} ${route.purpose} names ${route.primary} as both primary and secondary`,
    });
  } else {
    const secondary = catalog.get(route.secondary);
    // Labels are compared trimmed and case-folded: 'Upstream-X' and 'upstream-x' are one carrier.
    const secondaryUpstreams = new Set(secondary.upstreams.map(normalizeUpstream));
    sharedUpstreams = [
      ...new Set(
        primary.upstreams.map(normalizeUpstream).filter((up) => secondaryUpstreams.has(up)),
      ),
    ].sort();
    if (sharedUpstreams.length > 0) {
      findings.push({
        code: 'shared-upstream',
        severity: 'block',
        leg: 'route',
        detail: `${route.primary} and ${route.secondary} share upstream ${sharedUpstreams.join(', ')}`,
      });
    }
  }

  const legs: { readonly role: 'primary' | 'secondary'; readonly pathId: PathId }[] = [
    { role: 'primary', pathId: route.primary },
  ];
  if (route.secondary !== null && route.secondary !== route.primary) {
    legs.push({ role: 'secondary', pathId: route.secondary });
  }
  for (const leg of legs) {
    for (const transaction of route.requiredTransactions) {
      if (!catalog.supports(leg.pathId, transaction)) {
        findings.push({
          code: 'unsupported-transaction',
          severity: 'block',
          leg: leg.role,
          detail: `${leg.role} ${leg.pathId} does not carry ${transaction}`,
        });
        continue;
      }
      if (
        registry !== null &&
        !registry.isEnrolled({ payerId: route.payerId, pathId: leg.pathId, transaction })
      ) {
        findings.push({
          code: leg.role === 'primary' ? 'primary-not-enrolled' : 'secondary-not-enrolled',
          severity: 'block',
          leg: leg.role,
          detail: `${route.payerId} is not enrolled for ${transaction} on ${leg.pathId}`,
        });
      }
    }
  }

  // The primary leg's own blocks are reported but do not decide whether the secondary is real.
  const diverse =
    route.secondary !== null &&
    !findings.some((finding) => finding.severity === 'block' && finding.leg !== 'primary');

  return {
    payerId: route.payerId,
    purpose: route.purpose,
    primary: route.primary,
    secondary: route.secondary,
    diverse,
    sharedUpstreams,
    findings,
  };
}

/**
 * Verifies each payer route has a real alternative: a distinct secondary that shares no
 * upstream with the primary and is enrolled for every required transaction. Passing a
 * registry adds the enrollment checks; without one only topology is checked.
 */
export function verifyPayerPathDiversity(
  routes: readonly PathRoute[],
  catalog: PathCatalog,
  registry: EnrollmentRegistry | null = null,
): readonly DiversityResult[] {
  const seen = new Set<string>();
  for (const route of routes) {
    const id = `${route.payerId}\u001f${route.purpose}`;
    if (seen.has(id)) {
      throw new RcmShadowError('DIVERSITY_ROUTE', 'one route per payer and purpose');
    }
    seen.add(id);
  }
  return routes.map((route) => checkRoute(route, catalog, registry));
}
