import { createHash } from 'node:crypto';

import type { EventEnvelope } from '@practicehub/contracts';
import type { DrainConsumerSpec, Queryable } from '@practicehub/events';
import type { CapabilityId } from '@practicehub/platform-core';

import { assertMetricDefinition } from './metric-definition.js';
import { AnalyticsInvariantError, type AnalyticsFact, type MetricDefinition } from './types.js';

export interface DomainFactAdapter {
  readonly map: (event: EventEnvelope<unknown>, definition: MetricDefinition) => AnalyticsFact;
}

const classificationRank = {
  none: 0,
  demographic: 1,
  PHI: 2,
  'PHI-restricted': 3,
  secret: 4,
} as const;

const isoInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function canonicalInstant(value: string): string {
  if (!isoInstantPattern.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new AnalyticsInvariantError('fact timestamps must be valid ISO instants');
  }
  return new Date(value).toISOString();
}

export function canonicalizeAnalyticsFact(fact: AnalyticsFact): AnalyticsFact {
  return {
    ...fact,
    occurredAt: canonicalInstant(fact.occurredAt),
    recordedAt: canonicalInstant(fact.recordedAt),
  };
}

export function validateAnalyticsFact(
  definition: MetricDefinition,
  event: EventEnvelope<unknown>,
  fact: AnalyticsFact,
): void {
  assertMetricDefinition(definition);
  assertIntrinsicAnalyticsFact(definition, fact);
  if (event.synthetic !== true) {
    throw new AnalyticsInvariantError('analytics accepts synthetic-watermarked inputs only');
  }
  if (!definition.allowedEventTypes.includes(event.type) || fact.eventType !== event.type) {
    throw new AnalyticsInvariantError(`event type ${event.type} is not declared by the metric`);
  }
  if (fact.eventId !== event.eventId || fact.tenantId !== event.tenantId) {
    throw new AnalyticsInvariantError('fact scope must match its event envelope');
  }
  if (fact.classification !== event.dataClassification) {
    throw new AnalyticsInvariantError('fact classification must match its event envelope');
  }
  if (
    fact.supersedesEventId !== event.supersedesEventId ||
    fact.reversalOfEventId !== event.reversalOfEventId
  ) {
    throw new AnalyticsInvariantError('fact correction links must match its event envelope');
  }
  if (fact.legalEntityId !== event.legalEntityId) {
    throw new AnalyticsInvariantError('fact legal entity must match its event envelope');
  }
  if (
    Date.parse(fact.occurredAt) !== Date.parse(event.occurredAt) ||
    Date.parse(fact.recordedAt) !== Date.parse(event.recordedAt)
  ) {
    throw new AnalyticsInvariantError('fact timestamps must match its event envelope');
  }
  if (
    event.externalReceiptRef !== undefined &&
    fact.sourceReceiptRef !== event.externalReceiptRef
  ) {
    throw new AnalyticsInvariantError('fact source receipt must match its event envelope');
  }
}

/** Validate the fact itself at every public ingress, including replay/rebuild. */
export function assertIntrinsicAnalyticsFact(
  definition: MetricDefinition,
  fact: AnalyticsFact,
): void {
  assertMetricDefinition(definition);
  if (fact.synthetic !== true) {
    throw new AnalyticsInvariantError('analytics accepts synthetic-watermarked inputs only');
  }
  if (fact.metricId !== definition.metricId || fact.metricVersion !== definition.version) {
    throw new AnalyticsInvariantError('fact metric identity does not match its definition');
  }
  if (!definition.allowedEventTypes.includes(fact.eventType)) {
    throw new AnalyticsInvariantError(`fact event type ${fact.eventType} is not declared`);
  }
  if (!definition.releaseFamily.atomicCellIds.includes(fact.cellId)) {
    throw new AnalyticsInvariantError(`fact names undeclared atomic cell ${fact.cellId}`);
  }
  if (!Number.isSafeInteger(fact.measure)) {
    throw new AnalyticsInvariantError('fact measure must be an exact safe integer');
  }
  if (!Object.hasOwn(classificationRank, fact.classification)) {
    throw new AnalyticsInvariantError('fact classification is outside the closed vocabulary');
  }
  if (
    classificationRank[fact.classification] > classificationRank[definition.maximumClassification]
  ) {
    throw new AnalyticsInvariantError('fact classification exceeds the metric ceiling');
  }
  if (
    !Array.isArray(fact.partitionTags) ||
    fact.partitionTags.some((tag) => !['gipa-genetic', 'chd', 'part2', 'biometric'].includes(tag))
  ) {
    throw new AnalyticsInvariantError('fact partition tag is outside the closed vocabulary');
  }
  if (fact.classification === 'PHI-restricted' || fact.partitionTags.includes('gipa-genetic')) {
    throw new AnalyticsInvariantError('general analytics structurally excludes genetic data');
  }
  if (!definition.requiredSourceRefs.includes(fact.sourceRef)) {
    throw new AnalyticsInvariantError(`fact source ${fact.sourceRef} is not declared`);
  }
  if (!/^(0|[1-9]\d*)$/.test(fact.sourceOffset)) {
    throw new AnalyticsInvariantError('fact source offset must be a canonical unsigned decimal');
  }
  if (fact.sourceReceiptRef === undefined) {
    throw new AnalyticsInvariantError(`required source ${fact.sourceRef} has no receipt`);
  }
  if (fact.sourceReceiptRef.trim().length === 0) {
    throw new AnalyticsInvariantError('fact source receipt must be non-empty');
  }
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(fact.eventId)) {
    throw new AnalyticsInvariantError('fact event id must be a ULID');
  }
  if (fact.supersedesEventId !== undefined && fact.reversalOfEventId !== undefined) {
    throw new AnalyticsInvariantError('a fact cannot both supersede and reverse another event');
  }
  for (const linked of [fact.supersedesEventId, fact.reversalOfEventId]) {
    if (linked !== undefined && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(linked)) {
      throw new AnalyticsInvariantError('fact correction links must be ULIDs');
    }
  }
  if (
    !isoInstantPattern.test(fact.occurredAt) ||
    !isoInstantPattern.test(fact.recordedAt) ||
    !Number.isFinite(Date.parse(fact.occurredAt)) ||
    !Number.isFinite(Date.parse(fact.recordedAt))
  ) {
    throw new AnalyticsInvariantError('fact timestamps must be valid ISO instants');
  }
}

export function consumeAnalyticsEvent(
  definition: MetricDefinition,
  event: EventEnvelope<unknown>,
  adapter: DomainFactAdapter,
): AnalyticsFact {
  const fact = adapter.map(event, definition);
  validateAnalyticsFact(definition, event, fact);
  return canonicalizeAnalyticsFact(fact);
}

export function deduplicateFacts(facts: readonly AnalyticsFact[]): readonly AnalyticsFact[] {
  const byEvent = new Map<string, AnalyticsFact>();
  for (const inputFact of facts) {
    const fact = canonicalizeAnalyticsFact(inputFact);
    const prior = byEvent.get(fact.eventId);
    if (prior === undefined) {
      byEvent.set(fact.eventId, fact);
      continue;
    }
    if (analyticsFactHash(prior) !== analyticsFactHash(fact)) {
      throw new AnalyticsInvariantError(`event ${fact.eventId} maps to conflicting facts`);
    }
  }
  return [...byEvent.values()];
}

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

export function analyticsFactHash(fact: AnalyticsFact): string {
  return createHash('sha256')
    .update(canonical(canonicalizeAnalyticsFact(fact)))
    .digest('hex');
}

/** Persist the accepted, payload-free fact on the WP-021 inbox transaction. */
export async function persistAnalyticsFact(
  exec: Queryable,
  definition: MetricDefinition,
  fact: AnalyticsFact,
): Promise<void> {
  const canonicalFact = canonicalizeAnalyticsFact(fact);
  assertIntrinsicAnalyticsFact(definition, canonicalFact);
  await exec.query(
    `INSERT INTO analytics.projection_event
       (tenant_id, event_id, legal_entity_id, event_type, metric_id, metric_version,
        occurred_at, recorded_at, source_ref, source_offset, source_receipt_ref,
        supersedes_event_id, reversal_of_event_id, cell_id, measure_value,
        data_classification, partition_tags, work_item_refs, fact_hash, synthetic)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,true)`,
    [
      canonicalFact.tenantId,
      canonicalFact.eventId,
      canonicalFact.legalEntityId ?? null,
      canonicalFact.eventType,
      canonicalFact.metricId,
      canonicalFact.metricVersion,
      canonicalFact.occurredAt,
      canonicalFact.recordedAt,
      canonicalFact.sourceRef,
      canonicalFact.sourceOffset,
      canonicalFact.sourceReceiptRef ?? null,
      canonicalFact.supersedesEventId ?? null,
      canonicalFact.reversalOfEventId ?? null,
      canonicalFact.cellId,
      canonicalFact.measure,
      canonicalFact.classification,
      [...canonicalFact.partitionTags],
      [...canonicalFact.workItemRefs],
      analyticsFactHash(canonicalFact),
    ],
  );
}

/** Real WP-021 drain binding: inbox dedup, capability re-check, and fact append share a transaction. */
export function createAnalyticsDrainConsumer(
  definition: MetricDefinition,
  adapter: DomainFactAdapter,
): DrainConsumerSpec {
  return {
    consumer: `analytics:${definition.metricId}:v${definition.version}`,
    capabilityId: 'analytics.read-model' as CapabilityId,
    minimumState: 'simulated',
    scopeForEvent: () => ({ feature: definition.metricId }),
    sideEffect: async (exec, event) => {
      const fact = consumeAnalyticsEvent(definition, event, adapter);
      await persistAnalyticsFact(exec, definition, fact);
    },
  };
}
