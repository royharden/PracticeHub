import { describe, expect, it } from 'vitest';

import { DowntimeError, DowntimeKit, runDowntimeDrill, type SnapshotRecord } from './downtime.js';

const records: SnapshotRecord[] = [
  { kind: 'result', recordId: 'r-1', personId: 'person-1', summary: 'synthetic CBC normal' },
  { kind: 'medication', recordId: 'm-1', personId: 'person-1', summary: 'synthetic med A' },
  { kind: 'result', recordId: 'r-2', personId: 'person-2', summary: 'synthetic lipid panel' },
];

const at = '2026-06-01T09:00:00.000Z';

describe('DowntimeKit', () => {
  it('downtime drill passes end to end', () => {
    const kit = new DowntimeKit('northwind-synthetic', () => records);
    const report = runDowntimeDrill(kit, 'person-1', at);
    expect(report.steps.map((s) => [s.step, s.ok])).toEqual([
      ['declare', true],
      ['snapshot', true],
      ['online-write-refused', true],
      ['paper-capture', true],
      ['recover', true],
      ['back-entry', true],
      ['online', true],
    ]);
    expect(report.passed).toBe(true);
    expect(kit.currentMode).toBe('online');
  });

  it('the drill fails when the snapshot is empty for the patient', () => {
    const kit = new DowntimeKit('northwind-synthetic', () => []);
    const report = runDowntimeDrill(kit, 'person-1', at);
    expect(report.passed).toBe(false);
    expect(report.steps.find((s) => s.step === 'snapshot')?.ok).toBe(false);
  });

  it('serves a patient-scoped, frozen snapshot only during the outage', () => {
    const kit = new DowntimeKit('northwind-synthetic', () => records);
    expect(() => kit.readSnapshot('person-1')).toThrow(DowntimeError);
    expect(kit.availableForms()).toEqual([]);
    kit.declareOutage('manager-1', 'ransomware containment', at);
    const rows = kit.readSnapshot('person-1');
    expect(rows.map((r) => r.recordId)).toEqual(['r-1', 'm-1']);
    expect(Object.isFrozen(rows)).toBe(true);
    expect(() => {
      (rows[0] as { summary: string }).summary = 'tampered';
    }).toThrow(TypeError);
    expect(kit.availableForms()).toContain('downtime-encounter-note');
  });

  it('refuses online writes while down and blocks return until back-entry is complete', () => {
    const kit = new DowntimeKit('northwind-synthetic', () => records);
    kit.declareOutage('manager-1', 'ehr outage', at);
    expect(() => kit.assertWritable()).toThrow(/paper kit/);
    const capture = kit.capturePaper(
      'downtime-order-requisition',
      'person-1',
      'CBC',
      'nurse-1',
      at,
    );
    const queue = kit.beginRecovery('2026-06-01T13:00:00.000Z');
    expect(queue.map((c) => c.captureId)).toEqual([capture.captureId]);
    expect(() => kit.readSnapshot('person-1')).toThrow(/only served/);
    expect(() => kit.completeRecovery()).toThrow(/await back-entry/);
    kit.reconcile(capture.captureId, 'order-77');
    kit.completeRecovery();
    expect(() => kit.assertWritable()).not.toThrow();
  });

  it('refuses a second declaration and paper capture outside an outage', () => {
    const kit = new DowntimeKit('northwind-synthetic', () => records);
    expect(() => kit.capturePaper('downtime-encounter-note', 'person-1', 'x', 'n', at)).toThrow(
      /only open during/,
    );
    expect(() => kit.declareOutage('', 'x', at)).toThrow(/declarer/);
    kit.declareOutage('manager-1', 'ehr outage', at);
    expect(() => kit.declareOutage('manager-1', 'again', at)).toThrow(/while downtime/);
  });
});
