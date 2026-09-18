import { describe, expect, it } from 'vitest';

import {
  assertSqlUnapplied,
  completeWave,
  drainToZero,
  enterReadOnlyTail,
  freezeWave,
  liveAthenaWrite,
  openWave,
  quarantineWave,
  restoreAndRekey,
  rollbackFailed,
} from './cutover.js';
import { RecordingEhiDelta, RecordingImportWorkbench } from './doubles.js';
import { CutoverRefusal } from './types.js';

function ports(delta = 2) {
  const workbench = new RecordingImportWorkbench();
  const remaining = new RecordingEhiDelta();
  remaining.seed('panel:northwind', delta);
  return {
    workbench,
    delta: remaining,
    now: () => '2026-09-18T00:00:00Z',
  };
}

describe('WP-114 simulated Athena cutover', () => {
  it('rehearses delta-to-zero, freeze, read-only tail, and complete', () => {
    const harness = ports(2);
    const opened = openWave(harness, {
      tenantId: 'northwind-synthetic',
      waveId: 'wave:1',
      panelRef: 'panel:northwind',
    });
    const zero = drainToZero(harness, opened);
    expect(zero.deltaRemaining).toBe(0);
    const frozen = freezeWave(zero, harness.now());
    expect(frozen.athenaReadOnly).toBe(true);
    const tail = enterReadOnlyTail(frozen);
    expect(completeWave(tail).state).toBe('complete');
  });

  it('refuses freeze while delta remains', () => {
    const harness = ports(1);
    const opened = openWave(harness, {
      tenantId: 'northwind-synthetic',
      waveId: 'wave:2',
      panelRef: 'panel:northwind',
    });
    expect(() => freezeWave(opened, harness.now())).toThrow(/delta-to-zero/);
  });

  it('rolls a failed rehearsal back to Athena', () => {
    const harness = ports(0);
    const opened = openWave(harness, {
      tenantId: 'northwind-synthetic',
      waveId: 'wave:3',
      panelRef: 'panel:northwind',
    });
    expect(rollbackFailed(opened, 'wave-mismatch').state).toBe('rolled-back');
  });

  it('POST-FREEZE restore-and-re-key uses a restore key', () => {
    const harness = ports(0);
    const frozen = freezeWave(
      drainToZero(
        harness,
        openWave(harness, {
          tenantId: 'northwind-synthetic',
          waveId: 'wave:4',
          panelRef: 'panel:northwind',
        }),
      ),
      harness.now(),
    );
    const restored = restoreAndRekey(frozen, 'rekey:panel:northwind');
    expect(restored.state).toBe('rolled-back');
    expect(restored.lastRestoreKey).toBe('rekey:panel:northwind');
  });

  it('quarantines a bounded synthetic panel', () => {
    const harness = ports(0);
    const opened = openWave(harness, {
      tenantId: 'northwind-synthetic',
      waveId: 'wave:5',
      panelRef: 'panel:northwind',
    });
    expect(quarantineWave(opened, 'identity-collision').state).toBe('quarantined');
  });

  it('never writes live Athena and never applies SQL', () => {
    expect(() => liveAthenaWrite()).toThrow(CutoverRefusal);
    expect(assertSqlUnapplied()).toContain('UNAPPLIED');
  });
});
