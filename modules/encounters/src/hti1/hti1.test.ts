import { describe, expect, it } from 'vitest';

import { CdsRegister, type CdsRegisterEntry, type NonDeviceCriteria } from './cds-register.js';
import { DsiCatalog, dsiSourceAttributes, type DsiRecord, type PredictiveOutput } from './dsi.js';
import { PPDR_THRESHOLD_MINOR, PpdrDisputeDesk } from './ppdr-suppression.js';
import {
  checkMatrixCompleteness,
  promotingInteroperabilityStatus,
  relevanceMatrixV1,
  type CertificationDecision,
} from './relevance-matrix.js';
import { RestrictionRegistry, statusFor, type RestrictionRequest } from './restrictions.js';

const tenantId = 'northwind-synthetic';

describe('170.315 relevance matrix and certification decision', () => {
  const decision: CertificationDecision = {
    decisionRef: 'cert-decision-1',
    posture: 'no-owned-certification',
    blocksBilling: false,
    rationale: 'certified components supply relied-upon criteria; owned UI gaps recorded',
    revisitTriggers: ['EW-CLOUD-01 cert matrix', 'provider count reaches 15'],
    providerCount: 9,
    synthetic: true,
  };

  it('the v1 matrix is complete for every relied-upon capability', () => {
    expect(checkMatrixCompleteness(relevanceMatrixV1, decision)).toEqual([]);
  });

  it('flags an uncovered capability, an empty mapping and a missing revisit trigger', () => {
    const rows = relevanceMatrixV1
      .filter((row) => row.capability !== 'e-prescribing')
      .map((row) =>
        row.criterion === '170.315(b)(1)'
          ? { ...row, relevance: { kind: 'certified-component' as const, component: ' ' } }
          : row,
      );
    const findings = checkMatrixCompleteness(rows, { ...decision, revisitTriggers: [] });
    expect(findings.map((f) => f.problem)).toEqual([
      'capability e-prescribing maps to no criterion',
      'certified-component row is missing its mapping',
      'certification decision needs a rationale and revisit triggers',
    ]);
  });

  it('PI reweighting is a metric from provider count, not a gate', () => {
    expect(promotingInteroperabilityStatus(decision)).toBe('auto-reweighted');
    expect(promotingInteroperabilityStatus({ ...decision, providerCount: 15 })).toBe(
      'reporting-required',
    );
    expect(decision.blocksBilling).toBe(false);
  });
});

describe('predictive DSI source attributes', () => {
  const attributes = Object.fromEntries(dsiSourceAttributes.map((a) => [a, `synthetic ${a}`]));
  const record: DsiRecord = {
    dsiRef: 'dsi-readmit',
    kind: 'predictive',
    modelVersion: 'model-sim-1',
    attributes,
    evalRunRef: 'eval-run-sim-1',
    synthetic: true,
  };
  const output: PredictiveOutput = {
    dsiRef: 'dsi-readmit',
    modelVersion: 'model-sim-1',
    personId: 'person-1',
    summary: 'synthetic 30-day readmission risk',
    score: 0.42,
  };

  it('renders all 14 source attributes on a predictive output', () => {
    const catalog = new DsiCatalog();
    catalog.register(record);
    const rendered = catalog.render(output);
    expect(dsiSourceAttributes).toHaveLength(14);
    expect(rendered.status).toBe('rendered');
    if (rendered.status === 'rendered') {
      expect(rendered.sourceAttributes.map((line) => line.attribute)).toEqual([
        ...dsiSourceAttributes,
      ]);
      expect(rendered.sourceAttributes.every((line) => line.value.startsWith('synthetic'))).toBe(
        true,
      );
    }
  });

  it('suppresses an output whose DSI lacks an attribute, eval evidence, or version match', () => {
    const catalog = new DsiCatalog();
    const partial = Object.fromEntries(
      Object.entries(attributes).filter(([key]) => key !== 'fairness-evaluation'),
    );
    catalog.register({ ...record, attributes: partial, evalRunRef: null });
    const rendered = catalog.render({ ...output, modelVersion: 'model-sim-2' });
    expect(rendered).toEqual({
      status: 'suppressed',
      dsiRef: 'dsi-readmit',
      reasons: [
        'model version model-sim-2 does not match registered model-sim-1',
        'missing source attributes: fairness-evaluation',
        'no validation evidence (eval run) on record',
      ],
    });
  });

  it('suppresses an unregistered DSI', () => {
    expect(new DsiCatalog().render(output)).toMatchObject({
      status: 'suppressed',
      reasons: ['unregistered DSI'],
    });
  });
});

describe('CDS classification register', () => {
  const allTrue: NonDeviceCriteria = {
    noImageOrSignalAnalysis: true,
    displaysOrAnalyzesMedicalInfo: true,
    recommendationSupportsNotReplacesJudgment: true,
    basisIndependentlyReviewable: true,
  };
  const entry: CdsRegisterEntry = {
    useCaseId: 'uc-readmit',
    featureRef: 'feature-readmit-risk',
    criteria: allTrue,
    classification: 'non-device-cds',
    predictiveDsiRef: 'dsi-readmit',
    reviewedBy: 'ai-governance-board',
    synthetic: true,
  };

  it('refuses non-device classification when a criterion fails, and blocks escalated use cases', () => {
    // H-05 NR-134: non-device CDS deploys only on a registered, complete predictive DSI, so link one.
    const catalog = new DsiCatalog();
    catalog.register({
      dsiRef: 'dsi-readmit',
      kind: 'predictive',
      modelVersion: 'model-sim-1',
      attributes: Object.fromEntries(dsiSourceAttributes.map((a) => [a, `synthetic ${a}`])),
      evalRunRef: 'eval-run-sim-1',
      synthetic: true,
    });
    const register = new CdsRegister(catalog);
    const imaging = { ...allTrue, noImageOrSignalAnalysis: false };
    expect(() => register.classify({ ...entry, useCaseId: 'uc-ecg', criteria: imaging })).toThrow(
      /fails a Non-Device CDS criterion/,
    );
    register.classify({
      ...entry,
      useCaseId: 'uc-ecg',
      featureRef: 'feature-ecg',
      criteria: imaging,
      classification: 'escalated-device-review',
    });
    register.classify(entry);
    expect(register.mayDeployClinically('uc-ecg')).toBe(false);
    expect(register.mayDeployClinically('uc-readmit')).toBe(true);
    expect(register.mayDeployClinically('uc-unknown')).toBe(false);
  });

  it('reports features with no classification record', () => {
    const register = new CdsRegister();
    register.classify(entry);
    expect(register.unclassifiedFeatures(['feature-readmit-risk', 'feature-draft-reply'])).toEqual([
      'feature-draft-reply',
    ]);
    expect(register.entriesNeedingDsi()).toEqual([]);
  });
});

describe('patient-directed restrictions', () => {
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
    actorRef: 'billing-1',
  };

  it('a self-paid-in-full health-plan restriction is honored in the access layer', () => {
    const reg = new RestrictionRegistry();
    const r = reg.request(base);
    expect(statusFor(r, 'health-plan')).toBe('agreed');
    expect(() => reg.decline('rs-1', 'privacy-officer', 'no', ['health-plan'])).toThrow(
      /cannot be declined/,
    );
    expect(reg.decideAccess({ ...access, recipient: 'health-plan' })).toEqual({
      allowed: false,
      restrictionId: 'rs-1',
      reason: 'patient-directed restriction on behavioral-health to health-plan',
    });
    expect(
      reg.decideAccess({ ...access, recipient: 'health-plan', encounterId: 'enc-8' }).allowed,
    ).toBe(true);
    expect(reg.decideAccess({ ...access, recipient: 'self' })).toEqual({
      allowed: true,
      basis: 'patient-self',
    });
  });

  it('an optional restriction binds only once agreed; the patient can never be restricted', () => {
    const reg = new RestrictionRegistry();
    reg.request({
      ...base,
      restrictedRecipients: ['care-team-staff'],
      selfPaidInFull: false,
      encounterIds: 'all',
    });
    expect(reg.decideAccess({ ...access, recipient: 'care-team-staff' }).allowed).toBe(true);
    reg.agree('rs-1', 'privacy-officer');
    expect(reg.decideAccess({ ...access, recipient: 'care-team-staff' }).allowed).toBe(false);
    expect(() =>
      reg.request({ ...base, restrictionId: 'rs-2', restrictedRecipients: ['self'] }),
    ).toThrow(/own access/);
  });

  it('emergency treatment overrides with a logged reason; other recipients cannot', () => {
    const reg = new RestrictionRegistry();
    reg.request({
      ...base,
      restrictedRecipients: ['treating-clinician', 'third-party'],
      selfPaidInFull: false,
    });
    reg.agree('rs-1', 'privacy-officer');
    const override = reg.decideAccess({
      ...access,
      recipient: 'treating-clinician',
      actorRef: 'er-doc',
      emergencyTreatmentReason: 'unresponsive on arrival',
    });
    expect(override).toMatchObject({
      allowed: true,
      basis: 'emergency-override',
      restrictionId: 'rs-1',
    });
    expect(reg.overrides()).toEqual([
      { restrictionId: 'rs-1', actorRef: 'er-doc', reason: 'unresponsive on arrival' },
    ]);
    expect(
      reg.decideAccess({ ...access, recipient: 'third-party', emergencyTreatmentReason: 'urgent' })
        .allowed,
    ).toBe(false);
  });
});

describe('PPDR dispute suppression', () => {
  const openInput = {
    disputeId: 'ppdr-1',
    tenantId,
    accountRef: 'acct-1',
    billRef: 'bill-1',
    gfeRef: 'gfe-1',
    variance: { purchaseKey: 'pk-1', gfeTotalMinor: 100_000, actualTotalMinor: 140_000 },
    noticeRefs: ['notice-gfe', 'notice-ppdr-rights'],
    openedAt: '2026-06-01T00:00:00.000Z',
  };

  it('suppresses collections and late fees while a dispute is active, and releases on resolution', () => {
    const desk = new PpdrDisputeDesk();
    const dispute = desk.open(openInput);
    expect(dispute.artifacts.deltaMinor).toBe(PPDR_THRESHOLD_MINOR);
    expect(desk.suppressionFlags(tenantId, 'acct-1')).toEqual([
      {
        tenantId,
        accountRef: 'acct-1',
        billRef: 'bill-1',
        suppressCollections: true,
        suppressLateFees: true,
        reasonRef: 'ppdr:ppdr-1',
        placeholderFor: 'WP-057',
      },
    ]);
    for (const action of ['late-fee', 'collections-referral', 'dunning-notice'] as const) {
      expect(desk.mayTakeLedgerAction(tenantId, 'acct-1', 'bill-1', action)).toEqual({
        allowed: false,
        reasonRef: 'ppdr:ppdr-1',
      });
    }
    expect(desk.mayTakeLedgerAction(tenantId, 'acct-1', 'bill-2', 'late-fee').allowed).toBe(true);
    desk.resolve('ppdr-1', 'resolved-for-provider', '2026-07-01T00:00:00.000Z', 140_000);
    expect(desk.suppressionFlags(tenantId, 'acct-1')).toEqual([]);
    expect(desk.mayTakeLedgerAction(tenantId, 'acct-1', 'bill-1', 'late-fee').allowed).toBe(true);
    expect(desk.get('ppdr-1').artifacts.noticeRefs).toEqual(['notice-gfe', 'notice-ppdr-rights']);
  });

  it('refuses a dispute below the $400 threshold', () => {
    const desk = new PpdrDisputeDesk();
    expect(() =>
      desk.open({ ...openInput, variance: { ...openInput.variance, actualTotalMinor: 139_999 } }),
    ).toThrow(/below the PPDR threshold/);
  });
});
