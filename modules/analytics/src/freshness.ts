import type { FreshnessEvidence, MetricDefinition, ProjectionVersion } from './types.js';

export function assessFreshness(
  definition: MetricDefinition,
  projection: ProjectionVersion,
  nowIso: string,
): FreshnessEvidence {
  const now = Date.parse(nowIso);
  const offsets = new Map(projection.sourceOffsets.map((offset) => [offset.sourceRef, offset]));
  const gaps: string[] = [];
  if (!Number.isFinite(now)) gaps.push('invalid-now');
  const highWaterMarks: Record<string, string> = {};
  let lastSuccessfulLoad: string | null = null;
  for (const sourceRef of definition.requiredSourceRefs) {
    const offset = offsets.get(sourceRef);
    if (offset === undefined) {
      gaps.push(`missing-source:${sourceRef}`);
      continue;
    }
    highWaterMarks[sourceRef] = offset.highWaterMark;
    if (offset.receiptRef === undefined) gaps.push(`missing-receipt:${sourceRef}`);
    const loaded = Date.parse(offset.loadedAt);
    if (!Number.isFinite(loaded)) {
      gaps.push(`invalid-load:${sourceRef}`);
    } else if (Number.isFinite(now) && loaded > now) {
      gaps.push(`future-load:${sourceRef}`);
    } else if (
      Number.isFinite(now) &&
      now - loaded > definition.freshnessObjectiveMinutes * 60_000
    ) {
      gaps.push(`late-source:${sourceRef}`);
    }
    if (lastSuccessfulLoad === null || offset.loadedAt < lastSuccessfulLoad) {
      lastSuccessfulLoad = offset.loadedAt;
    }
  }
  return {
    objectiveMinutes: definition.freshnessObjectiveMinutes,
    lastSuccessfulLoad,
    knownGaps: gaps,
    sourceSystems: [...definition.requiredSourceRefs],
    highWaterMarks,
    fresh: gaps.length === 0,
  };
}
