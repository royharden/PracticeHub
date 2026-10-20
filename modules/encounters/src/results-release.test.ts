import { describe, expect, it } from 'vitest';

import {
  ResultsReleaseError,
  ResultsReleaseService,
  type ExceptionCode,
  type InfoBlockingException,
  type ReleasePolicy,
  type ResultScope,
} from './results-release.js';

const policies: ReleasePolicy[] = [
  { category: 'lab', reviewWindowHours: 72, synthetic: true },
  { category: 'pathology', reviewWindowHours: 0, synthetic: true },
];

function scope(resultId: string, personId = 'person-1'): ResultScope {
  return { tenantId: 'northwind-synthetic', personId, resultId };
}

const resultedAt = '2026-06-01T09:00:00.000Z';
const deadline = '2026-06-04T09:00:00.000Z';

const harm: InfoBlockingException = {
  code: 'preventing-harm',
  reasonText: 'clinician determined disclosure before call-back risks harm',
  determinedBy: 'clinician-assigned',
  expiresAt: '2026-06-06T09:00:00.000Z',
  patientNotice: 'Your clinician will call you about this result.',
};

describe('ResultsReleaseService', () => {
  it('holds a result in review until the deadline, then auto-releases it', () => {
    const svc = new ResultsReleaseService(policies);
    const held = svc.recordResult(scope('r-1'), 'lab', resultedAt);
    expect(held.releaseDueAt).toBe(deadline);
    expect(svc.sweep('2026-06-04T08:59:59.000Z')).toHaveLength(0);
    expect(svc.patientView('northwind-synthetic', 'person-1', 'r-1')).toEqual({
      status: 'in-review',
      resultId: 'r-1',
      availableBy: deadline,
    });
    const released = svc.sweep(deadline);
    expect(released.map((r) => r.scope.resultId)).toEqual(['r-1']);
    expect(svc.get('r-1').events.at(-1)).toMatchObject({ kind: 'released', by: 'auto-deadline' });
    expect(svc.patientView('northwind-synthetic', 'person-1', 'r-1').status).toBe('released');
  });

  it('a clinician may release before the deadline', () => {
    const svc = new ResultsReleaseService(policies);
    svc.recordResult(scope('r-1'), 'lab', resultedAt);
    const released = svc.clinicianRelease('r-1', 'clinician-assigned', '2026-06-02T09:00:00.000Z');
    expect(released.releasedAt).toBe('2026-06-02T09:00:00.000Z');
    expect(svc.sweep(deadline)).toHaveLength(0);
  });

  it('an unknown category fails toward immediate release', () => {
    const svc = new ResultsReleaseService(policies);
    svc.recordResult(scope('r-9'), 'uncatalogued', resultedAt);
    expect(svc.sweep(resultedAt).map((r) => r.scope.resultId)).toEqual(['r-9']);
  });

  it('NEGATIVE: release is never gated on payment', () => {
    // A synthetic ledger shows a balance due. Release has no payment input,
    // and a fees/payment hold is refused outright.
    const ledgerBalanceDue = new Map([['person-1', 480_00]]);
    const svc = new ResultsReleaseService(policies);
    svc.recordResult(scope('r-1'), 'lab', resultedAt);
    for (const code of ['fees', 'payment', 'balance-due']) {
      expect(() =>
        svc.applyException('r-1', { ...harm, code: code as ExceptionCode }, resultedAt),
      ).toThrow(/cannot hold a patient's access/);
    }
    expect(ledgerBalanceDue.get('person-1')).toBeGreaterThan(0);
    expect(svc.sweep(deadline).map((r) => r.scope.resultId)).toEqual(['r-1']);
    expect(svc.patientView('northwind-synthetic', 'person-1', 'r-1').status).toBe('released');
  });

  it('a reason-coded exception holds past the deadline and is visible to the patient', () => {
    const svc = new ResultsReleaseService(policies);
    svc.recordResult(scope('r-1'), 'lab', resultedAt);
    svc.applyException('r-1', harm, '2026-06-02T09:00:00.000Z');
    expect(svc.sweep(deadline)).toHaveLength(0);
    expect(svc.patientView('northwind-synthetic', 'person-1', 'r-1')).toEqual({
      status: 'withheld',
      resultId: 'r-1',
      exceptionCode: 'preventing-harm',
      notice: 'Your clinician will call you about this result.',
      reviewBy: harm.expiresAt,
    });
  });

  it('an exception lapses at expiry and the result auto-releases', () => {
    const svc = new ResultsReleaseService(policies);
    svc.recordResult(scope('r-1'), 'lab', resultedAt);
    svc.applyException('r-1', harm, '2026-06-02T09:00:00.000Z');
    const released = svc.sweep(harm.expiresAt);
    expect(released).toHaveLength(1);
    const kinds = svc.get('r-1').events.map((e) => e.kind);
    expect(kinds).toEqual(['resulted', 'exception-applied', 'exception-lapsed', 'released']);
  });

  it('NEGATIVE: a silent denial cannot be recorded', () => {
    const svc = new ResultsReleaseService(policies);
    svc.recordResult(scope('r-1'), 'lab', resultedAt);
    const at = '2026-06-02T09:00:00.000Z';
    expect(() => svc.applyException('r-1', { ...harm, reasonText: ' ' }, at)).toThrow(
      ResultsReleaseError,
    );
    expect(() => svc.applyException('r-1', { ...harm, patientNotice: '' }, at)).toThrow(
      /patient notice/,
    );
    expect(() => svc.applyException('r-1', { ...harm, determinedBy: '' }, at)).toThrow(
      /determination/,
    );
    expect(() => svc.applyException('r-1', { ...harm, expiresAt: at }, at)).toThrow(/time-bounded/);
    expect(() =>
      svc.applyException('r-1', { ...harm, code: 'clinician-preference' as ExceptionCode }, at),
    ).toThrow(/unknown information-blocking exception/);
    expect(svc.get('r-1').exception).toBeNull();
  });

  it('an exception cannot recall a released result', () => {
    const svc = new ResultsReleaseService(policies);
    svc.recordResult(scope('r-1'), 'pathology', resultedAt);
    svc.sweep(resultedAt);
    expect(() => svc.applyException('r-1', harm, resultedAt)).toThrow(/recall/);
  });

  it('refuses a patient view across patient scope', () => {
    const svc = new ResultsReleaseService(policies);
    svc.recordResult(scope('r-1'), 'lab', resultedAt);
    expect(() => svc.patientView('northwind-synthetic', 'person-2', 'r-1')).toThrow(
      /patient scope/,
    );
  });

  it('refuses a negative review window', () => {
    expect(
      () =>
        new ResultsReleaseService([{ category: 'lab', reviewWindowHours: -1, synthetic: true }]),
    ).toThrow(/invalid review window/);
  });
});
