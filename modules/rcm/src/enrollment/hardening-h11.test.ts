/**
 * WP-091 hardening H-11 (NR-111..NR-114). Each regression fails on candidates/D51-WP-091-a1.
 */
import { describe, expect, it } from 'vitest';

import { verifyPayerPathDiversity } from './diversity.js';
import { PathCatalog, type PathDescriptor } from './paths.js';
import { ENROLLMENT_TRANSITIONS, EnrollmentRegistry, type EvidenceKind } from './registry.js';
import { sweepEnrollment } from './sweep.js';

const key = { payerId: 'payer-h11', pathId: 'ch-sim-A', transaction: '837' } as const;

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).name;
  }
  return 'NO_ERROR';
}

function request(
  evidenceId: string,
  kind: string,
  to: 'requested' | 'pending-payer' = 'requested',
) {
  return {
    ...key,
    to,
    at: '2026-01-02T00:00:00Z',
    actor: 'enroll-admin-1',
    reason: 'synthetic',
    evidence: [
      {
        evidenceId,
        kind: kind as EvidenceKind,
        capturedAt: '2026-01-01T00:00:00Z',
        synthetic: true as const,
      },
    ],
  };
}

describe('NR-111: the transition table and history are immutable', () => {
  it('ENROLLMENT_TRANSITIONS and every list in it are runtime-frozen', () => {
    expect(Object.isFrozen(ENROLLMENT_TRANSITIONS)).toBe(true);
    for (const next of Object.values(ENROLLMENT_TRANSITIONS)) {
      expect(Object.isFrozen(next)).toBe(true);
    }
    expect(() => {
      (ENROLLMENT_TRANSITIONS['not-enrolled'] as string[]).push('enrolled');
    }).toThrow(TypeError);
    const registry = new EnrollmentRegistry();
    expect(
      codeOf(() =>
        registry.transition({ ...request('h11-t1', 'payer-approval'), to: 'enrolled' as never }),
      ),
    ).toBe('ENROLLMENT_TRANSITION');
  });

  it('a returned history entry or its evidence cannot change the registry', () => {
    const registry = new EnrollmentRegistry();
    const record = registry.transition(request('h11-h1', 'enrollment-request'));
    const entry = record.history[0];
    if (entry === undefined) throw new Error('no history');
    const tries = [
      () => {
        (entry as { to: string }).to = 'enrolled';
      },
      () => {
        (entry.evidence as unknown[]).push({ evidenceId: 'forged', kind: 'payer-approval' });
      },
      () => {
        (entry.evidence[0] as { kind: string }).kind = 'payer-approval';
      },
    ];
    for (const attempt of tries) {
      try {
        attempt();
      } catch {
        // frozen: the write is refused
      }
    }
    const stored = registry.get(key).history[0];
    expect(stored?.to).toBe('requested');
    expect(stored?.evidence).toEqual([
      {
        evidenceId: 'h11-h1',
        kind: 'enrollment-request',
        capturedAt: '2026-01-01T00:00:00Z',
        synthetic: true,
      },
    ]);
  });
});

describe('NR-112: evidence kind is checked at runtime', () => {
  it('refuses an unknown evidence kind and records nothing', () => {
    const registry = new EnrollmentRegistry();
    expect(codeOf(() => registry.transition(request('h11-k1', 'bogus')))).toBe(
      'ENROLLMENT_EVIDENCE',
    );
    expect(registry.get(key).state).toBe('not-enrolled');
    expect(registry.list()).toEqual([]);
  });
});

const sharedCatalog = (primaryUpstream: string, secondaryUpstream: string): PathCatalog => {
  const descriptors: PathDescriptor[] = [
    {
      pathId: 'ch-sim-A',
      kind: 'clearinghouse',
      upstreams: [primaryUpstream],
      transactions: ['837'],
      simulated: true,
    },
    {
      pathId: 'ch-sim-B',
      kind: 'clearinghouse',
      upstreams: [secondaryUpstream],
      transactions: ['837'],
      simulated: true,
    },
  ];
  return new PathCatalog(descriptors);
};

const route = {
  payerId: 'payer-h11',
  purpose: 'claims' as const,
  primary: 'ch-sim-A' as const,
  secondary: 'ch-sim-B' as const,
  requiredTransactions: ['837' as const],
};

describe('NR-114: upstream labels compare after trim and case-fold', () => {
  it('finds a shared upstream written in a different case', () => {
    const [result] = verifyPayerPathDiversity(
      [route],
      sharedCatalog('Upstream-Sim-Shared', 'upstream-sim-SHARED'),
    );
    expect(result?.diverse).toBe(false);
    expect(result?.sharedUpstreams).toEqual(['upstream-sim-shared']);
    expect(result?.findings.map((finding) => finding.code)).toContain('shared-upstream');
  });
});

describe('NR-113: the sweep drives a real shared-upstream finding', () => {
  it('surfaces a shared-upstream secondary on the sweep worklist (same label)', () => {
    const registry = new EnrollmentRegistry(
      sharedCatalog('upstream-sim-shared', 'upstream-sim-shared'),
    );
    const report = sweepEnrollment(registry, '2026-02-15T00:00:00Z', [route]);
    expect(report.items.map((item) => item.detail)).toContain(
      'claims shared-upstream: ch-sim-A and ch-sim-B share upstream upstream-sim-shared',
    );
  });

  it('surfaces a shared upstream written in a different case on the sweep worklist', () => {
    const registry = new EnrollmentRegistry(
      sharedCatalog('UPSTREAM-sim-shared', 'upstream-sim-shared'),
    );
    const report = sweepEnrollment(registry, '2026-02-15T00:00:00Z', [route]);
    expect(report.items.some((item) => item.detail.startsWith('claims shared-upstream:'))).toBe(
      true,
    );
  });
});
