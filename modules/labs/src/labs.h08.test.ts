import { describe, expect, it } from 'vitest';

import { LabBook } from './book.js';
import { LabError } from './errors.js';

// Hardening H-08 (NR-142, NR-143, NR-109, NR-110). Each test fails on
// candidates/D53-WP-064-a2 and passes after.

const tenantId = 'tenant-synthetic-a';
const synthetic = true as const;
const calibration = {
  deviceId: 'device-1',
  lotId: 'lot-1',
  calibratedAt: '2026-09-25T08:00:00Z',
  method: 'two-point',
};

function setup(orderIds: readonly string[] = ['order-1']): LabBook {
  const labs = new LabBook();
  for (const orderId of orderIds) {
    labs.placeOrder({
      tenantId,
      orderId,
      subjectRef: 'member-synthetic-1',
      code: '6298-4',
      display: 'Potassium',
      orderedAt: '2026-09-25T12:00:00Z',
      expectedResultBy: '2026-09-25T18:00:00Z',
      synthetic,
    });
  }
  return labs;
}

const readBack = (value: string, at = '2026-09-25T13:01:00Z') => ({
  readBackBy: 'nurse-synthetic-1',
  readBackAt: at,
  confirmedValue: value,
});

function conflict(
  labs: LabBook,
  manualValue: string,
  manualCritical: boolean,
  electronicValue: string,
  electronicCritical: boolean,
) {
  labs.enterOutageManual({
    tenantId,
    orderId: 'order-1',
    resultId: 'manual-1',
    value: manualValue,
    critical: manualCritical,
    enteredAt: '2026-09-25T13:00:00Z',
    readBack: readBack(manualValue),
    synthetic,
  });
  labs.reconcileElectronic({
    tenantId,
    orderId: 'order-1',
    manualResultId: 'manual-1',
    resultId: 'electronic-1',
    value: electronicValue,
    critical: electronicCritical,
    recordedAt: '2026-09-25T14:00:00Z',
    synthetic,
  });
}

const keepManual = (labs: LabBook) =>
  labs.adjudicateConflict({
    tenantId,
    orderId: 'order-1',
    decision: 'keep-manual',
    actorRef: 'clinician-synthetic-1',
    at: '2026-09-25T15:00:00Z',
    synthetic,
  });

describe('NR-142: a critical value rejected by keep-manual closes as superseded, with an audit', () => {
  it('ends the rejected electronic closure as superseded and resolves its WorkItem', () => {
    const labs = setup();
    conflict(labs, '4.9', false, '6.9', true);
    expect(labs.closureFor(tenantId, 'electronic-1').phase).toBe('paged');
    keepManual(labs);
    const closure = labs.closureFor(tenantId, 'electronic-1');
    expect(closure.phase).toBe('superseded');
    expect(closure.supersededBy).toBe('clinician-synthetic-1');
    expect(closure.supersededAt).toBe('2026-09-25T15:00:00Z');
    expect(closure.supersededReason).toMatch(/keep-manual/);
    expect(closure.closedAt).toBeNull();
    expect(closure.workItem.status).toBe('resolved');
  });

  it('supersedes an acknowledged closure too, and never touches a kept critical manual closure', () => {
    const labs = setup();
    conflict(labs, '7.1', true, '6.9', true);
    labs.acknowledgeCritical({
      tenantId,
      resultId: 'electronic-1',
      actorRef: 'clinician-synthetic-2',
      at: '2026-09-25T14:10:00Z',
      synthetic,
    });
    keepManual(labs);
    expect(labs.closureFor(tenantId, 'electronic-1').phase).toBe('superseded');
    expect(labs.closureFor(tenantId, 'manual-1').phase).toBe('paged');
  });
});

describe('NR-143: correcting a kept manual result stays manual', () => {
  it('a correction of the kept manual value is a manual, final result with its read-back', () => {
    const labs = setup();
    conflict(labs, '4.9', false, '5.2', false);
    keepManual(labs);
    const corrected = labs.correctResult({
      tenantId,
      orderId: 'order-1',
      priorResultId: 'manual-1',
      resultId: 'manual-2',
      value: '4.7',
      critical: false,
      recordedAt: '2026-09-25T16:00:00Z',
      readBack: readBack('4.7', '2026-09-25T16:01:00Z'),
      synthetic,
    });
    expect(corrected.source).toBe('manual');
    expect(corrected.provisional).toBe(false);
    expect(corrected.reconciliation).toBe('adjudicated-manual');
    expect(corrected.readBack?.confirmedValue).toBe('4.7');
    expect(corrected.supersedesResultId).toBe('manual-1');
    expect(labs.currentResult(tenantId, 'order-1')?.resultId).toBe('manual-2');
  });

  it('refuses a manual correction without a read-back and stores nothing', () => {
    const labs = setup();
    conflict(labs, '4.9', false, '5.2', false);
    keepManual(labs);
    expect(() =>
      labs.correctResult({
        tenantId,
        orderId: 'order-1',
        priorResultId: 'manual-1',
        resultId: 'manual-2',
        value: '4.7',
        critical: false,
        recordedAt: '2026-09-25T16:00:00Z',
        synthetic,
      }),
    ).toThrow(LabError);
    expect(labs.currentResult(tenantId, 'order-1')?.resultId).toBe('manual-1');
  });
});

describe('NR-109: a recall marks ingested results and flags later ingests', () => {
  const ingest = (
    labs: LabBook,
    orderId: string,
    resultId: string,
    lotId: string,
    recordedAt: string,
  ) =>
    labs.ingestDeviceResult({
      tenantId,
      orderId,
      resultId,
      value: '5.0',
      critical: false,
      recordedAt,
      calibration: { ...calibration, lotId },
      synthetic,
    });

  it('marks results already in the recalled cohort', () => {
    const labs = setup(['order-1']);
    ingest(labs, 'order-1', 'device-a', 'lot-1', '2026-09-25T13:00:00Z');
    const cohort = labs.widenRecallCohort({
      tenantId,
      deviceId: 'device-1',
      lotId: 'lot-1',
      recalledAt: '2026-09-25T14:00:00Z',
      synthetic,
    });
    expect(labs.readResult(tenantId, 'device-a').recallIds).toEqual([cohort.recallId]);
  });

  it('flags a later ingest from the recalled device and lot, and leaves another lot unflagged', () => {
    const labs = setup(['order-1', 'order-2', 'order-3']);
    ingest(labs, 'order-1', 'device-a', 'lot-1', '2026-09-25T13:00:00Z');
    const cohort = labs.widenRecallCohort({
      tenantId,
      deviceId: 'device-1',
      lotId: 'lot-1',
      recalledAt: '2026-09-25T14:00:00Z',
      synthetic,
    });
    const later = ingest(labs, 'order-2', 'device-b', 'lot-1', '2026-09-25T15:00:00Z');
    const otherLot = ingest(labs, 'order-3', 'device-c', 'lot-2', '2026-09-25T15:30:00Z');
    expect(later.recallIds).toEqual([cohort.recallId]);
    expect(otherLot.recallIds).toBeUndefined();
    const widened = labs.widenRecallCohort({
      tenantId,
      deviceId: 'device-1',
      lotId: 'lot-1',
      recalledAt: '2026-09-25T14:00:00Z',
      synthetic,
    });
    expect(widened.resultIds).toEqual(['device-a', 'device-b']);
  });
});

describe('NR-110: calibration cannot post-date the reading', () => {
  it('refuses calibratedAt after recordedAt on ingest and stores nothing', () => {
    const labs = setup();
    expect(() =>
      labs.ingestDeviceResult({
        tenantId,
        orderId: 'order-1',
        resultId: 'device-late',
        value: '5.0',
        critical: false,
        recordedAt: '2026-09-25T13:00:00Z',
        calibration: { ...calibration, calibratedAt: '2026-09-25T13:00:01Z' },
        synthetic,
      }),
    ).toThrow(LabError);
    expect(labs.currentResult(tenantId, 'order-1')).toBeNull();
  });

  it('accepts calibration at the reading instant, and refuses a late one on a device correction', () => {
    const labs = setup();
    labs.ingestDeviceResult({
      tenantId,
      orderId: 'order-1',
      resultId: 'device-r1',
      value: '5.0',
      critical: false,
      recordedAt: '2026-09-25T13:00:00Z',
      calibration: { ...calibration, calibratedAt: '2026-09-25T13:00:00Z' },
      synthetic,
    });
    expect(() =>
      labs.correctResult({
        tenantId,
        orderId: 'order-1',
        priorResultId: 'device-r1',
        resultId: 'device-r2',
        value: '4.0',
        critical: false,
        recordedAt: '2026-09-25T14:00:00Z',
        calibration: { ...calibration, calibratedAt: '2026-09-25T14:30:00Z' },
        synthetic,
      }),
    ).toThrow(LabError);
    expect(labs.currentResult(tenantId, 'order-1')?.resultId).toBe('device-r1');
  });
});
