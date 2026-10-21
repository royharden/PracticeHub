import { describe, expect, it } from 'vitest';

import type { CarcAdjustment } from './carc.js';
import {
  DenialQueues,
  type DenialClaimRef,
  type DenialIntake,
  type PayerDeadlinePolicy,
} from './queue.js';

const T = 'tenant-synthetic';

const policies: PayerDeadlinePolicy[] = [
  { payerId: 'payer-1', appealWindowDays: 60, timelyFilingDays: 90 },
  { payerId: 'payer-2', appealWindowDays: 180, timelyFilingDays: 365 },
];

function claim(
  id: string,
  payerId = 'payer-1',
  totalMinor = 100_000,
  tenantId = T,
): DenialClaimRef {
  return {
    claimId: id,
    tenantId,
    payerId,
    controlNumber: `ctl-${id}`,
    totalMinor,
    state: 'finalized',
  };
}

function intake(
  denialId: string,
  code: string,
  deniedMinor: number,
  overrides: Partial<DenialIntake> = {},
): DenialIntake {
  const adjustments: CarcAdjustment[] = [{ group: 'CO', code, amountMinor: deniedMinor }];
  return {
    denialId,
    claim: claim(`claim-${denialId}`),
    adjustments,
    rarcs: [],
    deniedMinor,
    serviceDate: '2026-01-05',
    remitReceivedAt: '2026-02-01T00:00:00Z',
    ...overrides,
  };
}

describe('WP-088 denial queues and filing deadlines', () => {
  it('tracks both limits on every item; the earliest binds', () => {
    const queues = new DenialQueues(policies);
    const appeal = queues.intake(intake('d-1', '50', 40_000));
    expect(appeal.queue).toBe('medical-necessity');
    expect(appeal.deadlines).toEqual([
      { source: 'appeal-window', at: '2026-04-02T00:00:00Z' },
      { source: 'timely-filing', at: '2026-04-05T00:00:00Z' },
    ]);
    expect(appeal.deadline).toBe('2026-04-02T00:00:00Z');
    expect(appeal.deadlineSource).toBe('appeal-window');
    const filing = queues.intake(intake('d-2', '29', 40_000, { serviceDate: '2025-12-20' }));
    expect(filing.queue).toBe('timely-filing');
    expect(filing.deadline).toBe('2026-03-20T00:00:00Z');
    expect(filing.deadlineSource).toBe('timely-filing');
  });

  // F2: the corrected-claim filing limit binds when it falls before the appeal window.
  it('F2: a CO-4 denial is bound by timely filing when it comes before the appeal window', () => {
    const queues = new DenialQueues([
      { payerId: 'payer-1', appealWindowDays: 180, timelyFilingDays: 90 },
    ]);
    const item = queues.intake(
      intake('co4', '4', 20_000, {
        serviceDate: '2026-01-01',
        remitReceivedAt: '2026-03-01T00:00:00Z',
      }),
    );
    expect(item.queue).toBe('coding-review');
    expect(item.deadline).toBe('2026-04-01T00:00:00Z');
    expect(item.deadlineSource).toBe('timely-filing');
    const atRisk = queues.worklist(T, '2026-03-20T00:00:00Z')[0];
    expect(atRisk).toMatchObject({
      band: 'at-risk',
      activeDeadlineSource: 'timely-filing',
      daysToDeadline: 12,
    });
    // Once timely filing passes the item is flagged missed at the top, with the appeal window
    // still shown as the remaining avenue: the lapsed limit is never silently dropped.
    const lapsed = queues.worklist(T, '2026-04-10T00:00:00Z')[0];
    expect(lapsed).toMatchObject({
      band: 'missed',
      lapsed: ['timely-filing'],
      activeDeadline: '2026-08-28T00:00:00Z',
      activeDeadlineSource: 'appeal-window',
    });
  });

  it('F2: a corrected resubmission after the filing limit is recorded as past deadline', () => {
    const queues = new DenialQueues([
      { payerId: 'payer-1', appealWindowDays: 180, timelyFilingDays: 90 },
    ]);
    queues.intake(
      intake('co4', '4', 20_000, {
        serviceDate: '2026-01-01',
        remitReceivedAt: '2026-03-01T00:00:00Z',
      }),
    );
    const done = queues.resolve(
      T,
      'co4',
      'corrected-resubmitted',
      '2026-04-10T00:00:00Z',
      'coder-1',
      'fixed modifier',
    );
    expect(done.resolvedPastDeadline).toBe(true);
  });

  it('never loses a deadline for a payer with no policy: a short conservative deadline is flagged', () => {
    const queues = new DenialQueues(policies);
    const item = queues.intake(
      intake('d-1', '50', 40_000, { claim: claim('claim-x', 'payer-unknown') }),
    );
    expect(item.deadlineSource).toBe('conservative-default');
    expect(item.deadline).toBe('2026-03-03T00:00:00Z');
  });

  it('sorts deadline-at-risk items first, then open items by weighted dollars', () => {
    const queues = new DenialQueues(policies, 14);
    queues.intake(intake('big-far', '11', 90_000, { claim: claim('c-big', 'payer-2') }));
    // payer-1: appeal 04-02 binds (filing 04-05): 8 days on 03-25.
    queues.intake(intake('small-near', '50', 1_000));
    // CARC 29 with an older service date: filing 01-01 + 90d = 04-01 binds: 7 days.
    queues.intake(intake('filing-near', '29', 5_000, { serviceDate: '2026-01-01' }));
    queues.intake(intake('mid-far', '16', 50_000, { claim: claim('c-mid', 'payer-2') }));
    const list = queues.worklist(T, '2026-03-25T00:00:00Z');
    expect(
      list.map(
        (entry) => `${entry.denialId}:${entry.band}:${entry.daysToDeadline}:${entry.weightedMinor}`,
      ),
    ).toEqual([
      'filing-near:at-risk:7:1500',
      'small-near:at-risk:8:600',
      'big-far:on-track:128:72000',
      'mid-far:on-track:128:42500',
    ]);
  });

  it('keeps a missed deadline at the top of the worklist until someone resolves it', () => {
    const queues = new DenialQueues(policies);
    queues.intake(intake('late', '50', 1_000));
    queues.intake(
      intake('fresh', '50', 90_000, {
        remitReceivedAt: '2026-04-01T00:00:00Z',
        serviceDate: '2026-03-20',
      }),
    );
    const list = queues.worklist(T, '2026-04-10T00:00:00Z');
    expect(list.map((entry) => `${entry.denialId}:${entry.band}`)).toEqual([
      'late:missed',
      'fresh:on-track',
    ]);
    queues.resolve(
      T,
      'late',
      'written-off',
      '2026-04-10T00:00:00Z',
      'rcm-lead-1',
      'deadline passed',
    );
    expect(queues.get(T, 'late').resolvedPastDeadline).toBe(true);
    expect(queues.worklist(T, '2026-04-10T00:00:00Z').map((entry) => entry.denialId)).toEqual([
      'fresh',
    ]);
    expect(queues.all(T).map((item) => item.denialId)).toEqual(['late', 'fresh']);
  });

  it('never changes a computed deadline and never drops an item on routing or listing', () => {
    const queues = new DenialQueues(policies);
    const first = queues.intake(intake('d-1', '999', 5_000));
    for (let day = 1; day <= 28; day += 1) {
      queues.worklist(T, `2026-02-${String(day).padStart(2, '0')}T00:00:00Z`);
      queues.worklist(T, `2026-02-${String(day).padStart(2, '0')}T00:00:00Z`, 'general-review');
    }
    expect(queues.get(T, 'd-1').deadline).toBe(first.deadline);
    expect(queues.get(T, 'd-1').deadlines).toEqual(first.deadlines);
    expect(
      queues.worklist(T, '2026-02-28T00:00:00Z', 'general-review').map((entry) => entry.denialId),
    ).toEqual(['d-1']);
  });

  it('filters the worklist by queue', () => {
    const queues = new DenialQueues(policies);
    queues.intake(intake('d-1', '50', 5_000));
    queues.intake(intake('d-2', '197', 5_000));
    expect(
      queues.worklist(T, '2026-02-02T00:00:00Z', 'authorization').map((entry) => entry.denialId),
    ).toEqual(['d-2']);
  });

  // F3: an unanswered appeal comes back for follow-up.
  it('F3: an appealed item returns to the worklist when its follow-up falls due', () => {
    const queues = new DenialQueues([
      { payerId: 'payer-1', appealWindowDays: 60, timelyFilingDays: 90, appealResponseDays: 30 },
    ]);
    queues.intake(intake('d-1', '50', 5_000));
    const appealed = queues.markAppealed(T, 'd-1', '2026-02-10T00:00:00Z', 'rcm-lead-1');
    expect(appealed.followUpAt).toBe('2026-03-12T00:00:00Z');
    expect(queues.worklist(T, '2026-03-11T00:00:00Z')).toEqual([]);
    expect(
      queues.worklist(T, '2026-03-12T00:00:00Z').map((entry) => `${entry.denialId}:${entry.band}`),
    ).toEqual(['d-1:appeal-follow-up']);
  });

  it('only resolves an appealed denial by its appeal outcome, and vice versa', () => {
    const queues = new DenialQueues(policies);
    queues.intake(intake('d-1', '50', 5_000));
    expect(() =>
      queues.resolve(T, 'd-1', 'paid-on-appeal', '2026-02-02T00:00:00Z', 'rcm-lead-1', 'x'),
    ).toThrow(/needs an appealed denial/);
    queues.markAppealed(T, 'd-1', '2026-02-02T00:00:00Z', 'rcm-lead-1');
    expect(() =>
      queues.resolve(T, 'd-1', 'written-off', '2026-02-03T00:00:00Z', 'rcm-lead-1', 'x'),
    ).toThrow(/resolves by its appeal outcome/);
    const done = queues.resolve(
      T,
      'd-1',
      'paid-on-appeal',
      '2026-03-01T00:00:00Z',
      'rcm-lead-1',
      'payer reversed',
    );
    expect(done.status).toBe('resolved');
    expect(done.log).toHaveLength(3);
  });

  it('refuses patient-responsibility and duplicate appeals, bad claim states and bad amounts', () => {
    const queues = new DenialQueues(policies);
    queues.intake({
      ...intake('pr', '1', 5_000),
      adjustments: [{ group: 'PR', code: '1', amountMinor: 5_000 }],
    });
    queues.intake(intake('dup', '18', 5_000));
    expect(() => queues.markAppealed(T, 'pr', '2026-02-02T00:00:00Z', 'a-1')).toThrow(
      /not appealable/,
    );
    expect(() => queues.markAppealed(T, 'dup', '2026-02-02T00:00:00Z', 'a-1')).toThrow(
      /not appealable/,
    );
    expect(() => queues.intake(intake('dup', '18', 5_000))).toThrow(/already queued/);
    expect(() =>
      queues.intake(
        intake('bad-state', '50', 5_000, { claim: { ...claim('c'), state: 'submitted' } }),
      ),
    ).toThrow(/has no remit denial/);
    expect(() => queues.intake(intake('too-big', '50', 200_000))).toThrow(/within the claim total/);
    expect(() =>
      queues.intake(intake('future-dos', '50', 5_000, { serviceDate: '2026-03-01' })),
    ).toThrow(/after the remit/);
  });

  // F4: a 277CA front-end rejection is not a remit denial.
  it('F4: refuses a payer-rejected (277CA) claim as a remit denial', () => {
    const queues = new DenialQueues(policies);
    expect(() =>
      queues.intake(
        intake('fe', '16', 5_000, { claim: { ...claim('c-fe'), state: 'payer-rejected' } }),
      ),
    ).toThrow(/payer-rejected claim has no remit denial/);
    expect(
      queues.intake(
        intake('ok', '16', 5_000, { claim: { ...claim('c-ok'), state: 'payer-accepted' } }),
      ).status,
    ).toBe('open');
  });

  it('refuses a malformed policy set', () => {
    expect(() => new DenialQueues([...policies, policies[0] as PayerDeadlinePolicy])).toThrow(
      /one deadline policy/,
    );
    expect(
      () => new DenialQueues([{ payerId: 'p', appealWindowDays: 0, timelyFilingDays: 1 }]),
    ).toThrow(/positive day counts/);
    expect(
      () =>
        new DenialQueues([
          { payerId: 'p', appealWindowDays: 1, timelyFilingDays: 1, appealResponseDays: 0 },
        ]),
    ).toThrow(/positive day counts/);
  });
});

// F1: tenant scoping.
describe('WP-088 tenant scoping (F1)', () => {
  it('keys items by tenant: the same denial id in two tenants is two items, not a duplicate', () => {
    const queues = new DenialQueues(policies);
    queues.intake(
      intake('d-1', '50', 5_000, { claim: claim('c-a', 'payer-1', 100_000, 'tenant-a') }),
    );
    const other = queues.intake(
      intake('d-1', '197', 7_000, { claim: claim('c-b', 'payer-1', 100_000, 'tenant-b') }),
    );
    expect(other.tenantId).toBe('tenant-b');
    expect(queues.get('tenant-a', 'd-1').queue).toBe('medical-necessity');
    expect(queues.get('tenant-b', 'd-1').queue).toBe('authorization');
  });

  it('scopes the worklist and the item history to one tenant', () => {
    const queues = new DenialQueues(policies);
    queues.intake(
      intake('a-1', '50', 5_000, { claim: claim('c-a', 'payer-1', 100_000, 'tenant-a') }),
    );
    queues.intake(
      intake('b-1', '50', 5_000, { claim: claim('c-b', 'payer-1', 100_000, 'tenant-b') }),
    );
    expect(
      queues.worklist('tenant-a', '2026-02-02T00:00:00Z').map((entry) => entry.denialId),
    ).toEqual(['a-1']);
    expect(queues.all('tenant-b').map((item) => item.denialId)).toEqual(['b-1']);
  });

  it("reads another tenant's id exactly like an id that does not exist", () => {
    const queues = new DenialQueues(policies);
    queues.intake(
      intake('a-1', '50', 5_000, { claim: claim('c-a', 'payer-1', 100_000, 'tenant-a') }),
    );
    let foreign = '';
    let missing = '';
    try {
      queues.get('tenant-b', 'a-1');
    } catch (error) {
      foreign = error instanceof Error ? error.message : '';
    }
    try {
      queues.get('tenant-b', 'never-existed');
    } catch (error) {
      missing = error instanceof Error ? error.message : '';
    }
    expect(foreign).toBe('denial is not queued');
    expect(foreign).toBe(missing);
    expect(() => queues.markAppealed('tenant-b', 'a-1', '2026-02-02T00:00:00Z', 'x-1')).toThrow(
      /not queued/,
    );
    expect(() =>
      queues.resolve('tenant-b', 'a-1', 'written-off', '2026-02-02T00:00:00Z', 'x-1', 'x'),
    ).toThrow(/not queued/);
    expect(queues.get('tenant-a', 'a-1').status).toBe('open');
  });
});
