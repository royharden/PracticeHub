/**
 * Obligation-clock engine unit tests (WP-019, ADR-007 D4; C-05). Covers the
 * trigger→due→escalate→evidence lifecycle per obligation type, the strictest-law
 * cascade (FL 30-day breach beats the federal 60-day floor), effective-dated
 * policy selection through the SHARED primitive, and the fail-closed paths.
 */
import { describe, expect, it } from 'vitest';

import {
  addDays,
  cancelClock,
  clockWorkItem,
  computeClockStatus,
  escalateClock,
  foldClocks,
  recordClockSatisfaction,
  resolveObligationClockPolicy,
  rulePackReviewWorkItem,
  runRenewalExpiry,
  triggerClock,
  ClockError,
  type ObligationClockPolicy,
} from './clocks.js';
import { obligationClockPoliciesV1 } from './policy-clock-seed.js';

const policies = obligationClockPoliciesV1;

describe('resolveObligationClockPolicy — strictest-law cascade (C-05)', () => {
  it('FL breach (30-day) beats the federal 60-day floor — shortest deadline is strictest', () => {
    const fl = resolveObligationClockPolicy(policies, 'breach-notification', {
      providerState: 'FL',
      patientState: 'FL',
    });
    expect(fl.durationDays).toBe(30);
    expect(fl.escalationLeadDays).toBe(10);
    expect(fl.defaultsApplied).toBe(false);
  });

  it('an unknown location falls to the federal floor (60-day), never a permissive gap', () => {
    const unknown = resolveObligationClockPolicy(policies, 'breach-notification', {
      providerState: null,
      patientState: null,
    });
    expect(unknown.durationDays).toBe(60);
    expect(unknown.defaultsApplied).toBe(true);
  });

  it('a state with no pack falls to the floor with defaultsApplied (fail-closed)', () => {
    const ca = resolveObligationClockPolicy(policies, 'breach-notification', {
      providerState: 'CA',
      patientState: 'CA',
    });
    expect(ca.durationDays).toBe(60);
    expect(ca.defaultsApplied).toBe(true);
  });

  it('every v1 policy is draft, so a resolution surfaces counselReviewPending', () => {
    const resolution = resolveObligationClockPolicy(policies, 'records-request-closure', {
      providerState: 'IL',
      patientState: 'IL',
    });
    expect(resolution.counselReviewPending).toBe(true);
  });

  it('the mhra-renewal policy is anchor-basis (no durationDays) but carries a lead', () => {
    const resolution = resolveObligationClockPolicy(policies, 'mhra-renewal', {
      providerState: 'MN',
      patientState: 'MN',
    });
    expect(resolution.dueBasis).toBe('anchor');
    expect(resolution.durationDays).toBeUndefined();
    expect(resolution.escalationLeadDays).toBe(30);
  });

  it('registry validation fails closed when an obligation type has no floor policy', () => {
    const broken = policies.filter(
      (policy) =>
        !(policy.obligationType === 'breach-notification' && policy.jurisdiction === 'floor'),
    );
    expect(() =>
      resolveObligationClockPolicy(broken, 'breach-notification', {
        providerState: 'FL',
        patientState: 'FL',
      }),
    ).toThrow(/missing the floor policy/);
  });

  it('a floor policy whose earliest version is not the epoch sentinel is rejected', () => {
    const misdated: ObligationClockPolicy[] = policies.map((policy) =>
      policy.obligationType === 'rule-pack-review' && policy.jurisdiction === 'floor'
        ? { ...policy, effectiveOn: '2026-01-01' }
        : policy,
    );
    expect(() =>
      resolveObligationClockPolicy(misdated, 'rule-pack-review', {
        providerState: null,
        patientState: null,
      }),
    ).toThrow(/epoch sentinel/);
  });
});

describe('effective-dated policy selection (ADR-ADJ-002 shared model)', () => {
  const staged: readonly ObligationClockPolicy[] = [
    ...policies,
    {
      obligationType: 'breach-notification',
      jurisdiction: 'FL',
      version: 2,
      effectiveOn: '2027-01-01',
      status: 'draft',
      changeControlRef: 'wp-019-breach-fl-v2',
      durationDays: 15,
      escalationLeadDays: 5,
      sourceRef: 'fl-stat-501-171-tightened',
      synthetic: true,
    },
  ];

  it('a future-staged FL v2 is inert before its date (v1 30-day governs)', () => {
    const before = resolveObligationClockPolicy(
      staged,
      'breach-notification',
      { providerState: 'FL', patientState: 'FL' },
      '2026-12-31',
    );
    expect(before.durationDays).toBe(30);
  });

  it('the staged FL v2 (15-day) activates on its inclusive effective date', () => {
    const onDate = resolveObligationClockPolicy(
      staged,
      'breach-notification',
      { providerState: 'FL', patientState: 'FL' },
      '2027-01-01',
    );
    expect(onDate.durationDays).toBe(15);
  });
});

describe('breach-notification lifecycle (C-05; WP-098 substrate)', () => {
  it('trigger → due computed from the resolved duration → escalate → satisfy with evidence', () => {
    const { instance, resolution } = triggerClock({
      tenantId: 'northwind-synthetic',
      clockId: 'clk-breach-1',
      clockEventId: 'cle-b-1',
      obligationType: 'breach-notification',
      subjectRef: 'incident:synthetic-1',
      triggerRef: 'incident:synthetic-1',
      triggeredAt: '2026-03-01T00:00:00.000Z',
      actorRef: 'synthetic-officer',
      basis: { providerState: 'FL', patientState: 'FL' },
      policies,
    });
    // FL 30-day: due = trigger + 30d; escalate = due - 10d lead.
    expect(instance.dueAt).toBe(addDays('2026-03-01T00:00:00.000Z', 30));
    expect(instance.escalateAt).toBe(addDays(instance.dueAt, -10));
    expect(instance.status).toBe('pending');
    expect(resolution.durationDays).toBe(30);

    // time-derived status
    expect(computeClockStatus(instance, '2026-03-10T00:00:00.000Z')).toBe('pending');
    expect(computeClockStatus(instance, instance.escalateAt)).toBe('escalated');
    expect(computeClockStatus(instance, instance.dueAt)).toBe('overdue');

    const escalated = escalateClock(instance, {
      clockEventId: 'cle-b-2',
      occurredAt: instance.escalateAt,
      actorRef: 'synthetic-officer',
    });
    expect(escalated.instance.status).toBe('escalated');

    const satisfied = recordClockSatisfaction(escalated.instance, {
      clockEventId: 'cle-b-3',
      occurredAt: '2026-03-20T00:00:00.000Z',
      actorRef: 'synthetic-officer',
      evidenceRef: 'breach-notice:synthetic-1',
    });
    expect(satisfied.instance.status).toBe('satisfied');
    expect(satisfied.instance.closureEvidenceRef).toBe('breach-notice:synthetic-1');
    expect(satisfied.auditInput.stream).toBe('config-change');
    expect(satisfied.auditInput.detail.config_ref).toBe('clock:clk-breach-1');
  });

  it('recording satisfaction without evidence fails closed', () => {
    const { instance } = triggerClock({
      tenantId: 'northwind-synthetic',
      clockId: 'clk-breach-2',
      clockEventId: 'cle-b2-1',
      obligationType: 'breach-notification',
      subjectRef: 'incident:synthetic-2',
      triggerRef: 'incident:synthetic-2',
      triggeredAt: '2026-03-01T00:00:00.000Z',
      actorRef: 'synthetic-officer',
      basis: { providerState: 'FL', patientState: 'FL' },
      policies,
    });
    expect(() =>
      recordClockSatisfaction(instance, {
        clockEventId: 'cle-b2-2',
        occurredAt: '2026-03-05T00:00:00.000Z',
        actorRef: 'synthetic-officer',
        evidenceRef: '',
      }),
    ).toThrow(/evidence-of-completion/);
  });
});

describe('mhra-renewal auto-expire (R6-SR-041)', () => {
  const trigger = () =>
    triggerClock({
      tenantId: 'northwind-synthetic',
      clockId: 'clk-mhra-1',
      clockEventId: 'cle-m-1',
      obligationType: 'mhra-renewal',
      subjectRef: 'np-fx',
      triggerRef: 'consent:nce-x',
      triggeredAt: '2026-01-15T00:00:00.000Z',
      actorRef: 'synthetic-clock',
      basis: { providerState: 'MN', patientState: 'MN' },
      anchorDueAt: '2027-01-15T00:00:00.000Z',
      policies,
    });

  it('anchors due on the consent expiry and escalates a renewal-lead-days window before it', () => {
    const { instance } = trigger();
    expect(instance.dueAt).toBe('2027-01-15T00:00:00.000Z');
    expect(instance.escalateAt).toBe(addDays('2027-01-15T00:00:00.000Z', -30));
  });

  it('auto-fires the consent expire event once the renewal window lapses', () => {
    const { instance } = trigger();
    const outcome = runRenewalExpiry({
      instance,
      asOf: '2027-01-15T00:00:00.000Z',
      renewalRecorded: false,
      personRef: 'np-fx',
      scope: {
        type: 'disclosure',
        purpose: 'treatment',
        recipient: 'synthetic-recipient:fx',
        recordType: 'general',
      },
      jurisdiction: 'MN',
      policyVersion: 'records-consent-v1',
      expireEventId: 'nce-expire-1',
      expireClockEventId: 'cle-m-2',
      actorRef: 'synthetic-clock',
    });
    expect(outcome.fired).toBe(true);
    if (outcome.fired) {
      expect(outcome.consentExpireEvent.action).toBe('expire');
      expect(outcome.consentExpireEvent.effectiveAt).toBe('2027-01-15T00:00:00.000Z');
      expect(outcome.clockEvent.kind).toBe('expire-fired');
    }
  });

  it('a recorded renewal before due cancels the auto-fire (RECOVERY)', () => {
    const { instance } = trigger();
    const outcome = runRenewalExpiry({
      instance,
      asOf: '2027-01-15T00:00:00.000Z',
      renewalRecorded: true,
      personRef: 'np-fx',
      scope: {
        type: 'disclosure',
        purpose: 'treatment',
        recipient: 'synthetic-recipient:fx',
        recordType: 'general',
      },
      jurisdiction: 'MN',
      policyVersion: 'records-consent-v1',
      expireEventId: 'nce-expire-1',
      expireClockEventId: 'cle-m-2',
      actorRef: 'synthetic-clock',
    });
    expect(outcome.fired).toBe(false);
  });

  it('does not fire before the due instant', () => {
    const { instance } = trigger();
    const outcome = runRenewalExpiry({
      instance,
      asOf: '2026-12-01T00:00:00.000Z',
      renewalRecorded: false,
      personRef: 'np-fx',
      scope: {
        type: 'disclosure',
        purpose: 'treatment',
        recipient: 'synthetic-recipient:fx',
        recordType: 'general',
      },
      jurisdiction: 'MN',
      policyVersion: 'records-consent-v1',
      expireEventId: 'nce-expire-1',
      expireClockEventId: 'cle-m-2',
      actorRef: 'synthetic-clock',
    });
    expect(outcome.fired).toBe(false);
    if (!outcome.fired) {
      expect(outcome.reason).toBe('not-yet-due');
    }
  });
});

describe('rule-pack-review WorkItem class (R6-SR-102)', () => {
  it('renders the statute-tracker directive naming its rule-pack scope', () => {
    const { instance } = triggerClock({
      tenantId: 'northwind-synthetic',
      clockId: 'clk-tracker-1',
      clockEventId: 'cle-t-1',
      obligationType: 'rule-pack-review',
      subjectRef: 'rule-pack-scope:all-jurisdictions',
      triggerRef: 'statute-tracker:cycle-1',
      triggeredAt: '2026-01-01T00:00:00.000Z',
      actorRef: 'synthetic-clock',
      basis: { providerState: null, patientState: null },
      policies,
    });
    const workItem = rulePackReviewWorkItem(instance, instance.escalateAt);
    expect(workItem.obligationType).toBe('rule-pack-review');
    expect(workItem.rulePackScopeRef).toBe('rule-pack-scope:all-jurisdictions');
    expect(workItem.directive).toMatch(/re-derive statutes and bump/);
    expect(workItem.ownerRole).toBe('compliance');
    expect(workItem.status).toBe('escalated');
  });

  it('refuses to render a non-tracker clock as a rule-pack-review item', () => {
    const { instance } = triggerClock({
      tenantId: 'northwind-synthetic',
      clockId: 'clk-access-1',
      clockEventId: 'cle-a-1',
      obligationType: 'records-request-closure',
      subjectRef: 'np-fx',
      triggerRef: 'records-request:1',
      triggeredAt: '2026-01-01T00:00:00.000Z',
      actorRef: 'synthetic-clock',
      basis: { providerState: 'IL', patientState: 'IL' },
      policies,
    });
    expect(() => rulePackReviewWorkItem(instance, instance.dueAt)).toThrow(
      /only for rule-pack-review/,
    );
  });
});

describe('cancel + fold', () => {
  it('cancels a mooted clock with a reason and audits it', () => {
    const { instance } = triggerClock({
      tenantId: 'northwind-synthetic',
      clockId: 'clk-access-2',
      clockEventId: 'cle-a2-1',
      obligationType: 'records-request-closure',
      subjectRef: 'np-fx',
      triggerRef: 'records-request:2',
      triggeredAt: '2026-01-01T00:00:00.000Z',
      actorRef: 'synthetic-clock',
      basis: { providerState: 'IL', patientState: 'IL' },
      policies,
    });
    const cancelled = cancelClock(instance, {
      clockEventId: 'cle-a2-2',
      occurredAt: '2026-01-05T00:00:00.000Z',
      actorRef: 'synthetic-officer',
      reason: 'request withdrawn',
    });
    expect(cancelled.instance.status).toBe('cancelled');
    expect(cancelled.auditInput.action).toBe('obligation-clock-cancelled');
    expect(cancelled.auditInput.detail.config_ref).toBe('clock:clk-access-2');
    // The prose reason rides the clock event, never the grammar-checked audit detail.
    expect(cancelled.event.reason).toBe('request withdrawn');
  });

  it('foldClocks reproduces the projection from the event log (terminal wins)', () => {
    const trig = triggerClock({
      tenantId: 'northwind-synthetic',
      clockId: 'clk-fold-1',
      clockEventId: 'cle-f-1',
      obligationType: 'records-request-closure',
      subjectRef: 'np-fx',
      triggerRef: 'records-request:3',
      triggeredAt: '2026-01-01T00:00:00.000Z',
      actorRef: 'synthetic-clock',
      basis: { providerState: 'IL', patientState: 'IL' },
      policies,
    });
    const satisfy = recordClockSatisfaction(trig.instance, {
      clockEventId: 'cle-f-2',
      occurredAt: '2026-01-10T00:00:00.000Z',
      actorRef: 'synthetic-officer',
      evidenceRef: 'records-release:3',
    });
    const folded = foldClocks([trig.event, satisfy.event], [trig.instance]);
    const row = folded.get('northwind-synthetic|clk-fold-1');
    expect(row?.status).toBe('satisfied');
    expect(row?.closureEvidenceRef).toBe('records-release:3');
  });
});

describe('addDays', () => {
  it('adds and subtracts whole days on a UTC basis', () => {
    expect(addDays('2026-03-01T00:00:00.000Z', 30)).toBe('2026-03-31T00:00:00.000Z');
    expect(addDays('2026-03-31T00:00:00.000Z', -10)).toBe('2026-03-21T00:00:00.000Z');
  });

  it('rejects a malformed timestamp and a non-integer day count', () => {
    expect(() => addDays('not-a-date', 1)).toThrow(ClockError);
    expect(() => addDays('2026-03-01T00:00:00.000Z', 1.5)).toThrow(ClockError);
  });

  it('a workitem carries the obligation directive and owner for WP-022', () => {
    const { instance } = triggerClock({
      tenantId: 'northwind-synthetic',
      clockId: 'clk-wi-1',
      clockEventId: 'cle-wi-1',
      obligationType: 'mhra-renewal',
      subjectRef: 'np-fx',
      triggerRef: 'consent:x',
      triggeredAt: '2026-01-15T00:00:00.000Z',
      actorRef: 'synthetic-clock',
      basis: { providerState: 'MN', patientState: 'MN' },
      anchorDueAt: '2027-01-15T00:00:00.000Z',
      policies,
    });
    const workItem = clockWorkItem(instance, '2026-06-01T00:00:00.000Z');
    expect(workItem.ownerRole).toBe('compliance');
    expect(workItem.directive).toMatch(/renewal/);
    expect(workItem.status).toBe('pending');
  });
});
