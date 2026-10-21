import { describe, expect, it } from 'vitest';

import type { PayerRoute } from '../router.js';

import { fromRouterRoutes, verifyPayerPathDiversity, type PathRoute } from './diversity.js';
import {
  DEFAULT_PATH_CATALOG,
  PathCatalog,
  type EnrollmentTransaction,
  type PathId,
} from './paths.js';
import { EnrollmentRegistry } from './registry.js';

let seq = 0;
function enrollOn(
  registry: EnrollmentRegistry,
  payerId: string,
  pathId: PathId,
  transaction: EnrollmentTransaction,
): void {
  const at = ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z'];
  const steps = [
    ['requested', 'enrollment-request'],
    ['pending-payer', 'payer-acknowledgment'],
    ['enrolled', 'test-transaction'],
  ] as const;
  steps.forEach(([to, kind], index) => {
    seq += 1;
    const when = at[index] ?? '2026-01-03T00:00:00Z';
    registry.transition({
      payerId,
      pathId,
      transaction,
      to,
      at: when,
      actor: 'enroll-admin-1',
      reason: 'synthetic enrollment',
      evidence: [{ evidenceId: `div-${seq}`, kind, capturedAt: when, synthetic: true }],
    });
  });
}

/** ch-sim-B re-declared as riding the same upstream as ch-sim-A: two logos, one failure mode. */
const sharedCatalog = new PathCatalog(
  DEFAULT_PATH_CATALOG.map((descriptor) =>
    descriptor.pathId === 'ch-sim-B'
      ? { ...descriptor, upstreams: ['upstream-sim-omega', 'upstream-sim-alpha'] }
      : descriptor,
  ),
);

const claimsRoute: PathRoute = {
  payerId: 'payer-1',
  purpose: 'claims',
  primary: 'ch-sim-A',
  secondary: 'ch-sim-B',
  requiredTransactions: ['837'],
};

describe('WP-091 payer-path diversity verification', () => {
  it('flags a primary and secondary path that share one upstream', () => {
    const [result] = verifyPayerPathDiversity([claimsRoute], sharedCatalog);
    expect(result?.diverse).toBe(false);
    expect(result?.sharedUpstreams).toEqual(['upstream-sim-alpha']);
    expect(result?.findings.map((finding) => `${finding.code}:${finding.severity}`)).toEqual([
      'shared-upstream:block',
    ]);
  });

  it('passes the same topology when the upstreams are distinct (control for the check above)', () => {
    const [result] = verifyPayerPathDiversity([claimsRoute], new PathCatalog());
    expect(result?.diverse).toBe(true);
    expect(result?.sharedUpstreams).toEqual([]);
    expect(result?.findings).toEqual([]);
  });

  it('flags same-path and single-homed routes', () => {
    const results = verifyPayerPathDiversity(
      [
        { ...claimsRoute, payerId: 'payer-same', secondary: 'ch-sim-A' },
        { ...claimsRoute, payerId: 'payer-single', secondary: null },
      ],
      new PathCatalog(),
    );
    expect(
      results.map((result) => [result.payerId, result.diverse, result.findings.map((f) => f.code)]),
    ).toEqual([
      ['payer-same', false, ['same-path']],
      ['payer-single', false, ['single-homed']],
    ]);
  });

  it('with a registry, a secondary that is not enrolled is not a real alternative', () => {
    const registry = new EnrollmentRegistry();
    enrollOn(registry, 'payer-1', 'ch-sim-A', '837');
    const [before] = verifyPayerPathDiversity([claimsRoute], registry.pathCatalog(), registry);
    expect(before?.diverse).toBe(false);
    expect(before?.findings.map((finding) => finding.code)).toEqual(['secondary-not-enrolled']);

    enrollOn(registry, 'payer-1', 'ch-sim-B', '837');
    const [after] = verifyPayerPathDiversity([claimsRoute], registry.pathCatalog(), registry);
    expect(after?.diverse).toBe(true);
    expect(after?.findings).toEqual([]);
  });

  it('reports a primary-leg gap without denying that the secondary is real', () => {
    const registry = new EnrollmentRegistry();
    enrollOn(registry, 'payer-1', 'ch-sim-B', '837');
    const [result] = verifyPayerPathDiversity([claimsRoute], registry.pathCatalog(), registry);
    expect(result?.diverse).toBe(true);
    expect(result?.findings.map((finding) => `${finding.leg}:${finding.code}`)).toEqual([
      'primary:primary-not-enrolled',
    ]);
  });

  it('flags a secondary that cannot carry the required transaction', () => {
    const [result] = verifyPayerPathDiversity(
      [
        {
          payerId: 'payer-1',
          purpose: 'claims',
          primary: 'ch-sim-A',
          secondary: 'payerportal-sim',
          requiredTransactions: ['837'],
        },
      ],
      new PathCatalog(),
    );
    expect(result?.diverse).toBe(false);
    expect(result?.findings.map((finding) => `${finding.leg}:${finding.code}`)).toEqual([
      'secondary:unsupported-transaction',
    ]);
  });

  it('adapts WP-085 router routes as 837 claim routes', () => {
    const routes: PayerRoute[] = [
      {
        payerId: 'payer-1',
        primary: 'ch-sim-A',
        secondary: 'ch-sim-B',
        enrolledTransactions: ['837'],
      },
      {
        payerId: 'payer-2',
        primary: 'ch-sim-B',
        secondary: null,
        enrolledTransactions: ['837', '835'],
      },
    ];
    const adapted = fromRouterRoutes(routes);
    expect(adapted).toEqual([
      {
        payerId: 'payer-1',
        purpose: 'claims',
        primary: 'ch-sim-A',
        secondary: 'ch-sim-B',
        requiredTransactions: ['837'],
      },
      {
        payerId: 'payer-2',
        purpose: 'claims',
        primary: 'ch-sim-B',
        secondary: null,
        requiredTransactions: ['837'],
      },
    ]);
    const results = verifyPayerPathDiversity(adapted, sharedCatalog);
    expect(results.map((result) => result.diverse)).toEqual([false, false]);
  });

  it('refuses a duplicate payer/purpose route and a route without transactions', () => {
    expect(() => verifyPayerPathDiversity([claimsRoute, claimsRoute], new PathCatalog())).toThrow(
      /one route per payer/,
    );
    expect(() =>
      verifyPayerPathDiversity([{ ...claimsRoute, requiredTransactions: [] }], new PathCatalog()),
    ).toThrow(/name the transactions/);
  });

  it('refuses a catalog path that is not simulated or has no upstream', () => {
    const base = DEFAULT_PATH_CATALOG[0];
    if (!base) {
      throw new Error('catalog fixture missing');
    }
    expect(() => new PathCatalog([{ ...base, upstreams: [] }])).toThrow(
      /at least one token upstream/,
    );
    expect(() => new PathCatalog([{ ...base, simulated: false as unknown as true }])).toThrow(
      /only simulated paths/,
    );
  });
});
