import { describe, expect, it } from 'vitest';

import { LabBook } from './book.js';
import { LabError } from './errors.js';

// WP-064 rework 1 (review D49-WP-064-a1-review-1). Each test fails on 064d978.

const tenantId = 'tenant-synthetic-a';
const synthetic = true as const;
const calibration = {
  deviceId: 'device-1',
  lotId: 'lot-1',
  calibratedAt: '2026-09-25T08:00:00Z',
  method: 'two-point',
};

function setup(): LabBook {
  const labs = new LabBook();
  labs.placeOrder({
    tenantId,
    orderId: 'order-1',
    subjectRef: 'member-synthetic-1',
    code: '6298-4',
    display: 'Potassium',
    orderedAt: '2026-09-25T12:00:00Z',
    expectedResultBy: '2026-09-25T18:00:00Z',
    synthetic,
  });
  return labs;
}

function manual(labs: LabBook, value: string, critical: boolean): void {
  labs.enterOutageManual({
    tenantId,
    orderId: 'order-1',
    resultId: 'manual-1',
    value,
    critical,
    enteredAt: '2026-09-25T13:00:00Z',
    readBack: {
      readBackBy: 'nurse-synthetic-1',
      readBackAt: '2026-09-25T13:01:00Z',
      confirmedValue: value,
    },
    synthetic,
  });
}

function electronic(labs: LabBook, value: string, critical: boolean) {
  return labs.reconcileElectronic({
    tenantId,
    orderId: 'order-1',
    manualResultId: 'manual-1',
    resultId: 'electronic-1',
    value,
    critical,
    recordedAt: '2026-09-25T14:00:00Z',
    synthetic,
  });
}

function adjudicate(labs: LabBook, decision: 'keep-manual' | 'accept-electronic') {
  return labs.adjudicateConflict({
    tenantId,
    orderId: 'order-1',
    decision,
    actorRef: 'clinician-synthetic-1',
    at: '2026-09-25T15:00:00Z',
    synthetic,
  });
}

describe('F1: every critical value that becomes current is paged exactly once', () => {
  it('a critical electronic value in conflict pages at once and stays paged when accepted', () => {
    const labs = setup();
    manual(labs, '4.9', false);
    electronic(labs, '6.9', true);
    expect(labs.closureFor(tenantId, 'electronic-1').phase).toBe('paged');
    adjudicate(labs, 'accept-electronic');
    expect(labs.currentResult(tenantId, 'order-1')?.resultId).toBe('electronic-1');
    expect(labs.closuresForOrder(tenantId, 'order-1').map((c) => c.resultId)).toEqual([
      'electronic-1',
    ]);
  });

  it('a matched critical value keeps the one closure it already has', () => {
    const labs = setup();
    manual(labs, '6.9', true);
    electronic(labs, '6.9', true);
    expect(labs.currentResult(tenantId, 'order-1')?.resultId).toBe('electronic-1');
    expect(labs.closuresForOrder(tenantId, 'order-1').map((c) => c.resultId)).toEqual(['manual-1']);
  });

  it('a matched value that only the electronic feed flags critical is paged', () => {
    const labs = setup();
    manual(labs, '6.9', false);
    electronic(labs, '6.9', true);
    expect(labs.closuresForOrder(tenantId, 'order-1').map((c) => c.resultId)).toEqual([
      'electronic-1',
    ]);
  });
});

describe('F2: keep-manual finalizes the manual value', () => {
  it('the kept manual value is final and current, the order is resulted, the electronic value is not final', () => {
    const labs = setup();
    manual(labs, '4.9', false);
    electronic(labs, '5.2', false);
    adjudicate(labs, 'keep-manual');
    const kept = labs.readResult(tenantId, 'manual-1');
    const rejected = labs.readResult(tenantId, 'electronic-1');
    expect(kept.provisional).toBe(false);
    expect(kept.reconciliation).toBe('adjudicated-manual');
    expect(rejected.provisional).toBe(true);
    expect(labs.currentResult(tenantId, 'order-1')?.resultId).toBe('manual-1');
    expect(labs.orderStatus(tenantId, 'order-1')).toBe('resulted');
  });

  it('accept-electronic leaves the manual value provisional and the electronic value final', () => {
    const labs = setup();
    manual(labs, '4.9', false);
    electronic(labs, '5.2', false);
    adjudicate(labs, 'accept-electronic');
    expect(labs.readResult(tenantId, 'manual-1').provisional).toBe(true);
    expect(labs.readResult(tenantId, 'electronic-1').provisional).toBe(false);
    expect(labs.orderStatus(tenantId, 'order-1')).toBe('resulted');
  });
});

describe('F3: device results can be corrected', () => {
  it('a device correction supersedes the prior device result with fresh calibration', () => {
    const labs = setup();
    labs.ingestDeviceResult({
      tenantId,
      orderId: 'order-1',
      resultId: 'device-r1',
      value: '5.0',
      critical: false,
      recordedAt: '2026-09-25T13:00:00Z',
      calibration,
      synthetic,
    });
    const corrected = labs.correctResult({
      tenantId,
      orderId: 'order-1',
      priorResultId: 'device-r1',
      resultId: 'device-r2',
      value: '4.0',
      critical: false,
      recordedAt: '2026-09-25T14:00:00Z',
      calibration: { ...calibration, calibratedAt: '2026-09-25T13:30:00Z' },
      synthetic,
    });
    expect(corrected.source).toBe('device');
    expect(corrected.supersedesResultId).toBe('device-r1');
    expect(labs.currentResult(tenantId, 'order-1')?.resultId).toBe('device-r2');
  });

  it('a pending manual result is still refused with an accurate message', () => {
    const labs = setup();
    manual(labs, '4.9', false);
    expect(() =>
      labs.correctResult({
        tenantId,
        orderId: 'order-1',
        priorResultId: 'manual-1',
        resultId: 'result-2',
        value: '4.0',
        critical: false,
        recordedAt: '2026-09-25T14:00:00Z',
        synthetic,
      }),
    ).toThrow(/pending reconciliation/);
  });

  it('a device correction without calibration stores nothing', () => {
    const labs = setup();
    labs.ingestDeviceResult({
      tenantId,
      orderId: 'order-1',
      resultId: 'device-r1',
      value: '5.0',
      critical: false,
      recordedAt: '2026-09-25T13:00:00Z',
      calibration,
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
        synthetic,
      }),
    ).toThrow(LabError);
    expect(labs.currentResult(tenantId, 'order-1')?.resultId).toBe('device-r1');
  });
});

describe('F4: the aging WorkItem resolves when the result arrives', () => {
  it('resolves on the first result for an aged order', () => {
    const labs = setup();
    labs.ageExpectedResults('2026-09-25T19:00:00Z');
    labs.recordElectronicResult({
      tenantId,
      orderId: 'order-1',
      resultId: 'result-1',
      value: '4.1',
      critical: false,
      recordedAt: '2026-09-25T20:00:00Z',
      synthetic,
    });
    expect(labs.agingFor(tenantId, 'order-1')?.workItem.status).toBe('resolved');
  });
});
