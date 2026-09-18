import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DrillRegistry } from './registry.js';
import { releaseBlocked } from './release-gate.js';
import { DrillScheduler } from './scheduler.js';
import type { DrillDefinition, DrillKind } from './types.js';
import { Wp028RailDouble } from './wp028-rail-double.js';
import { Wp033InjectDouble } from './wp033-inject-double.js';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function def(kind: DrillKind): DrillDefinition {
  return {
    contractId: 'drill-registry/v1',
    drillId: `drill:${kind}`,
    kind,
    cadenceMs: 60_000,
    synthetic: true,
  };
}

function harness() {
  const registry = new DrillRegistry();
  for (const kind of ['failover', 'restore', 'kill-switch', 'degraded'] as const) {
    registry.register(def(kind));
  }
  const rails = new Wp028RailDouble();
  const injects = new Wp033InjectDouble();
  return { registry, rails, injects, scheduler: new DrillScheduler(registry, rails, injects) };
}

describe('NFR-011 fixtures four-class', () => {
  it('loads unique case names including RECOVERY', () => {
    const names = new Set<string>();
    for (const cls of ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const) {
      const raw = JSON.parse(readFileSync(join(fixtureRoot, `NFR-011.${cls}.json`), 'utf8')) as {
        requirementId: string;
        class: string;
        cases: readonly { name: string }[];
      };
      expect(raw.requirementId).toBe('NFR-011');
      expect(raw.class).toBe(cls);
      for (const item of raw.cases) {
        expect(names.has(item.name)).toBe(false);
        names.add(item.name);
      }
    }
    expect(names.size).toBe(4);
  });
});

describe('HAPPY', () => {
  it('all four drill kinds run and pass', () => {
    const { registry, scheduler, rails } = harness();
    expect(registry.kindsCovered()).toEqual(['failover', 'restore', 'kill-switch', 'degraded']);
    for (const kind of registry.kindsCovered()) {
      scheduler.run(`drill:${kind}`, '2026-09-18T12:00:00.000Z', '2026-09-18T12:00:01.000Z', true);
    }
    expect(releaseBlocked(scheduler.runs)).toBe(false);
    expect(rails.heartbeat('rail:failover')).toBe('quiet');
  });
});

describe('BOUNDARY', () => {
  it('a skipped scheduled run is a release-blocking finding', () => {
    const { scheduler } = harness();
    const run = scheduler.skip('drill:failover', '2026-09-18T12:00:00.000Z');
    expect(run.verdict).toBe('skipped');
    expect(run.releaseBlocking).toBe(true);
    expect(run.finding).toMatch(/^skipped-run:/);
    expect(releaseBlocked(scheduler.runs)).toBe(true);
  });
});

describe('FAILURE', () => {
  it('a failed drill blocks release', () => {
    const { scheduler, rails } = harness();
    scheduler.run('drill:degraded', '2026-09-18T12:00:00.000Z', '2026-09-18T12:00:01.000Z', false);
    expect(releaseBlocked(scheduler.runs)).toBe(true);
    expect(rails.heartbeat('rail:degraded')).toBe('alarm');
  });
});

describe('RECOVERY', () => {
  it('restore drill after failover uses replay inject', () => {
    const { scheduler, injects } = harness();
    scheduler.run('drill:failover', '2026-09-18T12:00:00.000Z', '2026-09-18T12:00:01.000Z', true);
    scheduler.run('drill:restore', '2026-09-18T12:01:00.000Z', '2026-09-18T12:01:01.000Z', true);
    expect(injects.applied).toEqual(['crash', 'replay']);
    expect(releaseBlocked(scheduler.runs)).toBe(false);
  });
});

describe('scheduler due window', () => {
  it('lists a drill when cadence elapsed', () => {
    const { scheduler } = harness();
    expect(scheduler.due(60_000, new Map())).toHaveLength(4);
    const due = scheduler.due(120_000, new Map([['drill:failover', 90_000]]));
    expect(due).toContain('drill:restore');
    expect(due).not.toContain('drill:failover');
  });
});
