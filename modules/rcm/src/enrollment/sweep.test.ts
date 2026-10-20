import { describe, expect, it } from 'vitest';

import type { EnrollmentTransaction, PathId } from './paths.js';
import { EnrollmentRegistry, type EnrollmentState, type EvidenceKind } from './registry.js';
import { sweepEnrollment } from './sweep.js';

let seq = 0;
function walk(
  registry: EnrollmentRegistry,
  payerId: string,
  pathId: PathId,
  transaction: EnrollmentTransaction,
  steps: readonly (readonly [EnrollmentState, EvidenceKind, string])[],
): void {
  for (const [to, kind, at] of steps) {
    seq += 1;
    registry.transition({
      payerId,
      pathId,
      transaction,
      to,
      at,
      actor: 'enroll-admin-1',
      reason: 'synthetic',
      evidence: [{ evidenceId: `sw-${seq}`, kind, capturedAt: at, synthetic: true }],
    });
  }
}

const ENROLLED = [
  ['requested', 'enrollment-request', '2026-01-01T00:00:00Z'],
  ['pending-payer', 'payer-acknowledgment', '2026-01-02T00:00:00Z'],
  ['enrolled', 'payer-approval', '2026-01-05T00:00:00Z'],
] as const;

describe('WP-091 enrollment sweep', () => {
  it('builds an ordered worklist: route gaps, rejections, suspensions, stale pending, stale evidence', () => {
    const registry = new EnrollmentRegistry();
    walk(registry, 'payer-ok', 'ch-sim-A', '837', ENROLLED);
    walk(registry, 'payer-ok', 'ch-sim-B', '837', ENROLLED);
    walk(registry, 'payer-rej', 'ch-sim-A', '837', [
      ['requested', 'enrollment-request', '2026-01-01T00:00:00Z'],
      ['rejected', 'payer-rejection', '2026-01-03T00:00:00Z'],
    ]);
    walk(registry, 'payer-sus', 'ch-sim-B', '835', [
      ...ENROLLED,
      ['suspended', 'suspension-notice', '2026-01-20T00:00:00Z'],
    ]);
    walk(registry, 'payer-slow', 'availity-sim', '270/271', [
      ['requested', 'enrollment-request', '2026-01-01T00:00:00Z'],
    ]);
    walk(registry, 'payer-fresh', 'payerportal-sim', '270/271', [
      ['requested', 'enrollment-request', '2026-02-01T00:00:00Z'],
    ]);

    const report = sweepEnrollment(
      registry,
      '2026-02-15T00:00:00Z',
      [
        {
          payerId: 'payer-ok',
          purpose: 'claims',
          primary: 'ch-sim-A',
          secondary: 'ch-sim-B',
          requiredTransactions: ['837'],
        },
        {
          payerId: 'payer-rej',
          purpose: 'claims',
          primary: 'ch-sim-A',
          secondary: 'ch-sim-B',
          requiredTransactions: ['837'],
        },
      ],
      { pendingMaxDays: 30, evidenceMaxAgeDays: 365 },
    );

    expect(report.recordsSwept).toBe(6);
    expect(
      report.items.map(
        (item) => `${item.code}|${item.payerId}|${item.pathId ?? '-'}|${item.ageDays ?? '-'}`,
      ),
    ).toEqual([
      'route-gap|payer-rej|ch-sim-A|-',
      'route-gap|payer-rej|ch-sim-B|-',
      'rejected-open|payer-rej|ch-sim-A|43',
      'suspended|payer-sus|ch-sim-B|26',
      'stale-pending|payer-slow|availity-sim|45',
    ]);
    expect(report.counts).toEqual({
      'route-gap': 2,
      'rejected-open': 1,
      suspended: 1,
      'stale-pending': 1,
      'evidence-stale': 0,
    });
  });

  it('flags enrolled paths whose newest evidence is older than the policy', () => {
    const registry = new EnrollmentRegistry();
    walk(registry, 'payer-ok', 'ch-sim-A', '837', ENROLLED);
    const fresh = sweepEnrollment(registry, '2026-06-01T00:00:00Z');
    expect(fresh.items).toEqual([]);
    const stale = sweepEnrollment(registry, '2027-02-01T00:00:00Z');
    expect(stale.items.map((item) => `${item.code}:${item.ageDays ?? '-'}`)).toEqual([
      'evidence-stale:392',
    ]);
  });

  it('surfaces a same-path secondary on the sweep worklist', () => {
    const registry = new EnrollmentRegistry();
    const report = sweepEnrollment(registry, '2026-02-15T00:00:00Z', [
      {
        payerId: 'payer-1',
        purpose: 'eligibility',
        primary: 'availity-sim',
        secondary: 'availity-sim',
        requiredTransactions: ['270/271'],
      },
    ]);
    expect(report.items.map((item) => item.detail)).toContain(
      'eligibility same-path: payer-1 eligibility names availity-sim as both primary and secondary',
    );
  });

  it('refuses a sweep instant earlier than a recorded transition and a bad policy', () => {
    const registry = new EnrollmentRegistry();
    walk(registry, 'payer-ok', 'ch-sim-A', '837', ENROLLED);
    expect(() => sweepEnrollment(registry, '2026-01-04T00:00:00Z')).toThrow(
      /after the sweep instant/,
    );
    expect(() =>
      sweepEnrollment(registry, '2026-02-01T00:00:00Z', [], {
        pendingMaxDays: -1,
        evidenceMaxAgeDays: 1,
      }),
    ).toThrow(/non-negative whole days/);
  });
});
