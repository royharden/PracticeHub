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
  mhraReleaseDecision,
  publishObligationClockPolicy,
  recordClockSatisfaction,
  resolveObligationClockPolicy,
  rulePackReviewWorkItem,
  runRenewalExpiry,
  triggerClock,
  ClockError,
  type ObligationClock,
  type ObligationClockEvent,
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

  it('foldClocks rebuilds the projection from the event LOG ALONE (no seeded row; review-016 F3)', () => {
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
    // No `triggers` argument: the trigger event carries every rebuild field.
    const folded = foldClocks([trig.event, satisfy.event]);
    const row = folded.get('northwind-synthetic|clk-fold-1');
    // Every projection field is reconstructed from the events — field-exact.
    expect(row).toEqual(satisfy.instance);
    // and matches the fresh trigger's derived fields (trigger-only metadata).
    expect(row?.triggerRef).toBe('records-request:3');
    expect(row?.escalateAt).toBe(trig.instance.escalateAt);
    expect(row?.ownerRole).toBe('compliance');
    expect(row?.expireFired).toBe(false);
  });

  it('the trigger event carries the rebuild metadata + governing-policy provenance', () => {
    const trig = triggerClock({
      tenantId: 'northwind-synthetic',
      clockId: 'clk-prov-1',
      clockEventId: 'cle-prov-1',
      obligationType: 'breach-notification',
      subjectRef: 'incident:synthetic-prov',
      triggerRef: 'incident:synthetic-prov',
      triggeredAt: '2026-03-01T00:00:00.000Z',
      actorRef: 'synthetic-officer',
      basis: { providerState: 'FL', patientState: 'FL' },
      policies,
    });
    expect(trig.event.triggerRef).toBe('incident:synthetic-prov');
    expect(trig.event.escalateAt).toBe(trig.instance.escalateAt);
    expect(trig.event.ownerRole).toBe('compliance');
    // FL 30-day pack governs (the strictest contribution), lower-cased.
    expect(trig.event.governingPolicyRef).toBe('breach-notification:fl:v1');
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

// --- review-016 F4: the SHARED effective-date validator (no local fork) ------

describe('effective-date validation (ADR-ADJ-002 shared primitive; review-016 F4)', () => {
  const withEffectiveOn = (effectiveOn: string): ObligationClockPolicy[] => [
    ...policies,
    {
      obligationType: 'breach-notification',
      jurisdiction: 'FL',
      version: 2,
      effectiveOn,
      status: 'draft',
      changeControlRef: 'wp-019-breach-fl-v2',
      durationDays: 15,
      escalationLeadDays: 5,
      sourceRef: 'fl-stat-501-171-tightened',
      synthetic: true,
    },
  ];

  it('rejects an IMPOSSIBLE calendar date (2026-02-30) — the round-trip validator, not a shape regex', () => {
    expect(() =>
      resolveObligationClockPolicy(
        withEffectiveOn('2026-02-30'),
        'breach-notification',
        { providerState: 'FL', patientState: 'FL' },
        '2027-01-01',
      ),
    ).toThrow(/valid calendar date/);
  });

  it('accepts a real calendar date on the shared boundary', () => {
    const onDate = resolveObligationClockPolicy(
      withEffectiveOn('2026-02-28'),
      'breach-notification',
      { providerState: 'FL', patientState: 'FL' },
      '2027-01-01',
    );
    expect(onDate.durationDays).toBe(15);
  });
});

// --- review-016 F2: terminal-safe + exactly-once renewal expiry --------------

describe('runRenewalExpiry — terminal-safe + exactly-once (review-016 F2)', () => {
  const trigger = () =>
    triggerClock({
      tenantId: 'northwind-synthetic',
      clockId: 'clk-mhra-term',
      clockEventId: 'cle-mt-1',
      obligationType: 'mhra-renewal',
      subjectRef: 'np-fx',
      triggerRef: 'consent:nce-term',
      triggeredAt: '2026-01-15T00:00:00.000Z',
      actorRef: 'synthetic-clock',
      basis: { providerState: 'MN', patientState: 'MN' },
      anchorDueAt: '2027-01-15T00:00:00.000Z',
      policies,
    });

  const runAt = (instance: ObligationClock, asOf: string) =>
    runRenewalExpiry({
      instance,
      asOf,
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
      expireEventId: 'nce-term-expire',
      expireClockEventId: 'cle-mt-expire',
      actorRef: 'synthetic-clock',
    });

  it('a CANCELLED renewal clock never auto-fires (cancel-before-due)', () => {
    const { instance } = trigger();
    const cancelled = cancelClock(instance, {
      clockEventId: 'cle-mt-cancel',
      occurredAt: '2026-06-01T00:00:00.000Z',
      actorRef: 'synthetic-officer',
      reason: 'consent revoked — renewal mooted',
    });
    const outcome = runAt(cancelled.instance, '2027-01-15T00:00:00.000Z');
    expect(outcome.fired).toBe(false);
    if (!outcome.fired) {
      expect(outcome.reason).toBe('cancelled');
    }
  });

  it('an ALREADY-FIRED clock does not fire a second time — a worker retry is a no-op', () => {
    const { instance, event } = trigger();
    const first = runAt(instance, '2027-01-15T00:00:00.000Z');
    expect(first.fired).toBe(true);
    if (!first.fired) {
      return;
    }
    // Fold the expire-fired event back into the projection (what a worker
    // persists), then re-run: the terminal marker suppresses a second fire.
    const foldedAfter = foldClocks([event, first.clockEvent]).get(
      'northwind-synthetic|clk-mhra-term',
    );
    expect(foldedAfter?.expireFired).toBe(true);
    const second = runAt(foldedAfter as ObligationClock, '2027-06-01T00:00:00.000Z');
    expect(second.fired).toBe(false);
    if (!second.fired) {
      expect(second.reason).toBe('already-fired');
    }
  });
});

// --- review-016 F3: the fold covers every event kind ------------------------

describe('foldClocks rebuilds every kind from the log (review-016 F3)', () => {
  it('trigger → escalate → cancel and trigger → expire-fired reconstruct field-exact', () => {
    const trig = triggerClock({
      tenantId: 'northwind-synthetic',
      clockId: 'clk-kinds-1',
      clockEventId: 'cle-k-1',
      obligationType: 'records-request-closure',
      subjectRef: 'np-fx',
      triggerRef: 'records-request:kinds',
      triggeredAt: '2026-01-01T00:00:00.000Z',
      actorRef: 'synthetic-clock',
      basis: { providerState: 'IL', patientState: 'IL' },
      policies,
    });
    const escalated = escalateClock(trig.instance, {
      clockEventId: 'cle-k-2',
      occurredAt: trig.instance.escalateAt,
      actorRef: 'synthetic-clock',
    });
    const cancelled = cancelClock(escalated.instance, {
      clockEventId: 'cle-k-3',
      occurredAt: '2026-01-20T00:00:00.000Z',
      actorRef: 'synthetic-officer',
      reason: 'withdrawn',
    });
    const foldedCancel = foldClocks([trig.event, escalated.event, cancelled.event]).get(
      'northwind-synthetic|clk-kinds-1',
    );
    expect(foldedCancel).toEqual(cancelled.instance);

    const mhra = triggerClock({
      tenantId: 'northwind-synthetic',
      clockId: 'clk-kinds-2',
      clockEventId: 'cle-k2-1',
      obligationType: 'mhra-renewal',
      subjectRef: 'np-fx',
      triggerRef: 'consent:kinds',
      triggeredAt: '2025-01-10T00:00:00.000Z',
      actorRef: 'synthetic-clock',
      basis: { providerState: 'MN', patientState: 'MN' },
      anchorDueAt: '2026-01-10T00:00:00.000Z',
      policies,
    });
    const fired = runRenewalExpiry({
      instance: mhra.instance,
      asOf: '2026-01-10T00:00:00.000Z',
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
      expireEventId: 'nce-kinds-expire',
      expireClockEventId: 'cle-k2-2',
      actorRef: 'synthetic-clock',
    });
    expect(fired.fired).toBe(true);
    if (!fired.fired) {
      return;
    }
    const foldedFired = foldClocks([mhra.event, fired.clockEvent]).get(
      'northwind-synthetic|clk-kinds-2',
    );
    expect(foldedFired?.expireFired).toBe(true);
    expect(foldedFired?.lastEventId).toBe('cle-k2-2');
  });
});

// --- review-016 F5: R6-SR-102 structured rule-pack-review closure ------------

describe('rule-pack-review closure requires STRUCTURED evidence (review-016 F5)', () => {
  const tracker = () =>
    triggerClock({
      tenantId: 'northwind-synthetic',
      clockId: 'clk-tracker-sat',
      clockEventId: 'cle-ts-1',
      obligationType: 'rule-pack-review',
      subjectRef: 'rule-pack-scope:all-jurisdictions',
      triggerRef: 'statute-tracker:cycle-sat',
      triggeredAt: '2026-01-01T00:00:00.000Z',
      actorRef: 'synthetic-clock',
      basis: { providerState: null, patientState: null },
      policies,
    }).instance;

  it('an arbitrary evidenceRef no longer satisfies a statute-tracker clock', () => {
    expect(() =>
      recordClockSatisfaction(tracker(), {
        clockEventId: 'cle-ts-2',
        occurredAt: '2026-04-01T00:00:00.000Z',
        actorRef: 'synthetic-officer',
        evidenceRef: 'x',
      }),
    ).toThrow(/structured evidence/);
  });

  it('closes with a change-control ref AND a truth-table regeneration receipt', () => {
    const satisfied = recordClockSatisfaction(tracker(), {
      clockEventId: 'cle-ts-3',
      occurredAt: '2026-04-01T00:00:00.000Z',
      actorRef: 'synthetic-officer',
      closureEvidence: {
        changeControlRef: 'ccr-statute-2026-q1',
        truthTableReceiptRef: 'truth-table:regen:cells-432-diffs-0',
      },
    });
    expect(satisfied.instance.status).toBe('satisfied');
    expect(satisfied.instance.closureEvidenceRef).toBe('ccr-statute-2026-q1');
    expect(satisfied.event.changeControlRef).toBe('ccr-statute-2026-q1');
    expect(satisfied.event.truthTableReceiptRef).toBe('truth-table:regen:cells-432-diffs-0');
    expect(satisfied.auditInput.detail.truth_table_receipt).toBe(
      'truth-table:regen:cells-432-diffs-0',
    );
  });

  it('a partial structured evidence (no receipt) fails closed', () => {
    expect(() =>
      recordClockSatisfaction(tracker(), {
        clockEventId: 'cle-ts-4',
        occurredAt: '2026-04-01T00:00:00.000Z',
        actorRef: 'synthetic-officer',
        closureEvidence: {
          changeControlRef: 'ccr-statute-2026-q1',
          truthTableReceiptRef: '',
        },
      }),
    ).toThrow(/truth-table regeneration receipt/);
  });
});

// --- review-016 F5: MHRA urgent-release exception (ADR-007 C-06) -------------

describe('mhraReleaseDecision — expiry blocks third-party only (review-016 F5; C-06)', () => {
  it('a lapsed disclosure consent blocks a THIRD-PARTY release (fail closed)', () => {
    const decision = mhraReleaseDecision({
      disclosureConsentActive: false,
      basis: 'third-party-disclosure',
    });
    expect(decision.permitted).toBe(false);
  });

  it('a live disclosure consent permits the third-party release', () => {
    expect(
      mhraReleaseDecision({ disclosureConsentActive: true, basis: 'third-party-disclosure' })
        .permitted,
    ).toBe(true);
  });

  it('the PATIENT’S OWN access is NEVER blocked by expiry (C-06)', () => {
    expect(
      mhraReleaseDecision({ disclosureConsentActive: false, basis: 'patient-own-access' })
        .permitted,
    ).toBe(true);
  });

  it('an URGENT-CARE release proceeds under the documented exception', () => {
    expect(
      mhraReleaseDecision({ disclosureConsentActive: false, basis: 'urgent-care' }).permitted,
    ).toBe(true);
  });
});

// --- review-016 F1: gated clock-policy publication --------------------------

describe('publishObligationClockPolicy — authority-bearing counsel data (review-016 F1)', () => {
  const policy: ObligationClockPolicy = {
    obligationType: 'breach-notification',
    jurisdiction: 'FL',
    version: 7,
    effectiveOn: '2027-01-01',
    status: 'draft',
    changeControlRef: 'ccr-fl-breach-2027',
    durationDays: 20,
    escalationLeadDays: 7,
    sourceRef: 'fl-stat-501-171-2027',
    synthetic: true,
  };

  it('validates the policy and yields a config-change audit input with a lower-cased ref', () => {
    const published = publishObligationClockPolicy(policy, {
      actorRef: 'synthetic-counsel',
      occurredAt: '2026-07-01T00:00:00.000Z',
    });
    expect(published.policy.version).toBe(7);
    expect(published.auditInput.stream).toBe('config-change');
    expect(published.auditInput.detail.config_ref).toBe('clock-policy:breach-notification:fl:v7');
    expect(published.auditInput.detail.change_control_ref).toBe('ccr-fl-breach-2027');
  });

  it('an impossible effective date is rejected before any audit input is produced', () => {
    expect(() =>
      publishObligationClockPolicy(
        { ...policy, effectiveOn: '2027-02-30' },
        { actorRef: 'synthetic-counsel', occurredAt: '2026-07-01T00:00:00.000Z' },
      ),
    ).toThrow(/valid calendar date/);
  });
});

// A follow-event without its trigger cannot rebuild a row (fold tolerates a
// partial slice — the DB FK makes this unrepresentable in the store).
describe('foldClocks partial-slice tolerance', () => {
  it('skips a follow-event whose trigger is absent from the slice', () => {
    const orphan: ObligationClockEvent = {
      tenantId: 'northwind-synthetic',
      clockEventId: 'cle-orphan',
      clockId: 'clk-orphan',
      obligationType: 'records-request-closure',
      kind: 'satisfy',
      subjectRef: 'np-fx',
      occurredAt: '2026-01-10T00:00:00.000Z',
      evidenceRef: 'records-release:orphan',
      actorRef: 'synthetic-officer',
      synthetic: true,
    };
    expect(foldClocks([orphan]).size).toBe(0);
  });
});
