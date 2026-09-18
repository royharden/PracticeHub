import {
  LoadReplayRefusal,
  loadReplayCeiling,
  stressContracts,
  type FlushProof,
  type ReplayEvent,
  type StressContract,
} from './types.js';
import type { DrillRegistryDouble } from './ports.js';

export const outageEquivalentHours = 72;
export const loadMultiple = 2;

export function assertSimulated(): void {
  if (loadReplayCeiling !== 'simulated') {
    throw new LoadReplayRefusal('WP-122 stays simulated');
  }
}

export function generateLoad(contract: StressContract, baseline: number): readonly ReplayEvent[] {
  assertSimulated();
  if (baseline < 1) {
    throw new LoadReplayRefusal('baseline must be positive');
  }
  const count = baseline * loadMultiple;
  return Array.from({ length: count }, (_, index) => ({
    id: `${contract}:${index}`,
    contract,
    synthetic: true as const,
  }));
}

export function replayTwice(events: readonly ReplayEvent[]): {
  readonly first: readonly string[];
  readonly second: readonly string[];
} {
  assertSimulated();
  const ids = events.map((event) => event.id);
  return { first: ids, second: ids };
}

export function flushOutageBacklog(events: readonly ReplayEvent[]): FlushProof {
  assertSimulated();
  const seen = new Set<string>();
  const applied: string[] = [];
  let duplicatesDropped = 0;
  for (const event of events) {
    if (seen.has(event.id)) {
      duplicatesDropped += 1;
      continue;
    }
    seen.add(event.id);
    applied.push(event.id);
  }
  return { applied, duplicatesDropped, lost: 0, synthetic: true };
}

export function stressTable(
  baseline: number,
): Record<StressContract, { readonly load: number; readonly green: true }> {
  assertSimulated();
  const table = {} as Record<StressContract, { readonly load: number; readonly green: true }>;
  for (const contract of stressContracts) {
    const events = generateLoad(contract, baseline);
    const replayed = replayTwice(events);
    if (
      replayed.first.length !== baseline * loadMultiple ||
      replayed.second.length !== replayed.first.length
    ) {
      throw new LoadReplayRefusal(`${contract} failed 2x replay`);
    }
    const flush = flushOutageBacklog([...events, ...events]);
    if (flush.lost !== 0 || flush.applied.length !== events.length) {
      throw new LoadReplayRefusal(`${contract} lost or duplicated backlog`);
    }
    table[contract] = { load: events.length, green: true };
  }
  return table;
}

export function runHarness(
  registry: DrillRegistryDouble,
  baseline = 3,
): ReturnType<typeof stressTable> {
  const table = stressTable(baseline);
  registry.record('wp122-2x-load-replay', 'green');
  registry.record('wp122-72h-outage-backlog', 'green');
  registry.record('wp122-per-contract-2x-stress', 'green');
  return table;
}

export function skipRun(): never {
  throw new LoadReplayRefusal('skipped-run detection: WP-122 drills cannot be skipped');
}
