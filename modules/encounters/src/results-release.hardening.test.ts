import { describe, expect, it } from 'vitest';

import type { AthenaAttestation, ClinicalScope, SoapBody } from './clinical-contracts.double.js';
import { DowntimeError, DowntimeKit, type SnapshotRecord } from './downtime.js';
import { MedicationList } from './med-list.js';
import { EncounterNoteService } from './note-lifecycle.js';
import {
  ResultsReleaseError,
  ResultsReleaseService,
  type InfoBlockingException,
  type ReleasePolicy,
  type ResultScope,
} from './results-release.js';

const policies: ReleasePolicy[] = [{ category: 'lab', reviewWindowHours: 72, synthetic: true }];
const tenant = 'northwind-synthetic';
const scope = (resultId: string, tenantId = tenant): ResultScope => ({
  tenantId,
  personId: 'person-1',
  resultId,
});
const resultedAt = '2026-06-01T09:00:00.000Z';
const deadline = '2026-06-04T09:00:00.000Z';
const afterDeadline = '2026-06-04T12:00:00.000Z';
const harm: InfoBlockingException = {
  code: 'preventing-harm',
  reasonText: 'clinician determined disclosure before call-back risks harm',
  determinedBy: 'clinician-assigned',
  expiresAt: '2026-06-06T09:00:00.000Z',
  patientNotice: 'Your clinician will call you about this result.',
};

describe('NR-096: the release deadline is effective without a sweep', () => {
  it('patientView as of a time past the deadline reports released, at the deadline', () => {
    const svc = new ResultsReleaseService(policies);
    svc.recordResult(scope('r-1'), 'lab', resultedAt);
    expect(svc.patientView(tenant, 'person-1', 'r-1', afterDeadline)).toEqual({
      status: 'released',
      resultId: 'r-1',
      releasedAt: deadline,
    });
  });

  it('a configured clock makes the plain patientView honour the deadline', () => {
    const svc = new ResultsReleaseService(policies, { now: () => afterDeadline });
    svc.recordResult(scope('r-1'), 'lab', resultedAt);
    expect(svc.patientView(tenant, 'person-1', 'r-1').status).toBe('released');
  });

  it('an exception applied after the deadline, before any sweep, is refused as a recall', () => {
    const svc = new ResultsReleaseService(policies);
    svc.recordResult(scope('r-1'), 'lab', resultedAt);
    expect(() => svc.applyException('r-1', harm, afterDeadline)).toThrow(/recall/);
    expect(svc.get('r-1').releasedAt).toBe(deadline);
  });
});

describe('NR-097: exceptions have a maximum duration and are never silently replaced', () => {
  const at = '2026-06-02T09:00:00.000Z';

  it('refuses an exception longer than the default 90 days, and accepts exactly 90', () => {
    const svc = new ResultsReleaseService(policies);
    svc.recordResult(scope('r-1'), 'lab', resultedAt);
    expect(() =>
      svc.applyException('r-1', { ...harm, expiresAt: '2026-08-31T09:00:00.001Z' }, at),
    ).toThrow(/at most 90 days/);
    expect(
      svc.applyException('r-1', { ...harm, expiresAt: '2026-08-31T09:00:00.000Z' }, at).exception
        ?.expiresAt,
    ).toBe('2026-08-31T09:00:00.000Z');
  });

  it('the maximum is tenant-configurable', () => {
    const svc = new ResultsReleaseService(policies, { maxExceptionDaysByTenant: { [tenant]: 7 } });
    svc.recordResult(scope('r-1'), 'lab', resultedAt);
    expect(svc.maxExceptionDays(tenant)).toBe(7);
    expect(() =>
      svc.applyException('r-1', { ...harm, expiresAt: '2026-06-10T09:00:00.000Z' }, at),
    ).toThrow(/at most 7 days/);
  });

  it('a live exception is not silently replaced; an explicit supersession keeps history', () => {
    const svc = new ResultsReleaseService(policies);
    svc.recordResult(scope('r-1'), 'lab', resultedAt);
    svc.applyException('r-1', harm, at);
    const privacy: InfoBlockingException = {
      ...harm,
      code: 'privacy',
      expiresAt: '2026-06-07T09:00:00.000Z',
    };
    expect(() => svc.applyException('r-1', privacy, '2026-06-03T09:00:00.000Z')).toThrow(
      /explicit supersession/,
    );
    expect(svc.get('r-1').exception?.code).toBe('preventing-harm');
    const next = svc.applyException('r-1', privacy, '2026-06-03T09:00:00.000Z', {
      reason: 'privacy review replaced the harm hold',
      by: 'privacy-officer-1',
    });
    expect(next.exception?.code).toBe('privacy');
    expect(next.events.map((event) => event.kind)).toEqual([
      'resulted',
      'exception-applied',
      'exception-superseded',
      'exception-applied',
    ]);
    expect(next.events.find((event) => event.kind === 'exception-superseded')).toMatchObject({
      previous: { code: 'preventing-harm' },
      by: 'privacy-officer-1',
    });
  });
});

describe('NR-101: instants are validated and result ids are tenant-scoped', () => {
  it('an unparseable resultedAt is a ResultsReleaseError, not a RangeError', () => {
    const svc = new ResultsReleaseService(policies);
    let caught: unknown;
    try {
      svc.recordResult(scope('r-1'), 'lab', 'not-a-date');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ResultsReleaseError);
    expect(() => svc.sweep('garbage')).toThrow(ResultsReleaseError);
  });

  it('two tenants may use the same result id, and each patient view stays in its tenant', () => {
    const svc = new ResultsReleaseService(policies);
    svc.recordResult(scope('r-1'), 'lab', resultedAt);
    svc.recordResult(scope('r-1', 'riverbend-synthetic'), 'lab', resultedAt);
    svc.clinicianRelease('r-1', 'clinician-b', '2026-06-02T09:00:00.000Z', 'riverbend-synthetic');
    expect(svc.patientView('riverbend-synthetic', 'person-1', 'r-1').status).toBe('released');
    expect(svc.patientView(tenant, 'person-1', 'r-1').status).toBe('in-review');
    expect(() => svc.get('r-1')).toThrow(/more than one tenant/);
  });
});

const records: SnapshotRecord[] = [
  { kind: 'note', recordId: 'n-0', personId: 'person-1', summary: 'synthetic note' },
];
const at = '2026-06-01T09:00:00.000Z';
const soap: SoapBody = {
  subjective: 'fatigue',
  objective: 'hr 72',
  assessment: 'stable',
  plan: 'follow-up',
};
const clinicalScope = (noteId: string): ClinicalScope => ({
  tenantId: tenant,
  personId: 'person-1',
  encounterId: 'enc-1',
  noteId,
});
const evidence: AthenaAttestation = {
  assignedSignerRef: 'clinician-assigned',
  sourceVersion: 'athena-sv-1',
  signedAt: at,
  attestationRef: 'att-1',
  synthetic: true,
};

describe('NR-098: downtime reconcile needs a back-entered reference', () => {
  it('refuses an empty or blank backEnteredRef and keeps the capture in the queue', () => {
    const kit = new DowntimeKit(tenant, () => records);
    kit.declareOutage('lead', 'drill', at);
    const capture = kit.capturePaper('downtime-encounter-note', 'person-1', 'vitals', 'nurse', at);
    kit.beginRecovery(at);
    expect(() => kit.reconcile(capture.captureId, '')).toThrow(/reference/);
    expect(() => kit.reconcile(capture.captureId, '   ')).toThrow(DowntimeError);
    expect(kit.backEntryQueue()).toHaveLength(1);
  });
});

describe('NR-099: the online-write guard is wired and allows back-entry in recovery', () => {
  it('encounter notes and the med list refuse writes during downtime', () => {
    const kit = new DowntimeKit(tenant, () => records);
    const notes = new EncounterNoteService(kit);
    const meds = new MedicationList(tenant, 'person-1', kit);
    meds.claimOwner('clinician-1');
    kit.declareOutage('lead', 'drill', at);
    expect(() => notes.openDraft(clinicalScope('n-1'), soap, 'clinician-1')).toThrow(DowntimeError);
    expect(() => meds.add('m-1', 'synthetic med', 'clinician-1')).toThrow(DowntimeError);
  });

  it('in recovery a normal write is still refused, but a back-entry write goes through and reconciles', () => {
    const kit = new DowntimeKit(tenant, () => records);
    const notes = new EncounterNoteService(kit);
    const meds = new MedicationList(tenant, 'person-1', kit);
    meds.claimOwner('clinician-1');
    kit.declareOutage('lead', 'drill', at);
    const noteCapture = kit.capturePaper(
      'downtime-encounter-note',
      'person-1',
      'vitals',
      'nurse',
      at,
    );
    const medCapture = kit.capturePaper(
      'downtime-medication-administration',
      'person-1',
      'med given',
      'nurse',
      at,
    );
    kit.beginRecovery(at);
    expect(() => notes.openDraft(clinicalScope('n-x'), soap, 'clinician-1')).toThrow(DowntimeError);
    const backNote = kit.backEnter(
      noteCapture.captureId,
      () => notes.openDraft(clinicalScope('n-2'), soap, 'clinician-1').scope.noteId,
    );
    expect(backNote.backEnteredRef).toBe('n-2');
    const backMed = kit.backEnter(
      medCapture.captureId,
      () => meds.add('m-2', 'synthetic med', 'clinician-1').itemId,
    );
    expect(backMed.backEnteredRef).toBe('m-2');
    expect(() => meds.add('m-3', 'late write', 'clinician-1')).toThrow(DowntimeError);
    kit.completeRecovery();
    notes.approveForTransmission('n-2', 'reviewer-1');
    expect(notes.attest('n-2', clinicalScope('n-2'), 'clinician-assigned', evidence).state).toBe(
      'signed-in-authority',
    );
  });
});
