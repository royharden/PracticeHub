import type { DrillRun } from './types.js';

export function releaseBlocked(runs: readonly DrillRun[]): boolean {
  return runs.some((run) => run.releaseBlocking && run.verdict !== 'passed');
}
