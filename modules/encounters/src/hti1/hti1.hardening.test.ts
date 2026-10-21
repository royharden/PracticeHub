import { describe, expect, it } from 'vitest';

import { CdsRegister, type CdsRegisterEntry } from './cds-register.js';
import { DsiCatalog, dsiSourceAttributes } from './dsi.js';
import { PPDR_THRESHOLD_MINOR, PpdrDisputeDesk, PpdrError } from './ppdr-suppression.js';
import { RestrictionError, RestrictionRegistry, type RestrictionRequest } from './restrictions.js';

const entry: CdsRegisterEntry = {
  useCaseId: 'uc-readmit',
  featureRef: 'feature-readmit-risk',
  criteria: {
    noImageOrSignalAnalysis: true,
    displaysOrAnalyzesMedicalInfo: true,
    recommendationSupportsNotReplacesJudgment: true,
    basisIndependentlyReviewable: true,
  },
  classification: 'non-device-cds',
  predictiveDsiRef: 'dsi-never-registered',
  reviewedBy: 'ai-governance-board',
  synthetic: true,
};

describe('NR-134: without a DSI catalog a non-device CDS entry does not deploy', () => {
  it('an unverifiable predictive DSI reference fails closed', () => {
    const register = new CdsRegister();
    register.classify(entry);
    expect(register.mayDeployClinically('uc-readmit')).toBe(false);
  });

  it('with a catalog it deploys only once that DSI is registered and complete', () => {
    const catalog = new DsiCatalog();
    const register = new CdsRegister(catalog);
    register.classify({ ...entry, predictiveDsiRef: 'dsi-readmit' });
    expect(register.mayDeployClinically('uc-readmit')).toBe(false);
    catalog.register({
      dsiRef: 'dsi-readmit',
      kind: 'predictive',
      modelVersion: 'model-sim-1',
      attributes: Object.fromEntries(dsiSourceAttributes.map((a) => [a, `synthetic ${a}`])),
      evalRunRef: 'eval-run-sim-1',
      synthetic: true,
    });
    expect(register.mayDeployClinically('uc-readmit')).toBe(true);
  });
});

function openDispute(desk: PpdrDisputeDesk): void {
  desk.open({
    disputeId: 'ppdr-1',
    tenantId: 'northwind-synthetic',
    accountRef: 'acct-1',
    billRef: 'bill-1',
    gfeRef: 'gfe-1',
    variance: {
      purchaseKey: 'p-1',
      gfeTotalMinor: 100_000,
      actualTotalMinor: 100_000 + PPDR_THRESHOLD_MINOR,
    },
    noticeRefs: ['notice-1'],
    openedAt: '2026-06-01T00:00:00.000Z',
  });
}

describe('NR-135: PPDR resolve validates the determined amount and the time', () => {
  it('refuses NaN, negative and fractional amounts and an unparseable or early time, leaving the dispute active', () => {
    const desk = new PpdrDisputeDesk();
    openDispute(desk);
    expect(() =>
      desk.resolve('ppdr-1', 'resolved-for-patient', '2026-07-01T00:00:00.000Z', Number.NaN),
    ).toThrow(PpdrError);
    expect(() =>
      desk.resolve('ppdr-1', 'resolved-for-patient', '2026-07-01T00:00:00.000Z', -1),
    ).toThrow(/non-negative/);
    expect(() =>
      desk.resolve('ppdr-1', 'resolved-for-patient', '2026-07-01T00:00:00.000Z', 10.5),
    ).toThrow(PpdrError);
    expect(() => desk.resolve('ppdr-1', 'resolved-for-patient', 'soon', 100_000)).toThrow(
      /valid instant/,
    );
    expect(() =>
      desk.resolve('ppdr-1', 'resolved-for-patient', '2026-05-01T00:00:00.000Z', 100_000),
    ).toThrow(/before it was opened/);
    expect(desk.get('ppdr-1').status).toBe('active');
    expect(
      desk.resolve('ppdr-1', 'resolved-for-patient', '2026-07-01T00:00:00.000Z', 100_000)
        .determinedAmountMinor,
    ).toBe(100_000);
  });

  it('a null determined amount is still accepted', () => {
    const desk = new PpdrDisputeDesk();
    openDispute(desk);
    expect(
      desk.resolve('ppdr-1', 'withdrawn', '2026-07-01T00:00:00.000Z').determinedAmountMinor,
    ).toBeNull();
  });
});

const request: RestrictionRequest = {
  restrictionId: 'rs-1',
  tenantId: 'northwind-synthetic',
  personId: 'person-1',
  dataClass: 'lab-results',
  encounterIds: 'all',
  restrictedRecipients: ['health-plan', 'care-team-staff'],
  selfPaidInFull: true,
  requestedAt: '2026-06-01T00:00:00.000Z',
};

describe('NR-136: a mandatory self-pay restriction ends only with evidence of the patient request', () => {
  it('a caller-asserted patientRequested flag alone does not end it', () => {
    const reg = new RestrictionRegistry();
    reg.request(request);
    expect(() =>
      reg.terminate('rs-1', 'front-desk-1', 'patient asked', {
        patientRequested: true,
        recipients: ['health-plan'],
      }),
    ).toThrow(RestrictionError);
    expect(() =>
      reg.terminate('rs-1', 'front-desk-1', 'patient asked', {
        patientRequested: true,
        patientRequestEvidenceRef: '  ',
        recipients: ['health-plan'],
      }),
    ).toThrow(/evidence of the patient request/);
    expect(reg.get('rs-1').decisions.find((d) => d.recipient === 'health-plan')?.status).toBe(
      'agreed',
    );
  });

  it('with evidence it ends and the evidence is recorded on the decision', () => {
    const reg = new RestrictionRegistry();
    reg.request(request);
    const ended = reg.terminate('rs-1', 'front-desk-1', 'patient asked', {
      patientRequested: true,
      patientRequestEvidenceRef: 'signed-form-synthetic-7',
      recipients: ['health-plan'],
    });
    expect(ended.decisions.find((d) => d.recipient === 'health-plan')).toMatchObject({
      status: 'terminated',
      patientRequestEvidenceRef: 'signed-form-synthetic-7',
    });
  });

  it('a non-mandatory restriction still ends without patient evidence', () => {
    const reg = new RestrictionRegistry();
    reg.request(request);
    reg.agree('rs-1', 'privacy-officer', ['care-team-staff']);
    const ended = reg.terminate('rs-1', 'privacy-officer', 'care coordination', {
      patientRequested: false,
      recipients: ['care-team-staff'],
    });
    expect(ended.decisions.find((d) => d.recipient === 'care-team-staff')?.status).toBe(
      'terminated',
    );
  });
});
