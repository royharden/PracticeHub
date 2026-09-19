import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TENANT_A, TENANT_B, HarnessError, type WorkPackageLoop } from './contracts.js';
import { EffectRecorder } from './effect-recorder.js';
import { assertNotRealParity, matrixRows, runMatrixRow, type MatrixRow } from './grant-matrix.js';

const fixtureClasses = ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const;
type FixtureClass = (typeof fixtureClasses)[number];

type FixtureOperation = 'matrix' | 'malformed-state' | 'shared-recorder-key' | 'false-real-parity';

interface FixtureCase {
  readonly name: string;
  readonly operation: FixtureOperation;
  readonly workPackage?: WorkPackageLoop;
  readonly row?: MatrixRow;
  readonly orientation?: 'ab' | 'ba';
}

interface FixturePack {
  readonly requirementId: 'WP-034/FWD-CAP-DARK';
  readonly fixtureClass: FixtureClass;
  readonly synthetic: true;
  readonly cases: readonly FixtureCase[];
}

const directory = dirname(fileURLToPath(import.meta.url));

function loadFixture(fixtureClass: FixtureClass): FixturePack {
  const path = resolve(directory, `../fixtures/FWD-CAP-DARK.${fixtureClass}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FixturePack>;
  if (
    raw.requirementId !== 'WP-034/FWD-CAP-DARK' ||
    raw.fixtureClass !== fixtureClass ||
    raw.synthetic !== true ||
    !Array.isArray(raw.cases) ||
    raw.cases.length === 0
  ) {
    throw new Error(`INVALID_WP034_FIXTURE:${fixtureClass}`);
  }
  for (const candidate of raw.cases) {
    if (
      candidate.operation !== 'matrix' &&
      candidate.operation !== 'malformed-state' &&
      candidate.operation !== 'shared-recorder-key' &&
      candidate.operation !== 'false-real-parity'
    ) {
      throw new Error(`UNKNOWN_WP034_FIXTURE_OPERATION:${String(candidate.operation)}`);
    }
    if (candidate.operation === 'matrix') {
      if (
        candidate.row === undefined ||
        !(matrixRows as readonly string[]).includes(candidate.row)
      ) {
        throw new Error(`UNKNOWN_WP034_MATRIX_ROW:${String(candidate.row)}`);
      }
      if (candidate.workPackage === undefined) {
        throw new Error('WP034_FIXTURE_PACKAGE_REQUIRED');
      }
    }
  }
  return raw as FixturePack;
}

async function dispatch(candidate: FixtureCase): Promise<void> {
  switch (candidate.operation) {
    case 'matrix':
      if (candidate.workPackage === undefined || candidate.row === undefined) {
        throw new Error('WP034_MATRIX_FIELDS');
      }
      await runMatrixRow(candidate.workPackage, candidate.row, candidate.orientation ?? 'ab');
      return;
    case 'malformed-state':
      await expect(runMatrixRow('WP-032', 'M12')).rejects.toBeInstanceOf(HarnessError);
      return;
    case 'shared-recorder-key': {
      const recorder = new EffectRecorder();
      recorder.record({
        operationId: 'shared',
        effectId: 'e1',
        tenantId: TENANT_A,
        category: 'queuedIntent',
        checkpoint: 'enqueue',
        capabilityId: 'comms.accountable-message-loop',
        grantState: 'simulated',
        grantSnapshotVersion: 1,
        payload: {},
        synthetic: true,
      });
      expect(() => recorder.assertExclusiveKey(TENANT_B, 'shared')).toThrow(HarnessError);
      return;
    }
    case 'false-real-parity':
      expect(() => assertNotRealParity('real-consumer')).toThrow(HarnessError);
      return;
  }
}

describe('WP-034/FWD-CAP-DARK fixtures', () => {
  for (const fixtureClass of fixtureClasses) {
    it(`dispatches ${fixtureClass}`, async () => {
      const pack = loadFixture(fixtureClass);
      expect(pack.cases.length).toBeGreaterThan(0);
      for (const candidate of pack.cases) {
        await dispatch(candidate);
      }
    });
  }
});
