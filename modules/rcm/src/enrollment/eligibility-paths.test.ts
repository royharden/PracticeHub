import { describe, expect, it } from 'vitest';

import { createEligibilityPort } from '../eligibility.js';

import {
  collectEligibilityAnswers,
  createSimulatedEligibilityPath,
  tableResponder,
  THIRD_ELIGIBILITY_PATH_ID,
  type EligibilityQuery,
} from './eligibility-paths.js';
import { PathCatalog, type PathId } from './paths.js';
import { EnrollmentRegistry } from './registry.js';

let seq = 0;
function enroll270(registry: EnrollmentRegistry, pathId: PathId): void {
  const steps = [
    ['requested', 'enrollment-request', '2026-01-01T00:00:00Z'],
    ['pending-payer', 'payer-acknowledgment', '2026-01-02T00:00:00Z'],
    ['enrolled', 'test-transaction', '2026-01-03T00:00:00Z'],
  ] as const;
  for (const [to, kind, at] of steps) {
    seq += 1;
    registry.transition({
      payerId: 'payer-1',
      pathId,
      transaction: '270/271',
      to,
      at,
      actor: 'enroll-admin-1',
      reason: 'synthetic',
      evidence: [{ evidenceId: `el-${seq}`, kind, capturedAt: at, synthetic: true }],
    });
  }
}

const catalog = new PathCatalog();
const query: EligibilityQuery = {
  payerId: 'payer-1',
  memberRef: 'member-synthetic-1',
  requestedAt: '2026-03-01T09:00:00Z',
};

describe('WP-091 named third eligibility path (Availity-class)', () => {
  it('names availity-sim as the third path and it carries 270/271', () => {
    expect(THIRD_ELIGIBILITY_PATH_ID).toBe('availity-sim');
    expect(catalog.get(THIRD_ELIGIBILITY_PATH_ID).kind).toBe('eligibility-supplement');
    expect(catalog.supports(THIRD_ELIGIBILITY_PATH_ID, '270/271')).toBe(true);
  });

  it('queries only enrolled paths and feeds the WP-081 port a clean yes', () => {
    const registry = new EnrollmentRegistry();
    enroll270(registry, 'payerportal-sim');
    enroll270(registry, 'availity-sim');
    const yes = tableResponder(['member-synthetic-1']);
    const paths = [
      createSimulatedEligibilityPath('ch-sim-A', catalog, yes),
      createSimulatedEligibilityPath('payerportal-sim', catalog, yes),
      createSimulatedEligibilityPath('availity-sim', catalog, yes),
    ];
    const collected = collectEligibilityAnswers(registry, paths, query);
    expect(collected.skipped).toEqual([{ pathId: 'ch-sim-A', reason: 'not-enrolled' }]);
    expect(collected.answers).toEqual([
      { sourceId: 'payerportal-sim', receivedAt: '2026-03-01T09:00:01Z', covered: true },
      { sourceId: 'availity-sim', receivedAt: '2026-03-01T09:00:01Z', covered: true },
    ]);

    const decision = createEligibilityPort().check({
      checkpoint: 'booking',
      now: '2026-03-01T10:00:00Z',
      answers: collected.answers,
      coverage: {
        packageId: 'WP-040',
        appointmentId: 'appt-synthetic-1',
        tenantId: 'tenant-synthetic',
        checkpoint: 'booking',
        serviceAt: '2026-03-02T09:00:00Z',
      },
    });
    expect(decision.disposition).toBe('eligible');
    expect(decision.cleanYes).toBe(true);
  });

  it('keeps answering through the third path when another path is down', () => {
    const registry = new EnrollmentRegistry();
    enroll270(registry, 'payerportal-sim');
    enroll270(registry, 'availity-sim');
    const collected = collectEligibilityAnswers(
      registry,
      [
        createSimulatedEligibilityPath('payerportal-sim', catalog, () => ({ kind: 'outage' })),
        createSimulatedEligibilityPath('availity-sim', catalog, tableResponder([])),
      ],
      query,
    );
    expect(collected.skipped).toEqual([{ pathId: 'payerportal-sim', reason: 'outage' }]);
    expect(collected.answers).toEqual([
      { sourceId: 'availity-sim', receivedAt: '2026-03-01T09:00:01Z', covered: false },
    ]);
  });

  it('refuses a path without 270/271, a repeated path and a response before its request', () => {
    expect(() =>
      createSimulatedEligibilityPath(
        'ch-sim-B',
        new PathCatalog([
          {
            pathId: 'ch-sim-B',
            kind: 'clearinghouse',
            upstreams: ['upstream-sim-beta'],
            transactions: ['837'],
            simulated: true,
          },
        ]),
        tableResponder([]),
      ),
    ).toThrow(/does not carry 270\/271/);

    const registry = new EnrollmentRegistry();
    enroll270(registry, 'availity-sim');
    const path = createSimulatedEligibilityPath('availity-sim', catalog, tableResponder([]));
    expect(() => collectEligibilityAnswers(registry, [path, path], query)).toThrow(/asked once/);
    const early = createSimulatedEligibilityPath('availity-sim', catalog, () => ({
      kind: 'answer',
      covered: true,
      respondedAt: '2026-03-01T08:00:00Z',
    }));
    expect(() => collectEligibilityAnswers(registry, [early], query)).toThrow(
      /precede its request/,
    );
  });
});
