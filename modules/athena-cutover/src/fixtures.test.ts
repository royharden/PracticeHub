import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
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

const fixtureDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));
const requiredClasses = ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const;

interface FixtureCase {
  readonly name: string;
  readonly op:
    'happy-cutover' | 'freeze-with-delta' | 'live-write' | 'rollback' | 'restore' | 'quarantine';
}

function load(fixtureClass: string): {
  readonly class: string;
  readonly cases: readonly FixtureCase[];
} {
  return JSON.parse(readFileSync(`${fixtureDirectory}/WP-114.${fixtureClass}.json`, 'utf8')) as {
    readonly class: string;
    readonly cases: readonly FixtureCase[];
  };
}

function ports(delta: number) {
  const remaining = new RecordingEhiDelta();
  remaining.seed('panel:northwind', delta);
  return {
    workbench: new RecordingImportWorkbench(),
    delta: remaining,
    now: () => '2026-09-18T00:00:00Z',
  };
}

describe('WP-114 four-class fixtures', () => {
  it.each(requiredClasses)('executes %s cases', (fixtureClass) => {
    const fixture = load(fixtureClass);
    expect(fixture.class).toBe(fixtureClass);
    for (const fixtureCase of fixture.cases) {
      if (fixtureCase.op === 'happy-cutover') {
        const harness = ports(1);
        const opened = openWave(harness, {
          tenantId: 'northwind-synthetic',
          waveId: 'wave:happy',
          panelRef: 'panel:northwind',
        });
        expect(
          completeWave(enterReadOnlyTail(freezeWave(drainToZero(harness, opened), harness.now())))
            .state,
        ).toBe('complete');
        continue;
      }
      if (fixtureCase.op === 'freeze-with-delta') {
        const harness = ports(1);
        const opened = openWave(harness, {
          tenantId: 'northwind-synthetic',
          waveId: 'wave:bound',
          panelRef: 'panel:northwind',
        });
        expect(() => freezeWave(opened, harness.now())).toThrow(CutoverRefusal);
        continue;
      }
      if (fixtureCase.op === 'live-write') {
        expect(() => liveAthenaWrite()).toThrow(CutoverRefusal);
        continue;
      }
      if (fixtureCase.op === 'rollback') {
        const harness = ports(0);
        const opened = openWave(harness, {
          tenantId: 'northwind-synthetic',
          waveId: 'wave:fail',
          panelRef: 'panel:northwind',
        });
        expect(rollbackFailed(opened, 'failed-cutover').state).toBe('rolled-back');
        continue;
      }
      if (fixtureCase.op === 'restore') {
        const harness = ports(0);
        const frozen = freezeWave(
          drainToZero(
            harness,
            openWave(harness, {
              tenantId: 'northwind-synthetic',
              waveId: 'wave:restore',
              panelRef: 'panel:northwind',
            }),
          ),
          harness.now(),
        );
        expect(restoreAndRekey(frozen, 'rekey:1').lastRestoreKey).toBe('rekey:1');
        continue;
      }
      if (fixtureCase.op === 'quarantine') {
        const harness = ports(0);
        const opened = openWave(harness, {
          tenantId: 'northwind-synthetic',
          waveId: 'wave:q',
          panelRef: 'panel:northwind',
        });
        expect(quarantineWave(opened, 'collision').state).toBe('quarantined');
        continue;
      }
      throw new Error(`unknown fixture op ${(fixtureCase as FixtureCase).op}`);
    }
  });
});
