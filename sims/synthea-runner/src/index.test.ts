import { describe, expect, it } from 'vitest';
import { importSyntheaExport, conditionCatalog, medicationCatalog } from '@practicehub/synthgen';

import { SyntheticSyntheaRunner, syntheaRunnerVersion } from './index.js';

const request = {
  seed: 'runner-seed',
  populationSize: 3,
  subjectRefs: ['sg-p-0001', 'sg-p-0002', 'sg-p-0003'],
  simulatedClockEpoch: '2026-01-01T00:00:00Z',
  synthetic: true,
} as const;

const permitted = {
  conditions: conditionCatalog.map((entry) => entry.code),
  medications: medicationCatalog.map((entry) => entry.code),
};

describe('SyntheticSyntheaRunner', () => {
  it('emits a watermarked export keyed to the requested subjects', () => {
    const exported = new SyntheticSyntheaRunner().run(request);
    expect(exported.synthetic).toBe(true);
    expect(exported.generator).toEqual({ name: 'synthea-runner', version: syntheaRunnerVersion });
    expect(exported.patients.map((row) => row.subjectRef)).toEqual([...request.subjectRefs]);
  });

  it('is deterministic — the same request yields byte-identical output', () => {
    const runner = new SyntheticSyntheaRunner();
    expect(JSON.stringify(runner.run(request))).toBe(JSON.stringify(runner.run(request)));
    expect(JSON.stringify(new SyntheticSyntheaRunner().run(request))).toBe(
      JSON.stringify(runner.run(request)),
    );
  });

  it('diverges on a different seed', () => {
    const runner = new SyntheticSyntheaRunner();
    expect(JSON.stringify(runner.run({ ...request, seed: 'other' }))).not.toBe(
      JSON.stringify(runner.run(request)),
    );
  });

  it('REFUSES a run request that is not synthetic-only', () => {
    const runner = new SyntheticSyntheaRunner();
    const unsafe = { ...request, synthetic: false } as unknown as typeof request;
    expect(() => runner.run(unsafe)).toThrow(/synthetic-only/);
  });

  it('refuses a request whose population size disagrees with its subject list', () => {
    const runner = new SyntheticSyntheaRunner();
    expect(() => runner.run({ ...request, populationSize: 5 })).toThrow(/does not match/);
  });

  it('emits only internally-namespaced codes — no licensed vocabulary enters the repo', () => {
    const exported = new SyntheticSyntheaRunner().run(request);
    for (const row of exported.conditions) {
      expect(row.code.startsWith('SYN-')).toBe(true);
    }
    for (const row of exported.medications) {
      expect(row.code.startsWith('SYN-')).toBe(true);
    }
  });

  it('emits dates anchored to the simulated epoch, never a wall clock', () => {
    const exported = new SyntheticSyntheaRunner().run(request);
    for (const row of exported.encounters) {
      expect(row.startDate <= '2026-01-01').toBe(true);
    }
    // A clock read would make this differ between the two runs below.
    const again = new SyntheticSyntheaRunner().run(request);
    expect(again.encounters).toEqual(exported.encounters);
  });

  it('imports cleanly into the backbone when every row resolves', () => {
    const exported = new SyntheticSyntheaRunner().run(request);
    const result = importSyntheaExport(exported, [...request.subjectRefs], permitted);
    expect(result.quarantine).toEqual([]);
    expect(result.backbone).toHaveLength(3);
  });

  it('plants orphan rows on demand so the pinned corpus exercises quarantine', () => {
    const exported = new SyntheticSyntheaRunner({ orphanRowEveryN: 2 }).run(request);
    const result = importSyntheaExport(exported, [...request.subjectRefs], permitted);
    expect(result.quarantine.length).toBeGreaterThan(0);
    for (const record of result.quarantine) {
      expect(record.reason).toBe('unresolved-subject');
      expect(record.observedAttributeNames).toEqual(['subjectRef']);
      expect(record.synthetic).toBe(true);
    }
  });

  it('refuses a nonsensical orphan cadence', () => {
    expect(() => new SyntheticSyntheaRunner({ orphanRowEveryN: -1 })).toThrow(/non-negative/);
    expect(() => new SyntheticSyntheaRunner({ orphanRowEveryN: 1.5 })).toThrow(/non-negative/);
  });
});
