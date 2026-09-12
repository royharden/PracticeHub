import { assessFreshness } from './freshness.js';
import { assertMetricDefinition, metricDefinitionHash } from './metric-definition.js';
import { aggregateNode, projectionIntegrityValid } from './projection.js';
import { evaluateRelease } from './privacy.js';
import type {
  AnalyticsAccessPort,
  AnalyticsWorkItemPort,
  AuditEvidencePort,
  DisclosureHistoryPort,
} from './source-ports.js';
import {
  AnalyticsInvariantError,
  type AnalyticsDeliverySurface,
  type AnalyticsQueryDecision,
  type DataQualityReason,
  type DisclosureScope,
  type MetricDefinition,
  type ProjectionVersion,
} from './types.js';

export interface AnalyticsQueryPorts {
  readonly access: AnalyticsAccessPort;
  readonly workItems: AnalyticsWorkItemPort;
  readonly disclosures: DisclosureHistoryPort;
  readonly audit: AuditEvidencePort;
}

export interface AnalyticsQueryInput {
  readonly definition: MetricDefinition;
  readonly projection: ProjectionVersion;
  readonly tenantId: string;
  readonly legalEntityId?: string;
  readonly actorRef: string;
  readonly purpose: string;
  readonly nodeId: string;
  readonly surface: AnalyticsDeliverySurface;
  readonly identityResolved: boolean;
  readonly segments: readonly string[];
  readonly occurredAt: string;
  readonly disclosureId: string;
  readonly qualityTaskIds: Readonly<Record<DataQualityReason, string>>;
}

async function qualityTask(
  input: AnalyticsQueryInput,
  ports: AnalyticsQueryPorts,
  reason: DataQualityReason,
): Promise<string> {
  const workItemId = input.qualityTaskIds[reason];
  const result = await ports.workItems.createDataQualityWorkItem({
    tenantId: input.projection.tenantId,
    reason,
    subjectRef: `analytics:${input.projection.datasetId}:${input.projection.cohortRef}`,
    openedAt: input.occurredAt,
    workItemId,
    synthetic: true,
  });
  return result.workItemRef;
}

async function audit(
  input: AnalyticsQueryInput,
  ports: AnalyticsQueryPorts,
  decision: 'allow' | 'deny',
  policyVersion: string,
): Promise<void> {
  await ports.audit.record({
    action: `${input.surface}-analytics-${input.nodeId}`,
    decision,
    subjectRef: `analytics:${input.projection.datasetId}:${input.projection.cohortRef}`,
    policyVersion,
    occurredAt: input.occurredAt,
    synthetic: true,
  });
}

export async function queryAnalytics(
  input: AnalyticsQueryInput,
  ports: AnalyticsQueryPorts,
): Promise<AnalyticsQueryDecision> {
  assertMetricDefinition(input.definition);
  if (
    input.definition.status !== 'active' ||
    input.definition.metricId !== input.projection.metricId ||
    input.definition.version !== input.projection.metricVersion ||
    metricDefinitionHash(input.definition) !== input.projection.definitionHash ||
    input.projection.verificationStatus !== 'verified' ||
    !projectionIntegrityValid(input.projection)
  ) {
    return { kind: 'unavailable', reason: 'no-authorized-version' };
  }
  const sameEntity =
    input.tenantId === input.projection.tenantId &&
    input.legalEntityId === input.projection.legalEntityId;
  if (!sameEntity) {
    const ref = await qualityTask(input, ports, 'cross-entity-access');
    await audit(input, ports, 'deny', 'scope-precondition');
    return {
      kind: 'masked',
      reason: 'access-scope',
      versionRef: input.projection.versionRef,
      qualityTaskRef: ref,
    };
  }
  if (!input.identityResolved) {
    const ref = await qualityTask(input, ports, 'unresolved-identity-join');
    await audit(input, ports, 'deny', 'identity-precondition');
    return {
      kind: 'masked',
      reason: 'identity-unresolved',
      versionRef: input.projection.versionRef,
      qualityTaskRef: ref,
    };
  }
  const access = await ports.access.evaluate({
    tenantId: input.tenantId,
    ...(input.legalEntityId === undefined ? {} : { legalEntityId: input.legalEntityId }),
    actorRef: input.actorRef,
    purpose: input.purpose,
    occurredAt: input.occurredAt,
    datasetId: input.projection.datasetId,
    cohortRef: input.projection.cohortRef,
    metricId: input.projection.metricId,
    metricVersion: input.projection.metricVersion,
    nodeId: input.nodeId,
    maximumClassification: input.projection.maximumClassification,
    partitionTags: input.projection.partitionTags,
    segments: input.segments,
    drilldown: 'work-item-refs',
  });
  if (!access.allowed) {
    const ref = await qualityTask(input, ports, 'cross-entity-access');
    await audit(input, ports, 'deny', access.policyVersion);
    return {
      kind: 'masked',
      reason: 'partition',
      versionRef: input.projection.versionRef,
      qualityTaskRef: ref,
    };
  }
  const freshness = assessFreshness(input.definition, input.projection, input.occurredAt);
  if (!freshness.fresh) {
    const ref = await qualityTask(input, ports, 'missing-source-receipt');
    await audit(input, ports, 'deny', access.policyVersion);
    return {
      kind: 'stale',
      reason: freshness.knownGaps.some((gap) => gap.startsWith('missing-'))
        ? 'missing-receipt'
        : 'late-source',
      versionRef: input.projection.versionRef,
      qualityTaskRef: ref,
      freshness,
    };
  }
  const scope: DisclosureScope = {
    tenantId: input.projection.tenantId,
    datasetId: input.projection.datasetId,
    cohortRef: input.projection.cohortRef,
    metricId: input.projection.metricId,
    projectionVersionRef: input.projection.versionRef,
    purpose: input.purpose,
  };
  const disclosure = {
    ...scope,
    disclosureId: input.disclosureId,
    nodeId: input.nodeId,
    surface: input.surface,
    occurredAt: input.occurredAt,
    synthetic: true,
  } as const;
  const release = await ports.disclosures.evaluateAndRecord(scope, disclosure, (history) =>
    evaluateRelease({
      definition: input.definition,
      projection: input.projection,
      scope,
      nodeId: input.nodeId,
      history,
    }),
  );
  if (!release.allowed) {
    const ref = await qualityTask(input, ports, 'small-cell-or-differencing');
    await audit(input, ports, 'deny', access.policyVersion);
    return {
      kind: 'suppressed',
      reason: release.reason,
      versionRef: input.projection.versionRef,
      qualityTaskRef: ref,
    };
  }
  const node = input.definition.releaseFamily.nodes.find(
    (candidate) => candidate.nodeId === input.nodeId,
  );
  if (node === undefined) throw new AnalyticsInvariantError('release node disappeared');
  const cell = aggregateNode(input.projection, node.memberCellIds);
  await audit(input, ports, 'allow', access.policyVersion);
  return {
    kind: 'available',
    versionRef: input.projection.versionRef,
    nodeId: input.nodeId,
    count: cell.count,
    value: cell.value,
    workItemRefs: cell.workItemRefs,
    freshness,
  };
}
