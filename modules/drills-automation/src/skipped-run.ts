import type { DrillDefinition, DrillRun } from './types.js';

export function skippedFinding(definition: DrillDefinition, scheduledAt: string): DrillRun {
  return Object.freeze({
    drillId: definition.drillId,
    scheduledAt,
    startedAt: null,
    verdict: 'skipped',
    releaseBlocking: true,
    finding: `skipped-run:${definition.drillId}:${scheduledAt}`,
    synthetic: true,
  });
}
