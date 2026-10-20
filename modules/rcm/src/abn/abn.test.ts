import { describe, expect, it } from 'vitest';

import {
  AbnError,
  deliverAbn,
  evaluateAbnValidity,
  evaluateServiceGate,
  prepareAbn,
  recordRefusal,
  signAbn,
  voidAbn,
  type AbnRecord,
} from './abn.js';

const serviceAt = '2026-04-10T15:00:00Z';
const approvedForms = ['CMS-R-131-synthetic-2026'];

const draft = (): AbnRecord =>
  prepareAbn({
    abnRef: 'abn-syn-1',
    tenantId: 'tenant-shadow',
    patientRef: 'patient-syn-001',
    serviceRef: 'svc-vo2max-2026-04-10',
    formVersionRef: 'CMS-R-131-synthetic-2026',
    reasonText:
      'Medicare does not pay for VO2 max testing for fitness screening without a covered diagnosis',
    estimateMinor: 25000,
    preparedAt: '2026-04-10T14:00:00Z',
  });

const signed = (
  option: Parameters<typeof signAbn>[1]['option'] = 'option-1-bill-medicare',
): AbnRecord =>
  signAbn(deliverAbn(draft(), '2026-04-10T14:05:00Z'), {
    option,
    at: '2026-04-10T14:10:00Z',
    copyDeliveredAt: '2026-04-10T14:11:00Z',
  });

const judge = (abn: AbnRecord | null, at = serviceAt) =>
  evaluateAbnValidity({
    abn,
    tenantId: 'tenant-shadow',
    patientRef: 'patient-syn-001',
    serviceRef: 'svc-vo2max-2026-04-10',
    serviceAt: at,
    approvedFormVersionRefs: approvedForms,
  });

describe('WP-094 ABN validity (R6-REQ-033)', () => {
  it('accepts a notice prepared, delivered, signed and copied before the service', () => {
    expect(judge(signed())).toEqual({
      valid: true,
      defects: [],
      evidence: 'signed',
      option: 'option-1-bill-medicare',
    });
  });

  it('treats a missing ABN as invalid', () => {
    expect(judge(null)).toEqual({
      valid: false,
      defects: ['missing'],
      evidence: 'none',
      option: null,
    });
  });

  it('NO RETROACTIVE CURE: a signature after the service never makes the notice valid', () => {
    const late = signAbn(deliverAbn(draft(), '2026-04-10T14:05:00Z'), {
      option: 'option-1-bill-medicare',
      at: '2026-04-10T16:00:00Z',
      copyDeliveredAt: '2026-04-10T16:01:00Z',
    });
    expect(judge(late).defects).toEqual(['late', 'patient-copy-missing']);
    expect(judge(late).valid).toBe(false);
  });

  it('NO RETROACTIVE CURE: preparing a notice for an already-rendered service is refused', () => {
    expect(() =>
      prepareAbn({
        abnRef: 'abn-syn-late',
        tenantId: 'tenant-shadow',
        patientRef: 'patient-syn-001',
        serviceRef: 'svc-vo2max-2026-04-10',
        formVersionRef: 'CMS-R-131-synthetic-2026',
        reasonText:
          'Medicare does not pay for VO2 max testing for fitness screening without a covered diagnosis',
        estimateMinor: 25000,
        preparedAt: '2026-04-11T09:00:00Z',
        serviceRenderedAt: serviceAt,
      }),
    ).toThrow(new AbnError('RETROACTIVE_CURE_REFUSED'));
  });

  it('flags an unapproved form, a nonspecific reason, a missing estimate and a missing patient copy', () => {
    const abn: AbnRecord = {
      ...signed(),
      formVersionRef: 'old-form',
      reasonText: 'may not be covered',
      estimateMinor: null,
      patientCopyDeliveredAt: null,
    };
    expect(judge(abn).defects).toEqual([
      'unapproved-form',
      'nonspecific-reason',
      'estimate-missing',
      'patient-copy-missing',
    ]);
  });

  it('refuses an ABN that belongs to another patient or service', () => {
    expect(judge({ ...signed(), patientRef: 'patient-syn-002' }).defects).toContain(
      'cross-patient',
    );
    expect(judge({ ...signed(), serviceRef: 'svc-other' }).defects).toContain('cross-service');
  });

  it('treats a delivered but unsigned notice as not executed', () => {
    expect(judge(deliverAbn(draft(), '2026-04-10T14:05:00Z')).defects).toEqual(['not-executed']);
  });

  it('accepts a witnessed refusal as policy-valid evidence without inventing consent', () => {
    const refused = recordRefusal(deliverAbn(draft(), '2026-04-10T14:05:00Z'), {
      witnessRef: 'witness-syn-frontdesk',
      at: '2026-04-10T14:10:00Z',
      copyDeliveredAt: '2026-04-10T14:10:00Z',
    });
    expect(refused.option).toBeNull();
    expect(judge(refused)).toEqual({ valid: true, defects: [], evidence: 'refused', option: null });
    expect(() =>
      recordRefusal(deliverAbn(draft(), '2026-04-10T14:05:00Z'), {
        witnessRef: ' ',
        at: '2026-04-10T14:10:00Z',
        copyDeliveredAt: null,
      }),
    ).toThrow(new AbnError('ABN_WITNESS_REQUIRED'));
  });

  it('voids with a reason and retains the voided notice as invalid', () => {
    const voided = voidAbn(signed(), 'service reclassified as covered');
    expect(voided).toMatchObject({
      status: 'voided',
      voidReason: 'service reclassified as covered',
    });
    expect(judge(voided).defects).toContain('voided');
    expect(() => voidAbn(voided, 'again')).toThrow(new AbnError('ABN_ALREADY_VOIDED'));
    expect(() => voidAbn(signed(), '')).toThrow(new AbnError('ABN_VOID_REASON_REQUIRED'));
  });

  it('enforces the lifecycle order', () => {
    expect(() =>
      signAbn(draft(), { option: 'option-1-bill-medicare', at: serviceAt, copyDeliveredAt: null }),
    ).toThrow(new AbnError('ABN_NOT_DELIVERED'));
    expect(() => deliverAbn(signed(), serviceAt)).toThrow(new AbnError('ABN_NOT_DRAFT'));
    expect(() =>
      signAbn(deliverAbn(draft(), '2026-04-10T14:05:00Z'), {
        option: null,
        at: serviceAt,
        copyDeliveredAt: null,
      }),
    ).toThrow(new AbnError('ABN_OPTION_REQUIRED'));
  });
});

describe('WP-094 service gate: no service without a valid ABN when one is required', () => {
  it('blocks and escalates when the required ABN is missing or defective', () => {
    for (const abn of [null, { ...signed(), reasonText: 'not covered' }]) {
      expect(
        evaluateServiceGate({
          abnRequired: true,
          validity: judge(abn),
          option: abn?.option ?? null,
          emergencyException: false,
        }),
      ).toEqual({ proceed: false, reason: 'valid-abn-required', escalate: true });
    }
  });

  it('proceeds with a valid ABN, stops when the patient declines, and proceeds self-pay-at-risk on a witnessed refusal', () => {
    expect(
      evaluateServiceGate({
        abnRequired: true,
        validity: judge(signed()),
        option: 'option-1-bill-medicare',
        emergencyException: false,
      }),
    ).toEqual({ proceed: true, basis: 'valid-abn' });
    expect(
      evaluateServiceGate({
        abnRequired: true,
        validity: judge(signed('option-3-decline-service')),
        option: 'option-3-decline-service',
        emergencyException: false,
      }),
    ).toEqual({ proceed: false, reason: 'patient-declined-service', escalate: false });
    const refused = recordRefusal(deliverAbn(draft(), '2026-04-10T14:05:00Z'), {
      witnessRef: 'witness-syn-frontdesk',
      at: '2026-04-10T14:10:00Z',
      copyDeliveredAt: '2026-04-10T14:10:00Z',
    });
    expect(
      evaluateServiceGate({
        abnRequired: true,
        validity: judge(refused),
        option: null,
        emergencyException: false,
      }),
    ).toEqual({ proceed: true, basis: 'self-pay-at-risk' });
  });

  it('lets emergency care proceed through the exception and not-required services pass', () => {
    expect(
      evaluateServiceGate({
        abnRequired: true,
        validity: judge(null),
        option: null,
        emergencyException: true,
      }),
    ).toEqual({ proceed: true, basis: 'emergency-exception' });
    expect(
      evaluateServiceGate({
        abnRequired: false,
        validity: judge(null),
        option: null,
        emergencyException: false,
      }),
    ).toEqual({ proceed: true, basis: 'abn-not-required' });
  });
});
