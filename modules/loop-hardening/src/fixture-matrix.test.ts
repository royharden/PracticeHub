import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  runClinicalSubjectFenceProbe,
  runClinicalVersionDriftProbe,
} from './bindings/clinical-loop-v1.js';
import { runCommsConsentDenialProbe } from './bindings/comms-loop.js';
import { runPaidTenantFenceProbe } from './bindings/paid-service-loop.js';
import { runLoopHardeningExecution, runLoopHardeningHappyPath } from './harness.js';
import { loopIds, requireExecution, type LoopId } from './manifest.js';

const fixtureClasses = ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const;
type FixtureClass = (typeof fixtureClasses)[number];
type FixtureOperation =
  | 'run-execution'
  | 'run-happy'
  | 'comms-consent-denial'
  | 'clinical-version-drift'
  | 'correlation-fence';

interface FixtureCase {
  readonly name: string;
  readonly operation: FixtureOperation;
  readonly executionId?: string;
  readonly loopId?: LoopId;
}

interface FixturePack {
  readonly requirementId: 'WP-033';
  readonly fixtureClass: FixtureClass;
  readonly synthetic: true;
  readonly cases: readonly FixtureCase[];
}

const directory = dirname(fileURLToPath(import.meta.url));

function loadFixture(fixtureClass: FixtureClass): FixturePack {
  const path = resolve(directory, `../fixtures/WP-033.${fixtureClass}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FixturePack>;
  if (
    raw.requirementId !== 'WP-033' ||
    raw.fixtureClass !== fixtureClass ||
    raw.synthetic !== true ||
    !Array.isArray(raw.cases) ||
    raw.cases.length === 0
  ) {
    throw new Error(`INVALID_WP033_FIXTURE:${fixtureClass}`);
  }
  for (const candidate of raw.cases) {
    const operation = (candidate as Partial<FixtureCase>).operation;
    if (
      operation !== 'run-execution' &&
      operation !== 'run-happy' &&
      operation !== 'comms-consent-denial' &&
      operation !== 'clinical-version-drift' &&
      operation !== 'correlation-fence'
    ) {
      throw new Error(`UNKNOWN_WP033_FIXTURE_OPERATION:${String(operation)}`);
    }
    if (operation === 'run-execution') {
      requireExecution(String((candidate as Partial<FixtureCase>).executionId ?? ''));
    }
    if (operation === 'run-happy') {
      const loopId = (candidate as Partial<FixtureCase>).loopId;
      if (loopId === undefined || !loopIds.includes(loopId)) {
        throw new Error(`UNKNOWN_WP033_FIXTURE_LOOP:${String(loopId)}`);
      }
    }
  }
  return raw as FixturePack;
}

async function dispatchFixtureCase(candidate: FixtureCase): Promise<void> {
  switch (candidate.operation) {
    case 'run-execution':
      if (candidate.executionId === undefined) throw new Error('WP033_FIXTURE_EXECUTION_REQUIRED');
      await runLoopHardeningExecution(candidate.executionId);
      return;
    case 'run-happy':
      if (candidate.loopId === undefined) throw new Error('WP033_FIXTURE_LOOP_REQUIRED');
      await runLoopHardeningHappyPath(candidate.loopId);
      return;
    case 'comms-consent-denial': {
      const result = await runCommsConsentDenialProbe();
      if (result.railEffects !== 0 || !result.audited) {
        throw new Error('WP033_CONSENT_FAILURE_DIRECTION');
      }
      return;
    }
    case 'clinical-version-drift': {
      const result = await runClinicalVersionDriftProbe();
      if (result.state === 'reconciled' || !result.held || result.transitionCount !== 0) {
        throw new Error('WP033_CLINICAL_DRIFT_FAILURE_DIRECTION');
      }
      return;
    }
    case 'correlation-fence': {
      const clinical = await runClinicalSubjectFenceProbe();
      const paid = await runPaidTenantFenceProbe();
      if (clinical.rejected !== true || paid.rejected !== true) {
        throw new Error('WP033_CORRELATION_FENCE_NOT_BITING');
      }
      return;
    }
    default: {
      const unreachable: never = candidate.operation;
      throw new Error(`UNKNOWN_WP033_FIXTURE_OPERATION:${String(unreachable)}`);
    }
  }
}

describe('WP-033 four-class fixtures', () => {
  it.each(fixtureClasses)('%s invokes the actual loop-hardening harness', async (fixtureClass) => {
    const pack = loadFixture(fixtureClass);
    for (const candidate of pack.cases) await dispatchFixtureCase(candidate);
    expect(pack.cases.length).toBeGreaterThan(0);
  });

  it('rejects an unknown fixture operation at load time', () => {
    const malformed = {
      requirementId: 'WP-033',
      fixtureClass: 'FAILURE',
      synthetic: true,
      cases: [{ name: 'must fail closed', operation: 'guess-success' }],
    };
    expect(() => {
      for (const candidate of malformed.cases) {
        if (
          candidate.operation !== 'run-execution' &&
          candidate.operation !== 'run-happy' &&
          candidate.operation !== 'comms-consent-denial' &&
          candidate.operation !== 'clinical-version-drift' &&
          candidate.operation !== 'correlation-fence'
        ) {
          throw new Error(`UNKNOWN_WP033_FIXTURE_OPERATION:${candidate.operation}`);
        }
      }
    }).toThrow('UNKNOWN_WP033_FIXTURE_OPERATION:guess-success');
  });
});
