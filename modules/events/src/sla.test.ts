/**
 * SLA engine unit tests (WP-022): timer due math, the honest-breach state
 * machine (RSK-02), escalation-step firing (incl. the William 5h hard escalation),
 * effective-dated policy resolution (reuses the platform-core primitive), and the
 * gated publish domain fn.
 */
import { describe, expect, it } from 'vitest';

import {
  activeElapsedMinutes,
  addSeconds,
  assertPolicyValid,
  computeTimerState,
  dueAtFor,
  planEscalation,
  publishSlaPolicyVersion,
  resolveSlaPolicy,
  SlaError,
  type SlaPolicy,
  type SlaTimer,
} from './sla.js';

const conciergeV1: SlaPolicy = {
  policyId: 'sla-concierge',
  version: 1,
  effectiveOn: '2026-01-01',
  memberTier: 'concierge',
  hoursMode: 'after_hours',
  firstResponseTargetMinutes: 60,
  nextResponseTargetMinutes: 60,
  resolutionTargetMinutes: 240,
  escalationChain: [
    { afterMinutes: 60, action: 'notify_owner', target: 'synthetic-role:owner' },
    { afterMinutes: 60, action: 'notify_supervisor', target: 'synthetic-supervisor:pod-a' },
    { afterMinutes: 300, action: 'notify_supervisor', target: 'synthetic-supervisor:pod-a' },
    { afterMinutes: 300, action: 'mark_priority_high', target: 'synthetic-escalation-queue:pod-a' },
  ],
  quietHoursExempt: true,
};

const conciergeV2: SlaPolicy = {
  ...conciergeV1,
  version: 2,
  effectiveOn: '2026-06-01',
  firstResponseTargetMinutes: 30,
};

describe('timer due math', () => {
  it('addSeconds shifts a UTC instant to the second', () => {
    expect(addSeconds('2026-03-02T08:00:00Z', 3600)).toBe('2026-03-02T09:00:00Z');
  });

  it('dueAtFor is startedAt + the timer target', () => {
    expect(dueAtFor(conciergeV1, 'next_response', '2026-03-02T08:00:00Z')).toBe(
      '2026-03-02T09:00:00Z',
    );
  });

  it('dueAtFor throws for a timer the policy does not define (null resolution target)', () => {
    const noResolution: SlaPolicy = { ...conciergeV1, resolutionTargetMinutes: null };
    expect(() => dueAtFor(noResolution, 'resolution', '2026-03-02T08:00:00Z')).toThrow(SlaError);
  });
});

describe('honest-breach state machine (RSK-02)', () => {
  const running: SlaTimer = {
    timerType: 'next_response',
    startedAt: '2026-03-02T08:00:00Z',
    dueAt: '2026-03-02T09:00:00Z',
    pausedTotalSeconds: 0,
    state: 'running',
  };

  it('stays running before the due instant', () => {
    expect(computeTimerState(running, '2026-03-02T08:59:00Z')).toBe('running');
  });

  it('breaches once now passes the due instant — and never silently satisfies', () => {
    expect(computeTimerState(running, '2026-03-02T09:00:00Z')).toBe('breached');
    expect(computeTimerState(running, '2026-03-02T13:00:00Z')).toBe('breached');
  });

  it('a pause pushes the breach point out by the paused seconds (auditable)', () => {
    const paused30m: SlaTimer = { ...running, pausedTotalSeconds: 1800 };
    // due 09:00 + 30m paused => breach at 09:30
    expect(computeTimerState(paused30m, '2026-03-02T09:15:00Z')).toBe('running');
    expect(computeTimerState(paused30m, '2026-03-02T09:30:00Z')).toBe('breached');
  });

  it('a met timer is terminal; a paused timer does not advance', () => {
    expect(computeTimerState({ ...running, state: 'met' }, '2026-03-02T13:00:00Z')).toBe('met');
    expect(computeTimerState({ ...running, state: 'paused' }, '2026-03-02T13:00:00Z')).toBe(
      'paused',
    );
  });
});

describe('escalation firing (R8 §5.5 — the William chain)', () => {
  const timer: SlaTimer = {
    timerType: 'next_response',
    startedAt: '2026-03-02T08:00:00Z',
    dueAt: '2026-03-02T09:00:00Z',
    pausedTotalSeconds: 0,
    state: 'running',
  };

  it('fires nothing before the first threshold', () => {
    expect(planEscalation(conciergeV1, timer, '2026-03-02T08:30:00Z')).toHaveLength(0);
  });

  it('fires the target-time steps (owner + supervisor) at 60 minutes, in order', () => {
    const fired = planEscalation(conciergeV1, timer, '2026-03-02T09:00:00Z');
    expect(fired.map((step) => step.step.action)).toEqual(['notify_owner', 'notify_supervisor']);
  });

  it('fires the 5h hard escalation at 300 minutes (William guardrail)', () => {
    const fired = planEscalation(conciergeV1, timer, '2026-03-02T13:00:00Z');
    expect(fired.map((step) => step.step.action)).toEqual([
      'notify_owner',
      'notify_supervisor',
      'notify_supervisor',
      'mark_priority_high',
    ]);
    expect(fired.at(-1)?.step.afterMinutes).toBe(300);
  });

  it('paused time delays escalation — an escalation reflects ACTIVE elapsed only', () => {
    const paused2h: SlaTimer = { ...timer, pausedTotalSeconds: 7200 };
    // 5h wall clock but 2h paused => 3h active => the 5h step has NOT fired.
    expect(activeElapsedMinutes(paused2h, '2026-03-02T13:00:00Z')).toBeCloseTo(180, 5);
    const fired = planEscalation(conciergeV1, paused2h, '2026-03-02T13:00:00Z');
    expect(fired.some((step) => step.step.afterMinutes === 300)).toBe(false);
  });
});

describe('effective-dated policy resolution (reuses the shared primitive)', () => {
  const policies = [conciergeV1, conciergeV2];

  it('selects the highest version effective as-of the date', () => {
    expect(resolveSlaPolicy(policies, 'concierge', '2026-03-01')?.version).toBe(1);
    expect(resolveSlaPolicy(policies, 'concierge', '2026-07-01')?.version).toBe(2);
  });

  it('a future-dated version is inert before its effective date', () => {
    expect(resolveSlaPolicy(policies, 'concierge', '2026-05-31')?.firstResponseTargetMinutes).toBe(
      60,
    );
    expect(resolveSlaPolicy(policies, 'concierge', '2026-06-01')?.firstResponseTargetMinutes).toBe(
      30,
    );
  });

  it('returns undefined for an unknown tier (caller falls back to no-SLA)', () => {
    expect(resolveSlaPolicy(policies, 'no-such-tier', '2026-07-01')).toBeUndefined();
  });
});

describe('policy validation + publish', () => {
  it('rejects an out-of-order escalation chain', () => {
    const bad: SlaPolicy = {
      ...conciergeV1,
      escalationChain: [
        { afterMinutes: 300, action: 'notify_owner', target: 'synthetic-role:owner' },
        { afterMinutes: 60, action: 'notify_supervisor', target: 'synthetic-supervisor:pod-a' },
      ],
    };
    expect(() => assertPolicyValid(bad)).toThrow(SlaError);
  });

  it('publishSlaPolicyVersion validates and returns a grammar-clean config-change audit input', () => {
    const { auditInput } = publishSlaPolicyVersion({
      tenantId: 'northwind-synthetic',
      policy: conciergeV2,
      actorRef: 'synthetic-ops-admin',
      occurredAt: '2026-05-01T00:00:00Z',
    });
    expect(auditInput.stream).toBe('config-change');
    expect(auditInput.detail.config_ref).toBe('sla-policy:sla-concierge:v2');
    expect(auditInput.detail.config_ref).toMatch(/^[a-z0-9][a-z0-9:._-]*$/);
  });

  it('a malformed policy never produces an audit input (fail closed)', () => {
    const bad: SlaPolicy = { ...conciergeV1, firstResponseTargetMinutes: 0 };
    expect(() =>
      publishSlaPolicyVersion({
        tenantId: 'northwind-synthetic',
        policy: bad,
        actorRef: 'synthetic-ops-admin',
        occurredAt: '2026-05-01T00:00:00Z',
      }),
    ).toThrow(SlaError);
  });
});
