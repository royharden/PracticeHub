import { skippedFinding } from './skipped-run.js';
import type { DrillRegistry } from './registry.js';
import type { DrillRun } from './types.js';
import type { Wp028RailDouble } from './wp028-rail-double.js';
import type { Wp033InjectDouble } from './wp033-inject-double.js';

export class DrillScheduler {
  public readonly runs: DrillRun[] = [];

  public constructor(
    private readonly registry: DrillRegistry,
    private readonly rails: Wp028RailDouble,
    private readonly injects: Wp033InjectDouble,
  ) {}

  public due(nowMs: number, lastByDrill: ReadonlyMap<string, number>): readonly string[] {
    const dueIds: string[] = [];
    for (const definition of this.registry.all()) {
      const last = lastByDrill.get(definition.drillId) ?? 0;
      if (nowMs - last >= definition.cadenceMs) {
        dueIds.push(definition.drillId);
      }
    }
    return dueIds;
  }

  public skip(drillId: string, scheduledAt: string): DrillRun {
    const run = skippedFinding(this.registry.require(drillId), scheduledAt);
    this.runs.push(run);
    return run;
  }

  public run(drillId: string, scheduledAt: string, startedAt: string, pass: boolean): DrillRun {
    const definition = this.registry.require(drillId);
    if (definition.kind === 'failover' || definition.kind === 'degraded') {
      this.rails.observe(`rail:${definition.kind}`, pass ? 'quiet' : 'alarm');
      this.injects.inject('crash');
    }
    if (definition.kind === 'restore') {
      this.injects.inject('replay');
    }
    if (definition.kind === 'kill-switch') {
      this.injects.inject('duplicate');
    }
    const run: DrillRun = Object.freeze({
      drillId,
      scheduledAt,
      startedAt,
      verdict: pass ? 'passed' : 'failed',
      releaseBlocking: !pass,
      finding: pass ? null : `failed:${drillId}`,
      synthetic: true,
    });
    this.runs.push(run);
    return run;
  }
}
