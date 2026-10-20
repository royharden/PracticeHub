import { describe, expect, it } from 'vitest';

import { ConsumerRightsError, type MembershipView } from './contracts.js';
import {
  cancelFlowViolations,
  cancelMembership,
  entitledOn,
  parseRenewalRules,
  RENEWAL_RULES_V1,
  renewalNotice,
  resolveRenewalPolicy,
  shouldAutoRenew,
  type CancelFlow,
} from './renewal.js';

const membership = (overrides: Partial<MembershipView> = {}): MembershipView => ({
  packageId: 'WP-052',
  tenantId: 'northwind-synthetic',
  membershipId: 'synthetic-membership-0401',
  personRef: 'synthetic-person-0401',
  status: 'active',
  renewalDate: '2026-12-01T00:00:00.000Z',
  termMonths: 12,
  priceMinor: 250_000,
  stateOfRecord: 'NV',
  priorStateOfRecord: null,
  vintageRef: 'synthetic-vintage-2026',
  ...overrides,
});

function code(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof ConsumerRightsError) return error.code;
    throw error;
  }
  return 'NO_ERROR';
}

describe('renewal reminder config (R6-SR-070, REQ-MEM-066)', () => {
  it('applies the CA-grade baseline where the state has no stricter rule', () => {
    const policy = resolveRenewalPolicy(membership());
    expect(policy.appliedStates).toEqual([]);
    expect(policy.rule.reminderMaxDaysBefore).toBe(45);
    expect(policy.rule.reminderMinDaysBefore).toBe(15);
    const notice = renewalNotice(membership(), policy, '2026-11-01T00:00:00.000Z');
    expect(notice.windowOpens).toBe('2026-10-17T00:00:00.000Z');
    expect(notice.windowCloses).toBe('2026-11-16T00:00:00.000Z');
    expect(notice.due).toBe(true);
    expect(Object.keys(notice.content)).toEqual(['price', 'renewal-date', 'cancel-how-to']);
    expect(renewalNotice(membership(), policy, '2026-10-01T00:00:00.000Z').due).toBe(false);
    expect(renewalNotice(membership(), policy, '2026-11-20T00:00:00.000Z').due).toBe(false);
  });

  it('intersects the windows and unions the content of a stricter state', () => {
    const policy = resolveRenewalPolicy(membership({ stateOfRecord: 'IL' }));
    expect(policy.appliedStates).toEqual(['IL']);
    expect([policy.rule.reminderMinDaysBefore, policy.rule.reminderMaxDaysBefore]).toEqual([
      30, 45,
    ]);
    expect(policy.rule.requiredNoticeContent).toContain('term-length');
  });

  it('uses the stricter of prior and current state while a move is unconfirmed (EX1)', () => {
    const policy = resolveRenewalPolicy(
      membership({ stateOfRecord: 'NV', priorStateOfRecord: 'MN' }),
    );
    expect(policy.appliedStates).toEqual(['MN']);
    expect(policy.rule.maxCancelSteps).toBe(2);
    expect(policy.rule.reminderMinDaysBefore).toBe(20);
  });

  it('takes a new rules table as configuration, without a code change (EX2)', () => {
    const rules = parseRenewalRules(
      JSON.parse(
        JSON.stringify({
          ...RENEWAL_RULES_V1,
          version: 'auto-renewal/v2',
          states: {
            ...RENEWAL_RULES_V1.states,
            FL: { ...RENEWAL_RULES_V1.baseline, maxCancelSteps: 1 },
          },
        }),
      ),
    );
    const policy = resolveRenewalPolicy(membership({ stateOfRecord: 'FL' }), rules);
    expect(policy.rulesVersion).toBe('auto-renewal/v2');
    expect(policy.rule.maxCancelSteps).toBe(1);
    expect(
      code(() => parseRenewalRules({ version: 'x', baseline: { reminderMinDaysBefore: 50 } })),
    ).toBe('RENEWAL_RULES');
  });

  it('refuses a rules table with no date satisfying every window', () => {
    const rules = {
      ...RENEWAL_RULES_V1,
      states: {
        IL: { ...RENEWAL_RULES_V1.baseline, reminderMinDaysBefore: 50, reminderMaxDaysBefore: 60 },
      },
    };
    expect(code(() => resolveRenewalPolicy(membership({ stateOfRecord: 'IL' }), rules))).toBe(
      'RENEWAL_WINDOW_CONFLICT',
    );
  });
});

describe('cancel-friction config (R6-SR-071, REQ-MEM-034)', () => {
  const policy = resolveRenewalPolicy(membership());
  const oneStep: CancelFlow = {
    channel: 'online',
    signupSteps: 3,
    steps: [
      { kind: 'confirm-cancel', required: true },
      { kind: 'exit-survey', required: false },
      { kind: 'retention-offer', required: false },
    ],
  };

  it('accepts a one-step online cancel with an optional survey and offer', () => {
    expect(cancelFlowViolations(oneStep, policy)).toEqual([]);
  });

  it('flags phone-only, mandatory agent, forced retention offer, forced survey and step overflow', () => {
    const friction: CancelFlow = {
      channel: 'phone-only',
      signupSteps: 2,
      steps: [
        { kind: 'reauthenticate', required: true },
        { kind: 'retention-offer', required: true },
        { kind: 'agent-chat', required: true },
        { kind: 'exit-survey', required: true },
        { kind: 'confirm-cancel', required: true },
      ],
    };
    expect(cancelFlowViolations(friction, policy)).toEqual([
      'cancellation must be available online',
      'mandatory retention offer',
      'mandatory agent-chat step',
      'exit survey must be optional',
      '5 required steps exceed the cap of 2',
    ]);
  });

  it('confirms the cancellation in writing, ignores an open balance, and a renewal job never reverses it', () => {
    const member = membership();
    const cancellation = cancelMembership(
      member,
      {
        at: '2026-06-10T00:00:00.000Z',
        immediate: false,
        openBalanceMinor: 12_000,
        exitReason: null,
      },
      policy,
    );
    expect(cancellation.effectiveEnd).toBe(member.renewalDate);
    expect(cancellation.confirmation).toContain('written confirmation');
    expect(cancellation.openBalanceMinor).toBe(12_000);
    expect(cancellation.vintageRef).toBe('synthetic-vintage-2026');
    expect(cancellation.winBackFlag).toBe(true);
    expect(entitledOn(cancellation, '2026-11-30T00:00:00.000Z')).toBe(true);
    expect(entitledOn(cancellation, '2026-12-01T00:00:00.000Z')).toBe(false);
    const noticed = [
      {
        tenantId: member.tenantId,
        membershipId: member.membershipId,
        sentAt: '2026-11-01T00:00:00.000Z',
      },
    ];
    expect(
      shouldAutoRenew(member, [cancellation], '2026-12-01T00:00:00.000Z', noticed, policy),
    ).toBe(false);
    expect(shouldAutoRenew(member, [], '2026-12-01T00:00:00.000Z', noticed, policy)).toBe(true);
    expect(
      code(() =>
        cancelMembership(
          membership({ status: 'cancelled' }),
          {
            at: '2026-06-10T00:00:00.000Z',
            immediate: true,
            openBalanceMinor: 0,
            exitReason: null,
          },
          policy,
        ),
      ),
    ).toBe('RENEWAL_CANCELLED');
  });
});
