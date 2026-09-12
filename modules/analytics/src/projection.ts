import { createHash } from 'node:crypto';

import { assertMetricDefinition, metricDefinitionHash } from './metric-definition.js';
import { assertIntrinsicAnalyticsFact, deduplicateFacts } from './event-consumer.js';
import {
  AnalyticsInvariantError,
  type AnalyticsFact,
  type MetricDefinition,
  type ProjectionCell,
  type ProjectionVersion,
  type SourceOffset,
} from './types.js';

const classificationRank = { none: 0, demographic: 1, PHI: 2 } as const;

const canonicalInstant = (value: string): string => {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new AnalyticsInvariantError('projection build time must be a valid instant');
  }
  return new Date(milliseconds).toISOString();
};

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      );
    }
    return item;
  });

export function projectionContentHash(input: Omit<ProjectionVersion, 'contentHash'>): string {
  return createHash('sha256').update(canonical(input)).digest('hex');
}

export function projectionIntegrityValid(projection: ProjectionVersion): boolean {
  const { contentHash, ...withoutHash } = projection;
  return projectionContentHash(withoutHash) === contentHash;
}

export function aggregateNode(
  projection: ProjectionVersion,
  memberCellIds: readonly string[],
): ProjectionCell {
  const wanted = new Set(memberCellIds);
  const cells = projection.cells.filter((cell) => wanted.has(cell.cellId));
  let count = 0;
  let value = 0;
  for (const cell of cells) {
    count += cell.count;
    value += cell.value;
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(value)) {
      throw new AnalyticsInvariantError('aggregate exceeds exact safe-integer arithmetic');
    }
  }
  return {
    cellId: [...memberCellIds].sort().join('+'),
    count,
    value,
    workItemRefs: [...new Set(cells.flatMap((cell) => cell.workItemRefs))].sort(),
  };
}

export function buildProjection(input: {
  readonly definition: MetricDefinition;
  readonly facts: readonly AnalyticsFact[];
  readonly datasetId: string;
  readonly cohortRef: string;
  readonly versionRef: string;
  readonly builtAt: string;
  readonly supersedesVersionRef?: string;
}): ProjectionVersion {
  assertMetricDefinition(input.definition);
  const facts = [...deduplicateFacts(input.facts)].sort((left, right) =>
    left.eventId.localeCompare(right.eventId),
  );
  if (facts.length === 0) {
    throw new AnalyticsInvariantError('a projection cannot be built without facts');
  }
  const first = facts[0];
  if (first === undefined) {
    throw new AnalyticsInvariantError('unreachable empty fact set');
  }
  const cells = new Map<string, { count: number; value: number; refs: Set<string> }>();
  const offsets = new Map<string, SourceOffset>();
  const activeFacts = new Map<string, AnalyticsFact>();
  for (const fact of facts) {
    assertIntrinsicAnalyticsFact(input.definition, fact);
    if (
      fact.tenantId !== first.tenantId ||
      fact.legalEntityId !== first.legalEntityId ||
      fact.metricId !== input.definition.metricId ||
      fact.metricVersion !== input.definition.version
    ) {
      throw new AnalyticsInvariantError('projection facts must share scope and metric version');
    }
    if (fact.supersedesEventId !== undefined) {
      if (!activeFacts.delete(fact.supersedesEventId)) {
        throw new AnalyticsInvariantError('supersession must reference an active prior fact');
      }
      activeFacts.set(fact.eventId, fact);
    } else if (fact.reversalOfEventId !== undefined) {
      if (!activeFacts.delete(fact.reversalOfEventId)) {
        throw new AnalyticsInvariantError('reversal must reference an active prior fact');
      }
    } else {
      activeFacts.set(fact.eventId, fact);
    }
    const prior = offsets.get(fact.sourceRef);
    if (
      prior !== undefined &&
      BigInt(prior.highWaterMark) === BigInt(fact.sourceOffset) &&
      prior.highWaterMark !== fact.sourceOffset
    ) {
      throw new AnalyticsInvariantError('equivalent source offsets use inconsistent encodings');
    }
    if (prior === undefined || BigInt(prior.highWaterMark) < BigInt(fact.sourceOffset)) {
      offsets.set(fact.sourceRef, {
        sourceRef: fact.sourceRef,
        highWaterMark: fact.sourceOffset,
        loadedAt: fact.recordedAt,
        ...(fact.sourceReceiptRef === undefined ? {} : { receiptRef: fact.sourceReceiptRef }),
      });
    }
  }
  const effectiveFacts = [...activeFacts.values()];
  for (const fact of effectiveFacts) {
    const cell = cells.get(fact.cellId) ?? { count: 0, value: 0, refs: new Set<string>() };
    cell.count += 1;
    cell.value += fact.measure;
    if (!Number.isSafeInteger(cell.value)) {
      throw new AnalyticsInvariantError('projection measure exceeds exact safe-integer arithmetic');
    }
    for (const ref of fact.workItemRefs) cell.refs.add(ref);
    cells.set(fact.cellId, cell);
  }
  const projectionCells: ProjectionCell[] = [...input.definition.releaseFamily.atomicCellIds]
    .sort()
    .map((cellId) => {
      const value = cells.get(cellId);
      return {
        cellId,
        count: value?.count ?? 0,
        value: value?.value ?? 0,
        workItemRefs: [...(value?.refs ?? [])].sort(),
      };
    });
  const withoutHash: Omit<ProjectionVersion, 'contentHash'> = {
    tenantId: first.tenantId,
    ...(first.legalEntityId === undefined ? {} : { legalEntityId: first.legalEntityId }),
    datasetId: input.datasetId,
    cohortRef: input.cohortRef,
    metricId: input.definition.metricId,
    metricVersion: input.definition.version,
    definitionHash: metricDefinitionHash(input.definition),
    versionRef: input.versionRef,
    builtAt: canonicalInstant(input.builtAt),
    eventIds: facts.map((fact) => fact.eventId).sort(),
    sourceOffsets: [...offsets.values()].sort((a, b) => a.sourceRef.localeCompare(b.sourceRef)),
    cells: projectionCells,
    maximumClassification: effectiveFacts.reduce<ProjectionVersion['maximumClassification']>(
      (maximum, fact) =>
        classificationRank[fact.classification as keyof typeof classificationRank] >
        classificationRank[maximum]
          ? (fact.classification as ProjectionVersion['maximumClassification'])
          : maximum,
      'none',
    ),
    partitionTags: [
      ...new Set(
        effectiveFacts.flatMap((fact) =>
          fact.partitionTags.filter(
            (tag): tag is Exclude<typeof tag, 'gipa-genetic'> => tag !== 'gipa-genetic',
          ),
        ),
      ),
    ].sort(),
    verificationStatus: 'verified',
    ...(input.supersedesVersionRef === undefined
      ? {}
      : { supersedesVersionRef: input.supersedesVersionRef }),
    synthetic: true,
  };
  return { ...withoutHash, contentHash: projectionContentHash(withoutHash) };
}
