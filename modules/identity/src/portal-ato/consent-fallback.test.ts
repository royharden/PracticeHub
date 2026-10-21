/**
 * WP-099 e-sign outage consent fallback, end to end (REQ-PORT-020, REQ-PLAT-033, REQ-PORT-018
 * EX1): outage at check-in, paper kit of current versions, stale-version block, hold versus
 * proceed, mid-visit recovery without re-demand, then digitization with quarantine and the
 * compliance-review route.
 */
import { describe, expect, it } from 'vitest';

import type { TenantId } from '@practicehub/contracts';

import {
  auditPaperKit,
  decideVisit,
  pendingDigitizations,
  recordPaperCapture,
  resumeAfterRecovery,
  startCheckInConsent,
} from './consent-fallback.js';
import { digitizationWorklist, digitizeScan, reportEsignOutage } from './digitization.js';
import {
  InMemoryConsentFormCatalog,
  InMemoryPaperConsentLedger,
  InMemoryVisitConsentMatrix,
} from './ports.js';
import { createEsignRailDouble } from './sim-doubles.js';
import type { CheckIn, CheckInConsentState, ConsentFormVersion } from './types.js';

const tenant = 'northwind-synthetic' as TenantId;

function form(formId: string, version: string, languages = ['en', 'es']): ConsentFormVersion {
  return {
    formId,
    version,
    documentId: `doc-${formId}`,
    versionNo: Number(version.replace('v', '')),
    contentHash: `synthetic-hash-${formId}-${version}`,
    vettedLanguages: languages,
  };
}

const catalog = new InMemoryConsentFormCatalog([
  form('consent-to-treat', 'v3'),
  form('telehealth-consent', 'v2'),
  form('financial-policy', 'v5'),
  form('photo-release', 'v1', ['en']),
]);

const matrix = new InMemoryVisitConsentMatrix([
  {
    jurisdiction: 'NV',
    visitType: 'in-person-new',
    rules: [
      { formId: 'consent-to-treat', blocking: true },
      { formId: 'financial-policy', blocking: true },
      { formId: 'photo-release', blocking: false },
    ],
  },
  {
    jurisdiction: 'FL',
    visitType: 'telehealth-new',
    rules: [
      { formId: 'consent-to-treat', blocking: true },
      { formId: 'telehealth-consent', blocking: true },
      { formId: 'state-specific-addendum', blocking: true },
    ],
  },
]);

function checkIn(overrides: Partial<CheckIn> = {}): CheckIn {
  return {
    checkInId: 'chk-001',
    tenantId: tenant,
    patientRef: 'pt-synthetic-001',
    encounterRef: 'enc-synthetic-001',
    jurisdiction: 'NV',
    visitType: 'in-person-new',
    preferredLanguage: 'en',
    synthetic: true,
    ...overrides,
  };
}

const ids = { kitId: 'kit-001', outageId: 'outage-001' };

function outageAtCheckIn(overrides: Partial<CheckIn> = {}): CheckInConsentState {
  const rail = createEsignRailDouble();
  rail.setDown(true);
  return startCheckInConsent(checkIn(overrides), { matrix, catalog, rail }, ids);
}

function paper(
  state: CheckInConsentState,
  formId: string,
  presentedVersion: string,
  outcome: 'signed' | 'refused' = 'signed',
): CheckInConsentState {
  return recordPaperCapture(
    state,
    {
      formId,
      presentedVersion,
      outcome,
      captureId: `cap-${formId}`,
      capturedBy: 'front-desk-synthetic',
      capturedAt: '2026-03-09T09:00:00Z',
    },
    catalog,
  );
}

describe('WP-099 check-in while the e-sign vendor is up', () => {
  it('signs every readable form electronically and proceeds', () => {
    const rail = createEsignRailDouble();
    const state = startCheckInConsent(checkIn(), { matrix, catalog, rail }, ids);
    expect(state.outageId).toBeNull();
    expect(state.kit).toBeNull();
    expect(decideVisit(state)).toEqual({
      decision: 'proceed',
      capturedOnPaperPendingDigitization: [],
      deferredNonBlocking: [],
    });
    expect(rail.requests().map((request) => request.documentId)).toEqual([
      'doc-consent-to-treat',
      'doc-financial-policy',
      'doc-photo-release',
    ]);
  });
});

describe('WP-099 PAPER-CONSENT FALLBACK (REQ-PORT-020)', () => {
  it('AC1/AC4: an outage yields a kit of current versions with a blocking checklist', () => {
    const state = outageAtCheckIn();
    expect(state.outageId).toBe('outage-001');
    expect(state.kit).toEqual({
      kitId: 'kit-001',
      checkInId: 'chk-001',
      outageId: 'outage-001',
      forms: [
        { formId: 'consent-to-treat', version: 'v3' },
        { formId: 'financial-policy', version: 'v5' },
        { formId: 'photo-release', version: 'v1' },
      ],
      checklist: [
        { formId: 'consent-to-treat', blocking: true },
        { formId: 'financial-policy', blocking: true },
        { formId: 'photo-release', blocking: false },
      ],
    });
    expect(decideVisit(state)).toMatchObject({
      decision: 'hold',
      missingBlocking: ['consent-to-treat', 'financial-policy'],
    });
  });

  it('AC2/AC3: blocking forms on paper let the visit proceed; the gap stays visible', () => {
    let state = outageAtCheckIn();
    state = paper(state, 'consent-to-treat', 'v3');
    state = paper(state, 'financial-policy', 'v5');
    expect(decideVisit(state)).toEqual({
      decision: 'proceed',
      capturedOnPaperPendingDigitization: ['consent-to-treat', 'financial-policy'],
      deferredNonBlocking: ['photo-release'],
    });
  });

  it('STALE-VERSION BLOCK (EX2): an outdated paper form is refused and the visit holds', () => {
    let state = outageAtCheckIn();
    state = paper(state, 'consent-to-treat', 'v2');
    state = paper(state, 'financial-policy', 'v5');
    expect(state.captures['consent-to-treat']).toEqual({
      kind: 'stale-version-blocked',
      presentedVersion: 'v2',
    });
    expect(decideVisit(state)).toEqual({
      decision: 'hold',
      missingBlocking: ['consent-to-treat'],
      reasons: ['consent-to-treat:stale-version-blocked'],
    });
    expect(pendingDigitizations(state).map((item) => item.formId)).toEqual(['financial-policy']);
  });

  it('AC4/EX2: a pre-printed kit audit names every stale form', () => {
    expect(
      auditPaperKit(
        [
          { formId: 'consent-to-treat', version: 'v2' },
          { formId: 'financial-policy', version: 'v5' },
          { formId: 'retired-form', version: 'v1' },
        ],
        catalog,
      ),
    ).toEqual([
      { formId: 'consent-to-treat', printed: 'v2', current: 'v3' },
      { formId: 'retired-form', printed: 'v1', current: null },
    ]);
  });

  it('EX1: a refused blocking consent holds the visit; a missing required version holds it too', () => {
    let refused = outageAtCheckIn();
    refused = paper(refused, 'consent-to-treat', 'v3', 'refused');
    refused = paper(refused, 'financial-policy', 'v5');
    expect(decideVisit(refused)).toMatchObject({
      decision: 'hold',
      reasons: ['consent-to-treat:refused'],
    });
    const florida = outageAtCheckIn({ jurisdiction: 'FL', visitType: 'telehealth-new' });
    expect(florida.forms.find((item) => item.formId === 'state-specific-addendum')).toEqual({
      formId: 'state-specific-addendum',
      blocking: true,
      version: null,
      path: 'version-unavailable',
    });
    expect(decideVisit(florida)).toMatchObject({
      decision: 'hold',
      reasons: expect.arrayContaining(['state-specific-addendum:version-unavailable']),
    });
  });

  it('EX3: the vendor recovers mid-visit; paper captures are not re-demanded', () => {
    const rail = createEsignRailDouble();
    rail.setDown(true);
    let state = startCheckInConsent(checkIn(), { matrix, catalog, rail }, ids);
    state = paper(state, 'consent-to-treat', 'v3');
    expect(() => paper(state, 'consent-to-treat', 'v3')).toThrow(/not re-demanded/);
    rail.setDown(false);
    state = resumeAfterRecovery(state, rail, catalog);
    expect(rail.requests().map((request) => request.documentId)).toEqual([
      'doc-financial-policy',
      'doc-photo-release',
    ]);
    expect(state.captures['consent-to-treat']?.kind).toBe('captured-paper');
    expect(state.captures['financial-policy']?.kind).toBe('signed-electronic');
    expect(decideVisit(state)).toEqual({
      decision: 'proceed',
      capturedOnPaperPendingDigitization: ['consent-to-treat'],
      deferredNonBlocking: [],
    });
  });

  it('a rail still down on resume leaves the state unchanged', () => {
    const rail = createEsignRailDouble();
    rail.setDown(true);
    const state = startCheckInConsent(checkIn(), { matrix, catalog, rail }, ids);
    expect(resumeAfterRecovery(state, rail, catalog)).toBe(state);
  });

  it('REQ-PORT-018 EX1: no vetted translation routes to an interpreter, never to self e-sign', () => {
    const rail = createEsignRailDouble();
    const state = startCheckInConsent(
      checkIn({ preferredLanguage: 'es' }),
      { matrix, catalog, rail },
      ids,
    );
    expect(state.forms.find((item) => item.formId === 'photo-release')?.path).toBe(
      'interpreter-assisted',
    );
    expect(rail.requests().map((request) => request.documentId)).not.toContain('doc-photo-release');
    expect(decideVisit(state)).toEqual({
      decision: 'proceed',
      capturedOnPaperPendingDigitization: [],
      deferredNonBlocking: ['photo-release'],
    });
  });

  it('rejects an unknown visit type and a form that is not required', () => {
    expect(() => outageAtCheckIn({ visitType: 'unknown-visit' })).toThrow(/no consent rules/);
    expect(() => paper(outageAtCheckIn(), 'telehealth-consent', 'v2')).toThrow(/not required/);
  });
});

describe('WP-099 DIGITIZATION QUARANTINE and ledger provenance (REQ-PLAT-033)', () => {
  function capturedState(): CheckInConsentState {
    let state = outageAtCheckIn();
    state = paper(state, 'consent-to-treat', 'v3');
    return paper(state, 'financial-policy', 'v5');
  }
  const scan = (overrides: Record<string, unknown> = {}) => ({
    scanId: 'scan-001',
    patientRef: 'pt-synthetic-001',
    encounterRef: 'enc-synthetic-001',
    formId: 'consent-to-treat',
    version: 'v3',
    synthetic: true as const,
    ...overrides,
  });

  it('AC1/AC2: a matched scan lands on the ledger with paper provenance, once', () => {
    const ledger = new InMemoryPaperConsentLedger();
    const pending = pendingDigitizations(capturedState());
    const outcome = digitizeScan(
      scan(),
      pending,
      ledger,
      'records-clerk-synthetic',
      '2026-03-10T10:00:00Z',
    );
    expect(outcome).toMatchObject({
      status: 'linked',
      entry: {
        captureId: 'cap-consent-to-treat',
        provenance: {
          medium: 'paper',
          capturedDuringOutage: 'outage-001',
          capturedBy: 'front-desk-synthetic',
          digitizedBy: 'records-clerk-synthetic',
        },
      },
    });
    expect(ledger.paperEntries()).toHaveLength(1);
    expect(
      digitizeScan(
        scan({ scanId: 'scan-001b' }),
        pending,
        ledger,
        'records-clerk-synthetic',
        '2026-03-10T10:05:00Z',
      ),
    ).toEqual({ status: 'already-linked', captureId: 'cap-consent-to-treat' });
    expect(ledger.paperEntries()).toHaveLength(1);
  });

  it('EX1: an unmatched, unlabelled, wrong-version or ambiguous scan is quarantined, never guessed', () => {
    const ledger = new InMemoryPaperConsentLedger();
    const pending = pendingDigitizations(capturedState());
    const at = '2026-03-10T10:00:00Z';
    expect(
      digitizeScan(scan({ patientRef: 'pt-synthetic-999' }), pending, ledger, 'clerk', at),
    ).toEqual({
      status: 'quarantined',
      scanId: 'scan-001',
      reason: 'no-match',
    });
    expect(digitizeScan(scan({ encounterRef: null }), pending, ledger, 'clerk', at)).toMatchObject({
      reason: 'no-match',
    });
    expect(digitizeScan(scan({ version: 'v2' }), pending, ledger, 'clerk', at)).toMatchObject({
      reason: 'version-mismatch',
    });
    const [first] = pending;
    if (first === undefined) throw new Error('no pending capture');
    expect(
      digitizeScan(scan(), [first, { ...first, captureId: 'cap-duplicate' }], ledger, 'clerk', at),
    ).toMatchObject({ reason: 'ambiguous-match' });
    expect(ledger.paperEntries()).toEqual([]);
  });

  it('EX2: a paper consent older than an electronic one goes to compliance review, not the ledger', () => {
    const ledger = new InMemoryPaperConsentLedger([
      {
        patientRef: 'pt-synthetic-001',
        formId: 'consent-to-treat',
        version: 'v3',
        signedAt: '2026-03-09T12:00:00Z',
        evidenceRef: 'synthetic-esign-evidence:later',
      },
    ]);
    const outcome = digitizeScan(
      scan(),
      pendingDigitizations(capturedState()),
      ledger,
      'clerk',
      '2026-03-10T10:00:00Z',
    );
    expect(outcome).toEqual({
      status: 'compliance-review',
      scanId: 'scan-001',
      captureId: 'cap-consent-to-treat',
      reason: 'conflicts-with-later-electronic',
    });
    expect(ledger.paperEntries()).toEqual([]);
  });

  it('AC4: unlinked paper consents stay on an aging worklist until linked', () => {
    const ledger = new InMemoryPaperConsentLedger();
    const pending = pendingDigitizations(capturedState());
    expect(
      digitizationWorklist(pending, ledger, '2026-03-11T09:00:00Z', 24).map((item) => [
        item.captureId,
        item.overdue,
      ]),
    ).toEqual([
      ['cap-consent-to-treat', true],
      ['cap-financial-policy', true],
    ]);
    digitizeScan(scan(), pending, ledger, 'clerk', '2026-03-11T09:05:00Z');
    expect(
      digitizationWorklist(pending, ledger, '2026-03-09T10:00:00Z', 24).map((item) => [
        item.captureId,
        item.overdue,
      ]),
    ).toEqual([['cap-financial-policy', false]]);
  });

  it('AC3/EX3: an outage is measured against the SLA and a breach or recurrence escalates', () => {
    const outage = {
      outageId: 'outage-001',
      startedAt: '2026-03-09T08:00:00Z',
      endedAt: '2026-03-09T11:00:00Z',
      affectedPatientRefs: ['pt-1', 'pt-2', 'pt-2'],
      heldCheckInIds: ['chk-9'],
    };
    const sla = { maxOutageMinutes: 60, maxOutagesPerReview: 2 };
    expect(reportEsignOutage(outage, sla, 0)).toEqual({
      outageId: 'outage-001',
      durationMinutes: 180,
      affectedPatients: 2,
      heldVisits: 1,
      slaBreached: true,
      escalation: 'vendor-accountability-review',
      reasons: ['duration 180m > 60m'],
    });
    const short = { ...outage, endedAt: '2026-03-09T08:30:00Z' };
    expect(reportEsignOutage(short, sla, 0).escalation).toBeNull();
    expect(reportEsignOutage(short, sla, 2)).toMatchObject({
      slaBreached: false,
      escalation: 'vendor-accountability-review',
      reasons: ['3 outages > 2 per review window'],
    });
  });
});
