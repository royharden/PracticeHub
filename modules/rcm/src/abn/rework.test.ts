import { describe, expect, it } from 'vitest';

import {
  AbnError,
  deliverAbn,
  evaluateAbnValidity,
  evaluateServiceGate,
  prepareAbn,
  signAbn,
  type AbnOption,
  type AbnRecord,
} from './abn.js';
import { evaluateCoveredVisit } from './awv-timing.js';
import { decideLiability } from './modifiers.js';
import {
  routeSplitBilling,
  type CompositionElement,
  type ProposedCharge,
} from './split-billing.js';

const serviceAt = '2026-04-10T10:00:00Z';

const draft = (): AbnRecord =>
  prepareAbn({
    abnRef: 'abn-syn-r1',
    tenantId: 'tenant-shadow',
    patientRef: 'patient-syn-001',
    serviceRef: 'svc-r1',
    formVersionRef: 'CMS-R-131-synthetic-2026',
    reasonText:
      'Medicare does not pay for VO2 max testing for fitness screening without a covered diagnosis',
    estimateMinor: 25000,
    preparedAt: '2026-04-10T09:00:00Z',
  });

const signedAt = (at: string, option: AbnOption = 'option-1-bill-medicare'): AbnRecord =>
  signAbn(deliverAbn(draft(), '2026-04-10T09:05:00Z'), { option, at, copyDeliveredAt: at });

const judge = (abn: AbnRecord, at = serviceAt) =>
  evaluateAbnValidity({
    abn,
    tenantId: 'tenant-shadow',
    patientRef: 'patient-syn-001',
    serviceRef: 'svc-r1',
    serviceAt: at,
    approvedFormVersionRefs: ['CMS-R-131-synthetic-2026'],
  });

describe('WP-094 rework 1: ABN timing compares instants, not strings (major)', () => {
  it('P2 precision: a signature 0.5 s after the service is late', () => {
    const validity = judge(signedAt('2026-04-10T10:00:00.500Z'));
    expect(validity.valid).toBe(false);
    expect(validity.defects).toContain('late');
    expect(
      evaluateServiceGate({ abnRequired: true, validity, emergencyException: false }),
    ).toMatchObject({ proceed: false, reason: 'valid-abn-required' });
    expect(decideLiability({ basis: 'required-abn', validity }).modifiers).toEqual(['GZ']);
  });

  it('P3 offset: a signature at 06:00-05:00 (11:00Z) is an hour late for a 10:00Z service', () => {
    const validity = judge(signedAt('2026-04-10T06:00:00-05:00'));
    expect(validity.defects).toContain('late');
    expect(decideLiability({ basis: 'required-abn', validity })).toMatchObject({
      modifiers: ['GZ'],
      patientBillLine: 'blocked',
      transferOfLiability: false,
    });
  });

  it('control: a signature before the service written with an offset is on time', () => {
    expect(judge(signedAt('2026-04-10T04:30:00-05:00')).valid).toBe(true);
  });

  it('refuses a retroactive notice whose service instant carries an offset', () => {
    expect(() =>
      prepareAbn({
        abnRef: 'abn-syn-r2',
        tenantId: 'tenant-shadow',
        patientRef: 'patient-syn-001',
        serviceRef: 'svc-r1',
        formVersionRef: 'CMS-R-131-synthetic-2026',
        reasonText:
          'Medicare does not pay for VO2 max testing for fitness screening without a covered diagnosis',
        estimateMinor: 25000,
        preparedAt: '2026-04-10T10:30:00Z',
        serviceRenderedAt: '2026-04-10T05:00:00-05:00',
      }),
    ).toThrow(new AbnError('RETROACTIVE_CURE_REFUSED'));
  });

  it('fails closed on an unparseable instant', () => {
    expect(judge(signedAt('2026-04-10T09:30:00Z'), 'April 10').defects).toContain(
      'invalid-instant',
    );
    expect(judge({ ...signedAt('2026-04-10T09:30:00Z'), signedAt: 'soon' }).defects).toContain(
      'invalid-instant',
    );
    expect(() => deliverAbn(draft(), '2026-04-10 09:05')).toThrow(
      new AbnError('ABN_INVALID_INSTANT'),
    );
  });
});

describe('WP-094 rework 1: the option comes from the signed ABN (medium)', () => {
  it('P4: a caller option that differs from the signed option is refused, never trusted', () => {
    const validity = judge(signedAt('2026-04-10T09:30:00Z', 'option-3-decline-service'));
    expect(validity.option).toBe('option-3-decline-service');
    expect(
      evaluateServiceGate({
        abnRequired: true,
        validity,
        option: 'option-1-bill-medicare',
        emergencyException: false,
      }),
    ).toEqual({ proceed: false, reason: 'option-mismatch', escalate: true });
    expect(evaluateServiceGate({ abnRequired: true, validity, emergencyException: false })).toEqual(
      {
        proceed: false,
        reason: 'patient-declined-service',
        escalate: false,
      },
    );
    expect(
      decideLiability({ basis: 'required-abn', validity, option: 'option-1-bill-medicare' }),
    ).toMatchObject({
      claim: 'do-not-submit',
      patientBillLine: 'blocked',
      escalate: true,
      reason: 'option-mismatch',
    });
  });

  it('bills under GA from the signed option alone', () => {
    const validity = judge(signedAt('2026-04-10T09:30:00Z'));
    expect(decideLiability({ basis: 'required-abn', validity })).toMatchObject({
      modifiers: ['GA'],
      reason: 'valid-abn-option-1',
    });
  });
});

const elements: readonly CompositionElement[] = [
  { componentRef: 'awv-health-risk-assessment', bucket: 'awv-covered' },
  { componentRef: 'vo2max-test', bucket: 'non-covered-enhanced' },
];
const charge = (componentRef: string, rail: ProposedCharge['rail'], n = 1): ProposedCharge => ({
  chargeRef: `chg:${componentRef}:${rail}:${String(n)}`,
  componentRef,
  rail,
});

describe('WP-094 rework 1: split-billing holds (major, low)', () => {
  it('P5: a Medicare claim line for a non-beneficiary is held, not submitted', () => {
    const decision = routeSplitBilling({
      medicarePatient: false,
      elements,
      charges: [
        charge('awv-health-risk-assessment', 'medicare-claim'),
        charge('vo2max-test', 'cash'),
      ],
      windows: {},
    });
    expect(decision.submit).toBe(false);
    expect(decision.holds).toEqual([
      {
        componentRef: 'awv-health-risk-assessment',
        reason: 'claim-for-non-beneficiary',
        queue: 'biller-review',
      },
    ]);
  });

  it('P6: one element charged twice on the same rail is held', () => {
    const decision = routeSplitBilling({
      medicarePatient: false,
      elements,
      charges: [charge('vo2max-test', 'cash', 1), charge('vo2max-test', 'cash', 2)],
      windows: {},
    });
    expect(decision.holds).toEqual([
      { componentRef: 'vo2max-test', reason: 'element-charged-twice', queue: 'biller-review' },
    ]);
  });
});

describe('WP-094 rework 1: AWV timing (medium, low)', () => {
  it('P7: an AWV completed on the service date makes a second same-day AWV already-used', () => {
    const result = evaluateCoveredVisit({
      kind: 'awv',
      serviceDate: '2026-06-10',
      partBEffectiveDate: '2020-01-01',
      history: [{ kind: 'awv', date: '2026-06-10', status: 'completed' }],
    });
    expect(result.status).toBe('already-used');
  });

  it('still ignores the scheduled entry that is this visit', () => {
    expect(
      evaluateCoveredVisit({
        kind: 'awv',
        serviceDate: '2026-06-10',
        partBEffectiveDate: '2020-01-01',
        history: [{ kind: 'awv', date: '2026-06-10', status: 'scheduled' }],
      }).status,
    ).toBe('eligible');
  });

  it('P8/P9: AWV after IPPE and AWV after AWV use the same 11-full-months rule', () => {
    const afterIppe = evaluateCoveredVisit({
      kind: 'awv',
      serviceDate: '2026-01-05',
      partBEffectiveDate: '2020-01-01',
      history: [{ kind: 'ippe', date: '2025-01-20', status: 'completed' }],
    });
    const afterAwv = evaluateCoveredVisit({
      kind: 'awv',
      serviceDate: '2026-01-05',
      partBEffectiveDate: '2020-01-01',
      history: [{ kind: 'awv', date: '2025-01-20', status: 'completed' }],
    });
    expect(afterIppe).toMatchObject({ status: 'eligible', earliestEligible: '2026-01-01' });
    expect(afterAwv).toMatchObject({ status: 'eligible', earliestEligible: '2026-01-01' });
  });

  it('P10: refuses a date that is not on the calendar', () => {
    expect(() =>
      evaluateCoveredVisit({
        kind: 'awv',
        serviceDate: '2026-02-30',
        partBEffectiveDate: '2020-01-01',
        history: [],
      }),
    ).toThrow('not a calendar date');
    expect(() =>
      evaluateCoveredVisit({
        kind: 'awv',
        serviceDate: '2026-03-01',
        partBEffectiveDate: '2020-01-01',
        history: [{ kind: 'awv', date: '2025-02-29', status: 'completed' }],
      }),
    ).toThrow('not a calendar date');
  });
});
