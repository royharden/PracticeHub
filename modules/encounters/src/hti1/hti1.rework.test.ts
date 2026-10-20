import { describe, expect, it } from 'vitest';

import { CdsRegister, type CdsRegisterEntry, type NonDeviceCriteria } from './cds-register.js';
import { DsiCatalog, dsiSourceAttributes, type DsiRecord } from './dsi.js';
import { PpdrDisputeDesk } from './ppdr-suppression.js';
import { RestrictionRegistry, type RestrictionRequest } from './restrictions.js';

// WP-096 rework 1 (review D53-WP-096-a1-review-1). Each test fails on attempt 1.

const tenantId = 'northwind-synthetic';

const base: RestrictionRequest = {
  restrictionId: 'rs-1',
  tenantId,
  personId: 'person-1',
  dataClass: 'behavioral-health',
  encounterIds: ['enc-7'],
  restrictedRecipients: ['health-plan'],
  selfPaidInFull: true,
  requestedAt: '2026-06-01T00:00:00.000Z',
};
const access = {
  tenantId,
  personId: 'person-1',
  dataClass: 'behavioral-health',
  encounterId: 'enc-7',
  actorRef: 'staff-1',
};

describe('F1: a restriction id is immutable', () => {
  it('a replayed request cannot unbind an agreed mandatory restriction', () => {
    const reg = new RestrictionRegistry();
    reg.request(base);
    expect(() => reg.request({ ...base, selfPaidInFull: false })).toThrow(/already exists/);
    expect(reg.decideAccess({ ...access, recipient: 'health-plan' }).allowed).toBe(false);
  });
});

describe('F2: self-pay auto-agrees only the health-plan recipient', () => {
  it('a co-listed recipient stays requested until a provider decides', () => {
    const reg = new RestrictionRegistry();
    reg.request({ ...base, restrictedRecipients: ['health-plan', 'care-team-staff'] });
    expect(reg.decideAccess({ ...access, recipient: 'health-plan' }).allowed).toBe(false);
    expect(reg.decideAccess({ ...access, recipient: 'care-team-staff' }).allowed).toBe(true);
  });
});

const allTrue: NonDeviceCriteria = {
  noImageOrSignalAnalysis: true,
  displaysOrAnalyzesMedicalInfo: true,
  recommendationSupportsNotReplacesJudgment: true,
  basisIndependentlyReviewable: true,
};
const entry: CdsRegisterEntry = {
  useCaseId: 'uc-1',
  featureRef: 'feature-1',
  criteria: allTrue,
  classification: 'assistive-only',
  predictiveDsiRef: null,
  reviewedBy: 'ai-governance-board',
  synthetic: true,
};

describe('F3: a failed Non-Device criterion blocks clinical deployment', () => {
  it('image or signal analysis never deploys, even as assistive-only', () => {
    const register = new CdsRegister();
    const imaging = { ...entry, criteria: { ...allTrue, noImageOrSignalAnalysis: false } };
    let classified = true;
    try {
      register.classify(imaging);
    } catch {
      classified = false;
    }
    expect(classified && register.mayDeployClinically('uc-1')).toBe(false);
  });

  it('an assistive-only entry that failed a criterion needs a recorded redesign', () => {
    const register = new CdsRegister();
    const failed = {
      ...entry,
      criteria: { ...allTrue, recommendationSupportsNotReplacesJudgment: false },
    };
    expect(() => register.classify(failed)).toThrow(/redesign/);
  });

  it('an existing classification cannot be silently overwritten', () => {
    const register = new CdsRegister();
    register.classify({ ...entry, classification: 'escalated-device-review' });
    expect(() => register.classify(entry)).toThrow(/already classified/);
    expect(register.mayDeployClinically('uc-1')).toBe(false);
  });
});

describe('N4/N5: DSI history and CDS-DSI linkage', () => {
  const record: DsiRecord = {
    dsiRef: 'dsi-1',
    kind: 'predictive',
    modelVersion: 'm1',
    attributes: Object.fromEntries(dsiSourceAttributes.map((a) => [a, `synthetic ${a}`])),
    evalRunRef: 'eval-1',
    synthetic: true,
  };

  it('a DSI record cannot be silently replaced', () => {
    const catalog = new DsiCatalog();
    catalog.register(record);
    expect(() => catalog.register({ ...record, modelVersion: 'm2' })).toThrow(/supersede/);
  });

  it('a non-device CDS entry with no predictive DSI does not deploy', () => {
    const register = new CdsRegister();
    register.classify({ ...entry, classification: 'non-device-cds', predictiveDsiRef: null });
    expect(register.mayDeployClinically('uc-1')).toBe(false);
  });
});

describe('attempt 2: explicit, attributed transitions', () => {
  const allAttributes = Object.fromEntries(dsiSourceAttributes.map((a) => [a, `synthetic ${a}`]));
  const dsi: DsiRecord = {
    dsiRef: 'dsi-1',
    kind: 'predictive',
    modelVersion: 'm1',
    attributes: allAttributes,
    evalRunRef: 'eval-1',
    synthetic: true,
  };

  it('co-listed recipients are decided per recipient; mandatory ends only at patient request', () => {
    const reg = new RestrictionRegistry();
    reg.request({
      ...base,
      restrictedRecipients: ['health-plan', 'care-team-staff', 'third-party'],
    });
    reg.agree('rs-1', 'privacy-officer', ['care-team-staff']);
    reg.decline('rs-1', 'privacy-officer', 'needed for care coordination', ['third-party']);
    expect(reg.decideAccess({ ...access, recipient: 'care-team-staff' }).allowed).toBe(false);
    expect(reg.decideAccess({ ...access, recipient: 'third-party' }).allowed).toBe(true);
    expect(() =>
      reg.terminate('rs-1', 'privacy-officer', 'policy change', {
        patientRequested: false,
        recipients: ['health-plan'],
      }),
    ).toThrow(/patient request/);
    // H-05 NR-136: ending the mandatory restriction now also needs evidence of the patient's request.
    reg.terminate('rs-1', 'person-1', 'patient withdrew', {
      patientRequested: true,
      patientRequestEvidenceRef: 'portal-message-synthetic-1',
      recipients: ['health-plan'],
    });
    expect(reg.decideAccess({ ...access, recipient: 'health-plan' }).allowed).toBe(true);
    expect(reg.decideAccess({ ...access, recipient: 'care-team-staff' }).allowed).toBe(false);
  });

  it('leaving device review needs a decision ref and keeps history', () => {
    const register = new CdsRegister();
    register.classify({ ...entry, classification: 'escalated-device-review' });
    const next = {
      ...entry,
      classification: 'assistive-only' as const,
      reviewedBy: 'ai-governance-board',
    };
    expect(() => register.reclassify(next, { reviewer: 'board', reason: 'redesigned' })).toThrow(
      /device-review decision/,
    );
    register.reclassify(next, {
      reviewer: 'board',
      reason: 'redesigned',
      deviceReviewDecisionRef: 'dr-7',
    });
    expect(register.mayDeployClinically('uc-1')).toBe(true);
    expect(register.historyOf('uc-1')).toHaveLength(1);
    expect(register.historyOf('uc-1')[0]?.deviceReviewDecisionRef).toBe('dr-7');
  });

  it('assistive-only with a recorded redesign covering each failed criterion deploys', () => {
    const register = new CdsRegister();
    register.classify({
      ...entry,
      criteria: { ...allTrue, basisIndependentlyReviewable: false },
      redesign: {
        changedCriteria: ['basisIndependentlyReviewable'],
        reviewer: 'ai-governance-board',
        rationale: 'output limited to a draft the clinician must review and sign',
      },
    });
    expect(register.mayDeployClinically('uc-1')).toBe(true);
  });

  it('with a linked DSI catalog, non-device CDS deploys only on a registered complete predictive DSI', () => {
    const catalog = new DsiCatalog();
    const register = new CdsRegister(catalog);
    register.classify({ ...entry, classification: 'non-device-cds', predictiveDsiRef: 'dsi-1' });
    expect(register.mayDeployClinically('uc-1')).toBe(false);
    catalog.register({ ...dsi, attributes: { developer: 'synthetic' } });
    expect(register.mayDeployClinically('uc-1')).toBe(false);
    catalog.supersede(dsi, 'ai-governance-board', 'complete source attributes');
    expect(register.mayDeployClinically('uc-1')).toBe(true);
    expect(catalog.historyOf('dsi-1').map((h) => h.prior.attributes)).toEqual([
      { developer: 'synthetic' },
    ]);
  });
});

describe('N6: PPDR amounts are validated', () => {
  it('refuses NaN or fractional totals', () => {
    const desk = new PpdrDisputeDesk();
    const input = {
      disputeId: 'ppdr-1',
      tenantId,
      accountRef: 'acct-1',
      billRef: 'bill-1',
      gfeRef: 'gfe-1',
      variance: { purchaseKey: 'pk-1', gfeTotalMinor: Number.NaN, actualTotalMinor: 140_000 },
      noticeRefs: [],
      openedAt: '2026-06-01T00:00:00.000Z',
    };
    expect(() => desk.open(input)).toThrow(/minor-unit/);
    expect(() =>
      desk.open({ ...input, variance: { ...input.variance, gfeTotalMinor: 100_000.5 } }),
    ).toThrow(/minor-unit/);
  });
});
