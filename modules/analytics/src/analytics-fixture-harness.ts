import type { EventEnvelope, EventId, LegalEntityId, TenantId } from '@practicehub/contracts';

import { consumeAnalyticsEvent, deduplicateFacts } from './event-consumer.js';
import { assessFreshness } from './freshness.js';
import { safeReleaseNodeIds } from './privacy.js';
import { buildProjection, projectionContentHash } from './projection.js';
import { queryAnalytics, type AnalyticsQueryPorts } from './query.js';
import { rebuildProjection } from './rebuild.js';
import { createMemoryDisclosureHistory } from './source-ports.js';
import type {
  AnalyticsFact,
  DataQualityReason,
  MetricDefinition,
  ProjectionVersion,
  ReleaseFamily,
} from './types.js';

export type AnalyticsFixtureClass = 'HAPPY' | 'BOUNDARY' | 'FAILURE' | 'RECOVERY';

export const analyticsFixtureOperations = [
  'query-available',
  'freshness-boundary',
  'query-cross-entity',
  'query-small-cell-both-orders',
  'query-unresolved-identity',
  'query-missing-receipt',
  'event-genetic-excluded',
  'privacy-safe-family',
  'privacy-cross-surface-history',
  'privacy-threshold',
  'rebuild-deterministic',
  'rebuild-late-data',
] as const;
export type AnalyticsFixtureOperation = (typeof analyticsFixtureOperations)[number];

export interface AnalyticsFixtureCase {
  readonly name: string;
  readonly operation: AnalyticsFixtureOperation;
  readonly expected: string;
}

export interface AnalyticsFixtureFile {
  readonly requirement: string;
  readonly class: AnalyticsFixtureClass;
  readonly synthetic: true;
  readonly cases: readonly AnalyticsFixtureCase[];
}

export const northwindTenant = 'northwind-synthetic' as TenantId;
export const northwindEntity = 'northwind-legal-entity-synthetic' as LegalEntityId;
const observedAt = '2026-03-10T12:00:00.000Z';

const standardFamily: ReleaseFamily = {
  familyId: 'two-cell-total',
  atomicCellIds: ['a', 'b'],
  nodes: [
    { nodeId: 'total', memberCellIds: ['a', 'b'] },
    { nodeId: 'a', memberCellIds: ['a'] },
    { nodeId: 'b', memberCellIds: ['b'] },
  ],
};

export function makeMetricDefinition(
  input: {
    readonly minimumCellCount?: number;
    readonly freshnessObjectiveMinutes?: number;
    readonly requiredSourceRefs?: readonly string[];
    readonly releaseFamily?: ReleaseFamily;
  } = {},
): MetricDefinition {
  return {
    metricId: 'analytics.synthetic.completed-visits',
    version: 1,
    status: 'active',
    denominatorRef: 'synthetic:scheduled-visits',
    allowedEventTypes: ['synthetic.metric-observed'],
    requiredSourceRefs: input.requiredSourceRefs ?? ['source-a'],
    freshnessObjectiveMinutes: input.freshnessObjectiveMinutes ?? 60,
    dimensions: ['cohort'],
    minimumCellCount: input.minimumCellCount ?? 5,
    maximumClassification: 'PHI',
    accountableOwnerRef: 'role:analytics-owner',
    releaseFamily: input.releaseFamily ?? standardFamily,
    synthetic: true,
  };
}

function fact(
  index: number,
  cellId: string,
  input: {
    readonly sourceReceiptRef?: string;
    readonly recordedAt?: string;
    readonly classification?: AnalyticsFact['classification'];
    readonly partitionTags?: AnalyticsFact['partitionTags'];
  } = {},
): AnalyticsFact {
  return {
    tenantId: northwindTenant,
    legalEntityId: northwindEntity,
    eventId: `01H0000000${String(index).padStart(16, '0')}` as EventId,
    eventType: 'synthetic.metric-observed',
    metricId: 'analytics.synthetic.completed-visits',
    metricVersion: 1,
    occurredAt: observedAt,
    recordedAt: input.recordedAt ?? observedAt,
    sourceRef: 'source-a',
    sourceOffset: String(index),
    ...(input.sourceReceiptRef === undefined ? {} : { sourceReceiptRef: input.sourceReceiptRef }),
    cellId,
    measure: 1,
    classification: input.classification ?? 'PHI',
    partitionTags: input.partitionTags ?? [],
    workItemRefs: [`work-item:source-${index}`],
    synthetic: true,
  };
}

export function makeFacts(
  counts: { readonly a: number; readonly b: number },
  input: { readonly sourceReceiptRef?: string; readonly recordedAt?: string } = {
    sourceReceiptRef: 'receipt:source-a:0001',
  },
): readonly AnalyticsFact[] {
  const result: AnalyticsFact[] = [];
  for (let index = 0; index < counts.a; index += 1) {
    result.push(fact(index + 1, 'a', input));
  }
  for (let index = 0; index < counts.b; index += 1) {
    result.push(fact(counts.a + index + 1, 'b', input));
  }
  return result;
}

export function makeProjection(
  input: {
    readonly a?: number;
    readonly b?: number;
    readonly sourceReceiptRef?: string;
    readonly recordedAt?: string;
    readonly versionRef?: string;
  } = {},
): ProjectionVersion {
  const projection = buildProjection({
    definition: makeMetricDefinition(),
    facts: makeFacts(
      { a: input.a ?? 5, b: input.b ?? 5 },
      {
        ...(input.sourceReceiptRef === undefined || input.sourceReceiptRef === ''
          ? { sourceReceiptRef: 'receipt:source-a:0001' }
          : { sourceReceiptRef: input.sourceReceiptRef }),
        ...(input.recordedAt === undefined ? {} : { recordedAt: input.recordedAt }),
      },
    ),
    datasetId: 'dataset:visits',
    cohortRef: 'cohort:all',
    versionRef: input.versionRef ?? 'projection:0001',
    builtAt: observedAt,
  });
  if (input.sourceReceiptRef !== '') return projection;
  const { contentHash, ...withoutHash } = projection;
  if (contentHash.length !== 64) throw new Error('fixture projection hash is malformed');
  const staleWithoutHash: Omit<ProjectionVersion, 'contentHash'> = {
    ...withoutHash,
    sourceOffsets: projection.sourceOffsets.map((offset) => ({
      sourceRef: offset.sourceRef,
      highWaterMark: offset.highWaterMark,
      loadedAt: offset.loadedAt,
    })),
  };
  return { ...staleWithoutHash, contentHash: projectionContentHash(staleWithoutHash) };
}

export function makeEnvelope(sourceFact: AnalyticsFact): EventEnvelope<unknown> {
  return {
    eventId: sourceFact.eventId,
    tenantId: sourceFact.tenantId,
    ...(sourceFact.legalEntityId === undefined ? {} : { legalEntityId: sourceFact.legalEntityId }),
    type: sourceFact.eventType,
    aggregate: { type: 'synthetic-metric', id: sourceFact.cellId, version: 1 },
    occurredAt: sourceFact.occurredAt,
    recordedAt: sourceFact.recordedAt,
    source: { module: 'synthetic-source' },
    idempotencyKey: `synthetic:${sourceFact.eventId.toLowerCase()}`,
    dataClassification: sourceFact.classification,
    ...(sourceFact.sourceReceiptRef === undefined
      ? {}
      : { externalReceiptRef: sourceFact.sourceReceiptRef }),
    ...(sourceFact.supersedesEventId === undefined
      ? {}
      : { supersedesEventId: sourceFact.supersedesEventId }),
    ...(sourceFact.reversalOfEventId === undefined
      ? {}
      : { reversalOfEventId: sourceFact.reversalOfEventId }),
    payload: { cellId: sourceFact.cellId },
    synthetic: true,
  };
}

export interface FixturePorts extends AnalyticsQueryPorts {
  readonly reasons: DataQualityReason[];
  readonly audits: Array<'allow' | 'deny'>;
  readonly disclosures: ReturnType<typeof createMemoryDisclosureHistory>;
}

export function makeFixturePorts(input: { readonly accessAllowed?: boolean } = {}): FixturePorts {
  const reasons: DataQualityReason[] = [];
  const audits: Array<'allow' | 'deny'> = [];
  return {
    reasons,
    audits,
    access: {
      evaluate: async () => ({
        allowed: input.accessAllowed ?? true,
        policyVersion: 'AUTH-021:v1',
      }),
    },
    workItems: {
      createDataQualityWorkItem: async (request) => {
        reasons.push(request.reason);
        return { workItemRef: `work-item:${request.workItemId}` };
      },
    },
    disclosures: createMemoryDisclosureHistory(),
    audit: {
      record: async (record) => {
        audits.push(record.decision);
      },
    },
  };
}

export function qualityTaskIds(
  prefix = 'analytics-fixture',
): Readonly<Record<DataQualityReason, string>> {
  return {
    'cross-entity-access': `${prefix}-cross-entity`,
    'small-cell-or-differencing': `${prefix}-small-cell`,
    'unresolved-identity-join': `${prefix}-identity`,
    'missing-source-receipt': `${prefix}-receipt`,
    'rebuild-divergence': `${prefix}-rebuild`,
  };
}

async function fixtureQuery(
  input: {
    readonly projection?: ProjectionVersion;
    readonly nodeId?: string;
    readonly tenantId?: string;
    readonly identityResolved?: boolean;
    readonly surface?: 'view' | 'export';
    readonly ports?: FixturePorts;
    readonly disclosureId?: string;
  } = {},
): Promise<Awaited<ReturnType<typeof queryAnalytics>>> {
  const projection = input.projection ?? makeProjection();
  return queryAnalytics(
    {
      definition: makeMetricDefinition(),
      projection,
      tenantId: input.tenantId ?? projection.tenantId,
      ...(projection.legalEntityId === undefined
        ? {}
        : { legalEntityId: projection.legalEntityId }),
      actorRef: 'user:fixture',
      purpose: 'operations',
      nodeId: input.nodeId ?? 'total',
      surface: input.surface ?? 'view',
      identityResolved: input.identityResolved ?? true,
      segments: ['administrative'],
      occurredAt: observedAt,
      disclosureId: input.disclosureId ?? 'disclosure:fixture',
      qualityTaskIds: qualityTaskIds(),
    },
    input.ports ?? makeFixturePorts(),
  );
}

export async function runAnalyticsFixtureCase(fixtureCase: AnalyticsFixtureCase): Promise<string> {
  switch (fixtureCase.operation) {
    case 'query-available':
      return (await fixtureQuery()).kind;
    case 'freshness-boundary': {
      const evidence = assessFreshness(
        makeMetricDefinition(),
        makeProjection({ recordedAt: '2026-03-10T11:00:00.000Z' }),
        observedAt,
      );
      return evidence.fresh ? 'fresh' : 'stale';
    }
    case 'query-cross-entity': {
      const ports = makeFixturePorts();
      const decision = await fixtureQuery({ tenantId: 'riverbend-synthetic', ports });
      return `${decision.kind}:${ports.reasons.join(',')}`;
    }
    case 'query-small-cell-both-orders': {
      const projection = makeProjection({ a: 5, b: 3 });
      const first = await fixtureQuery({ projection, nodeId: 'total' });
      const second = await fixtureQuery({ projection, nodeId: 'a' });
      const reverseFirst = await fixtureQuery({ projection, nodeId: 'a' });
      const reverseSecond = await fixtureQuery({ projection, nodeId: 'total' });
      return [first.kind, second.kind, reverseFirst.kind, reverseSecond.kind].join(',');
    }
    case 'query-unresolved-identity': {
      const ports = makeFixturePorts();
      const decision = await fixtureQuery({ identityResolved: false, ports });
      return `${decision.kind}:${ports.reasons.join(',')}`;
    }
    case 'query-missing-receipt': {
      const ports = makeFixturePorts();
      const decision = await fixtureQuery({
        projection: makeProjection({ sourceReceiptRef: '' }),
        ports,
      });
      return `${decision.kind}:${ports.reasons.join(',')}`;
    }
    case 'event-genetic-excluded': {
      const source = fact(1, 'a', {
        sourceReceiptRef: 'receipt:source-a:0001',
        classification: 'PHI-restricted',
        partitionTags: ['gipa-genetic'],
      });
      try {
        consumeAnalyticsEvent(makeMetricDefinition(), makeEnvelope(source), { map: () => source });
      } catch {
        return 'excluded';
      }
      return 'accepted';
    }
    case 'privacy-safe-family':
      return [...safeReleaseNodeIds(makeMetricDefinition(), makeProjection())].sort().join(',');
    case 'privacy-cross-surface-history': {
      const ports = makeFixturePorts();
      const first = await fixtureQuery({ ports, surface: 'view', disclosureId: 'view:user-a' });
      const second = await fixtureQuery({
        ports,
        surface: 'export',
        disclosureId: 'export:user-b',
      });
      const records = ports.disclosures.records;
      return `${first.kind},${second.kind}:${records.map((record) => record.surface).join(',')}`;
    }
    case 'privacy-threshold':
      return safeReleaseNodeIds(makeMetricDefinition(), makeProjection({ a: 5, b: 4 })).size === 0
        ? 'suppressed'
        : 'released';
    case 'rebuild-deterministic': {
      const projection = makeProjection();
      return rebuildProjection({
        definition: makeMetricDefinition(),
        facts: makeFacts({ a: 5, b: 5 }),
        expected: projection,
      }).equivalent
        ? 'equivalent'
        : 'diverged';
    }
    case 'rebuild-late-data': {
      const projection = makeProjection();
      const lateFact = fact(11, 'b', { sourceReceiptRef: 'receipt:source-a:0002' });
      const rebuilt = rebuildProjection({
        definition: makeMetricDefinition(),
        facts: deduplicateFacts([...makeFacts({ a: 5, b: 5 }), lateFact]),
        expected: projection,
        versionRef: 'projection:0002',
      });
      return !rebuilt.equivalent &&
        rebuilt.projection.supersedesVersionRef === projection.versionRef
        ? 'superseded'
        : 'unchanged';
    }
  }
}
