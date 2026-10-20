/**
 * WP-088 hardening H-12 (NR-153, NR-154). Each regression fails on candidates/D51-WP-088-a2.
 */
import { describe, expect, it } from 'vitest';

import { DenialQueues, type DenialIntake } from './queue.js';
import { AppealThrottle } from './throttle.js';

function intake(denialId: string, tenantId: string, remitReceivedAt: string): DenialIntake {
  return {
    denialId,
    claim: {
      claimId: `claim-${denialId}`,
      tenantId,
      payerId: 'payer-1',
      controlNumber: `ctl-${denialId}`,
      totalMinor: 100_000,
      state: 'finalized',
    },
    adjustments: [{ group: 'CO', code: '50', amountMinor: 1_000 }],
    rarcs: [],
    deniedMinor: 1_000,
    serviceDate: '2026-01-05',
    remitReceivedAt,
  };
}

const policy = [{ payerId: 'payer-1', appealWindowDays: 30, timelyFilingDays: 90 }];

describe('NR-153: the batch-ordering clock is scoped per tenant', () => {
  it("a tenant's batch is not refused because another tenant ran a later batch", () => {
    const queues = new DenialQueues(policy);
    queues.intake(intake('a-1', 'tenant-a', '2026-02-01T00:00:00Z'));
    queues.intake(intake('b-1', 'tenant-b', '2026-02-01T00:00:00Z'));
    const throttle = new AppealThrottle(queues, {
      maxPerPayerPerWindow: 5,
      windowHours: 24,
      maxBatchSize: 50,
    });
    expect(
      throttle.submitBatch('tenant-a', ['a-1'], '2026-02-10T12:00:00Z', 'rcm-lead-1').sent,
    ).toEqual(['a-1']);
    const b = throttle.submitBatch('tenant-b', ['b-1'], '2026-02-10T09:00:00Z', 'rcm-lead-1');
    expect(b.sent).toEqual(['b-1']);
  });

  it('the same tenant still cannot run a batch backwards in time', () => {
    const queues = new DenialQueues(policy);
    queues.intake(intake('a-1', 'tenant-a', '2026-02-01T00:00:00Z'));
    const throttle = new AppealThrottle(queues);
    throttle.submitBatch('tenant-a', ['a-1'], '2026-02-10T12:00:00Z', 'rcm-lead-1');
    expect(() =>
      throttle.submitBatch('tenant-a', [], '2026-02-10T09:00:00Z', 'rcm-lead-1'),
    ).toThrow(/before the previous/);
  });
});

describe('NR-154: a late appeal is flagged on the item', () => {
  it('marks appealedPastDeadline when the appeal is sent after the appeal deadline', () => {
    const queues = new DenialQueues(policy);
    queues.intake(intake('late-1', 'tenant-a', '2026-02-01T00:00:00Z'));
    queues.intake(intake('ontime-1', 'tenant-a', '2026-02-01T00:00:00Z'));
    const late = queues.markAppealed('tenant-a', 'late-1', '2026-03-10T00:00:00Z', 'rcm-lead-1');
    expect(late.appealedPastDeadline).toBe(true);
    expect(late.log.at(-1)).toContain('AFTER APPEAL DEADLINE');
    const onTime = queues.markAppealed(
      'tenant-a',
      'ontime-1',
      '2026-02-10T00:00:00Z',
      'rcm-lead-1',
    );
    expect(onTime.appealedPastDeadline).toBe(false);
    expect(queues.get('tenant-a', 'late-1').appealedPastDeadline).toBe(true);
  });

  it('a freshly queued item has not been appealed late', () => {
    const queues = new DenialQueues(policy);
    expect(
      queues.intake(intake('new-1', 'tenant-a', '2026-02-01T00:00:00Z')).appealedPastDeadline,
    ).toBe(false);
  });
});
