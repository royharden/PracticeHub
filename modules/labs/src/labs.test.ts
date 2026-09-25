import { describe, expect, it } from 'vitest';

import { LabBook } from './book.js';
import { LabError } from './errors.js';

const tenantId = 'tenant-synthetic-a';
const subjectRef = 'member-synthetic-1';

function book(): LabBook {
  return new LabBook();
}

function order(
  labs: LabBook,
  input: { readonly orderId?: string; readonly expectedResultBy?: string } = {},
) {
  return labs.placeOrder({
    tenantId,
    orderId: input.orderId ?? 'order-1',
    subjectRef,
    code: '6298-4',
    display: 'Potassium',
    orderedAt: '2026-09-25T12:00:00Z',
    expectedResultBy: input.expectedResultBy ?? '2026-09-25T18:00:00Z',
    synthetic: true,
  });
}

describe('WP-064 labs', () => {
  it('a corrected result supersedes the prior result and keeps the prior readable', () => {
    const labs = book();
    order(labs);
    labs.recordElectronicResult({
      tenantId,
      orderId: 'order-1',
      resultId: 'result-1',
      value: '5.1',
      critical: false,
      recordedAt: '2026-09-25T13:00:00Z',
      synthetic: true,
    });
    const corrected = labs.correctResult({
      tenantId,
      orderId: 'order-1',
      priorResultId: 'result-1',
      resultId: 'result-2',
      value: '4.2',
      critical: false,
      recordedAt: '2026-09-25T14:00:00Z',
      synthetic: true,
    });
    const prior = labs.readResult(tenantId, 'result-1');
    expect(corrected.supersedesResultId).toBe('result-1');
    expect(corrected.value).toBe('4.2');
    expect(prior.value).toBe('5.1');
    expect(prior.observation.resourceType).toBe('Observation');
    expect(labs.currentResult(tenantId, 'order-1')?.resultId).toBe('result-2');
    expect(labs.history(tenantId, 'order-1').map((result) => result.resultId)).toEqual([
      'result-1',
      'result-2',
    ]);
    expect(() =>
      labs.correctResult({
        tenantId,
        orderId: 'order-1',
        priorResultId: 'result-1',
        resultId: 'result-3',
        value: '4.0',
        critical: false,
        recordedAt: '2026-09-25T15:00:00Z',
        synthetic: true,
      }),
    ).toThrow(LabError);
  });

  it('critical-result closure walks page, acknowledge, contact, and close', () => {
    const labs = book();
    order(labs, { orderId: 'order-crit' });
    const result = labs.recordElectronicResult({
      tenantId,
      orderId: 'order-crit',
      resultId: 'result-crit',
      value: '6.8',
      critical: true,
      recordedAt: '2026-09-25T13:00:00Z',
      synthetic: true,
    });
    const paged = labs.closureFor(tenantId, result.resultId);
    expect(paged.phase).toBe('paged');
    expect(paged.workItem.purpose).toBe('lab.critical-closure');
    expect(paged.workItem.origin).toBe('admin');
    expect(paged.workItem.risk).toBe('critical');
    expect(() =>
      labs.closeCritical({
        tenantId,
        resultId: result.resultId,
        actorRef: 'clinician-synthetic-1',
        at: '2026-09-25T13:30:00Z',
        synthetic: true,
      }),
    ).toThrow(LabError);
    labs.acknowledgeCritical({
      tenantId,
      resultId: result.resultId,
      actorRef: 'clinician-synthetic-1',
      at: '2026-09-25T13:10:00Z',
      synthetic: true,
    });
    labs.recordCriticalContact({
      tenantId,
      resultId: result.resultId,
      at: '2026-09-25T13:20:00Z',
      evidence: 'phone-contact-synthetic-1',
      synthetic: true,
    });
    const closed = labs.closeCritical({
      tenantId,
      resultId: result.resultId,
      actorRef: 'clinician-synthetic-1',
      at: '2026-09-25T13:30:00Z',
      synthetic: true,
    });
    expect(closed.phase).toBe('closed');
    expect(closed.acknowledgedBy).toBe('clinician-synthetic-1');
    expect(closed.contactEvidence).toBe('phone-contact-synthetic-1');
    expect(closed.closedBy).toBe('clinician-synthetic-1');
    expect(closed.workItem.status).toBe('resolved');
    expect(closed.workItem.ownerRef).toBe('clinician-synthetic-1');
  });

  it('expected results age into the lab queue and an undue order stays off it', () => {
    const labs = book();
    order(labs, { orderId: 'order-due', expectedResultBy: '2026-09-25T16:00:00Z' });
    order(labs, { orderId: 'order-later', expectedResultBy: '2026-09-26T16:00:00Z' });
    const queue = labs.ageExpectedResults('2026-09-25T18:00:00Z');
    expect(queue.map((row) => row.orderId)).toEqual(['order-due']);
    expect(queue[0]?.workItem.purpose).toBe('lab.expected-result-aging');
    expect(queue[0]?.workItem.poolId).toBe('lab-expected-results');
    expect(queue[0]?.workItem.origin).toBe('admin');
    expect(queue[0]?.workItem.status).toBe('unmatched');
    const again = labs.ageExpectedResults('2026-09-25T19:00:00Z');
    expect(again).toHaveLength(1);
    expect(again[0]?.workItem.workItemId).toBe(queue[0]?.workItem.workItemId);
  });

  it('outage manual entry requires read-back, stays provisional, and conflicts are not silent', () => {
    const labs = book();
    order(labs, { orderId: 'order-outage' });
    expect(() =>
      labs.enterOutageManual({
        tenantId,
        orderId: 'order-outage',
        resultId: 'manual-1',
        value: '6.4',
        critical: false,
        enteredAt: '2026-09-25T13:00:00Z',
        readBack: {
          readBackBy: 'nurse-synthetic-1',
          readBackAt: '2026-09-25T13:00:00Z',
          confirmedValue: '6.5',
        },
        synthetic: true,
      }),
    ).toThrow(LabError);
    const manual = labs.enterOutageManual({
      tenantId,
      orderId: 'order-outage',
      resultId: 'manual-1',
      value: '6.4',
      critical: false,
      enteredAt: '2026-09-25T13:00:00Z',
      readBack: {
        readBackBy: 'nurse-synthetic-1',
        readBackAt: '2026-09-25T13:00:00Z',
        confirmedValue: '6.4',
      },
      synthetic: true,
    });
    expect(manual.provisional).toBe(true);
    expect(manual.readBack?.readBackBy).toBe('nurse-synthetic-1');
    expect(manual.source).toBe('manual');
    const conflict = labs.reconcileElectronic({
      tenantId,
      orderId: 'order-outage',
      manualResultId: 'manual-1',
      resultId: 'electronic-1',
      value: '5.2',
      critical: false,
      recordedAt: '2026-09-25T15:00:00Z',
      synthetic: true,
    });
    expect(conflict.state).toBe('conflict');
    expect(labs.currentResult(tenantId, 'order-outage')?.resultId).toBe('manual-1');
    expect(labs.readResult(tenantId, 'manual-1').value).toBe('6.4');
    expect(labs.readResult(tenantId, 'electronic-1').value).toBe('5.2');
    const decided = labs.adjudicateConflict({
      tenantId,
      orderId: 'order-outage',
      decision: 'accept-electronic',
      actorRef: 'clinician-synthetic-1',
      at: '2026-09-25T16:00:00Z',
      synthetic: true,
    });
    expect(decided.decision).toBe('accept-electronic');
    expect(labs.currentResult(tenantId, 'order-outage')?.resultId).toBe('electronic-1');
    expect(labs.readResult(tenantId, 'manual-1').provisional).toBe(true);
    expect(labs.readResult(tenantId, 'manual-1').value).toBe('6.4');
  });

  it('a matching electronic reconciliation keeps the manual read-back readable', () => {
    const labs = book();
    order(labs, { orderId: 'order-match' });
    labs.enterOutageManual({
      tenantId,
      orderId: 'order-match',
      resultId: 'manual-2',
      value: '4.4',
      critical: false,
      enteredAt: '2026-09-25T13:00:00Z',
      readBack: {
        readBackBy: 'nurse-synthetic-1',
        readBackAt: '2026-09-25T13:00:00Z',
        confirmedValue: '4.4',
      },
      synthetic: true,
    });
    const matched = labs.reconcileElectronic({
      tenantId,
      orderId: 'order-match',
      manualResultId: 'manual-2',
      resultId: 'electronic-2',
      value: '4.4',
      critical: false,
      recordedAt: '2026-09-25T15:00:00Z',
      synthetic: true,
    });
    expect(matched.state).toBe('matched');
    expect(labs.currentResult(tenantId, 'order-match')?.resultId).toBe('electronic-2');
    expect(labs.readResult(tenantId, 'manual-2').value).toBe('4.4');
    expect(labs.readResult(tenantId, 'manual-2').provisional).toBe(true);
  });

  it('a device result carries calibration metadata and rejects a result that lacks it', () => {
    const labs = book();
    order(labs, { orderId: 'order-device' });
    expect(() =>
      labs.ingestDeviceResult({
        tenantId,
        orderId: 'order-device',
        resultId: 'device-missing',
        value: '42',
        critical: false,
        recordedAt: '2026-09-25T13:00:00Z',
        calibration: null,
        synthetic: true,
      }),
    ).toThrow(LabError);
    expect(labs.currentResult(tenantId, 'order-device')).toBeNull();
    const ingested = labs.ingestDeviceResult({
      tenantId,
      orderId: 'order-device',
      resultId: 'device-1',
      value: '42',
      critical: false,
      recordedAt: '2026-09-25T13:00:00Z',
      calibration: {
        deviceId: 'dexa-1',
        lotId: 'lot-a',
        calibratedAt: '2026-09-01T00:00:00Z',
        method: 'phantom-scan',
      },
      synthetic: true,
    });
    expect(ingested.source).toBe('device');
    expect(ingested.calibration).toEqual({
      deviceId: 'dexa-1',
      lotId: 'lot-a',
      calibratedAt: '2026-09-01T00:00:00Z',
      method: 'phantom-scan',
    });
  });

  it('a recall cohort widens to every result from the recalled device and lot', () => {
    const labs = book();
    order(labs, { orderId: 'order-a' });
    order(labs, { orderId: 'order-b' });
    order(labs, { orderId: 'order-c' });
    const calibration = {
      deviceId: 'dexa-1',
      lotId: 'lot-a',
      calibratedAt: '2026-09-01T00:00:00Z',
      method: 'phantom-scan',
    };
    labs.ingestDeviceResult({
      tenantId,
      orderId: 'order-a',
      resultId: 'device-a',
      value: '11',
      critical: false,
      recordedAt: '2026-09-25T13:00:00Z',
      calibration,
      synthetic: true,
    });
    const first = labs.widenRecallCohort({
      tenantId,
      deviceId: 'dexa-1',
      lotId: 'lot-a',
      recalledAt: '2026-09-25T14:00:00Z',
      synthetic: true,
    });
    expect(first.resultIds).toEqual(['device-a']);
    labs.ingestDeviceResult({
      tenantId,
      orderId: 'order-b',
      resultId: 'device-b',
      value: '12',
      critical: false,
      recordedAt: '2026-09-25T15:00:00Z',
      calibration,
      synthetic: true,
    });
    labs.ingestDeviceResult({
      tenantId,
      orderId: 'order-c',
      resultId: 'device-c',
      value: '13',
      critical: false,
      recordedAt: '2026-09-25T15:30:00Z',
      calibration: { ...calibration, lotId: 'lot-b' },
      synthetic: true,
    });
    const widened = labs.widenRecallCohort({
      tenantId,
      deviceId: 'dexa-1',
      lotId: 'lot-a',
      recalledAt: '2026-09-25T16:00:00Z',
      synthetic: true,
    });
    expect(widened.resultIds).toEqual(['device-a', 'device-b']);
    expect(widened.resultIds).not.toContain('device-c');
  });
});
