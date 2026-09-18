import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { EhiDeltaDouble, ImportWorkbenchDouble } from './ports.js';
import { CutoverRefusal, cutoverCeiling, type CutoverWave } from './types.js';

const sqlPath = fileURLToPath(new URL('../migrations/0046-athena-cutover.sql', import.meta.url));

export interface CutoverPorts {
  readonly workbench: ImportWorkbenchDouble;
  readonly delta: EhiDeltaDouble;
  readonly now: () => string;
}

export function assertSqlUnapplied(): string {
  const sql = readFileSync(sqlPath, 'utf8');
  if (!sql.includes('UNAPPLIED')) {
    throw new CutoverRefusal('cutover SQL must remain labeled unapplied');
  }
  return sql;
}

export function openWave(
  ports: CutoverPorts,
  input: { readonly tenantId: string; readonly waveId: string; readonly panelRef: string },
): CutoverWave {
  const dry = ports.workbench.dryRun(input.panelRef);
  if (!dry.accepted) {
    throw new CutoverRefusal('import-workbench double refused the synthetic panel');
  }
  return {
    tenantId: input.tenantId,
    waveId: input.waveId,
    panelRef: input.panelRef,
    state: 'rehearsing',
    deltaRemaining: ports.delta.remaining(input.panelRef),
    frozenAt: null,
    athenaReadOnly: false,
    lastRestoreKey: null,
    quarantineReason: null,
    synthetic: true,
  };
}

export function drainToZero(ports: CutoverPorts, wave: CutoverWave): CutoverWave {
  if (wave.state !== 'rehearsing') {
    throw new CutoverRefusal('delta-to-zero only runs while rehearsing');
  }
  let remaining = wave.deltaRemaining;
  while (remaining > 0) {
    remaining = ports.delta.drainOne(wave.panelRef);
  }
  return { ...wave, deltaRemaining: 0 };
}

export function freezeWave(wave: CutoverWave, at: string): CutoverWave {
  if (wave.deltaRemaining !== 0) {
    throw new CutoverRefusal('freeze requires delta-to-zero');
  }
  if (wave.state !== 'rehearsing') {
    throw new CutoverRefusal('only a rehearsing wave can freeze');
  }
  return {
    ...wave,
    state: 'frozen',
    frozenAt: at,
    athenaReadOnly: true,
  };
}

export function enterReadOnlyTail(wave: CutoverWave): CutoverWave {
  if (wave.state !== 'frozen') {
    throw new CutoverRefusal('read-only tail follows freeze');
  }
  return { ...wave, state: 'read-only-tail', athenaReadOnly: true };
}

export function completeWave(wave: CutoverWave): CutoverWave {
  if (wave.state !== 'read-only-tail') {
    throw new CutoverRefusal('complete follows the read-only tail');
  }
  return { ...wave, state: 'complete' };
}

export function rollbackFailed(wave: CutoverWave, reason: string): CutoverWave {
  if (wave.state === 'complete') {
    throw new CutoverRefusal('a completed wave uses POST-FREEZE restore, not rehearsal rollback');
  }
  return {
    ...wave,
    state: 'rolled-back',
    athenaReadOnly: false,
    quarantineReason: reason,
  };
}

export function restoreAndRekey(wave: CutoverWave, restoreKey: string): CutoverWave {
  if (wave.state !== 'complete' && wave.state !== 'read-only-tail' && wave.state !== 'frozen') {
    throw new CutoverRefusal('POST-FREEZE restore requires a frozen or later wave');
  }
  if (restoreKey.trim() === '') {
    throw new CutoverRefusal('restore re-key is required');
  }
  return {
    ...wave,
    state: 'rolled-back',
    lastRestoreKey: restoreKey,
    athenaReadOnly: false,
  };
}

export function quarantineWave(wave: CutoverWave, reason: string): CutoverWave {
  return {
    ...wave,
    state: 'quarantined',
    quarantineReason: reason,
  };
}

export function liveAthenaWrite(): never {
  throw new CutoverRefusal(`live Athena writes are forbidden at ${cutoverCeiling}`);
}
