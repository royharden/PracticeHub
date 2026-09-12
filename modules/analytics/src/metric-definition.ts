import { createHash } from 'node:crypto';

import { AnalyticsInvariantError, analyticsDimensions, type MetricDefinition } from './types.js';

const refPattern = /^[a-z0-9][a-z0-9:./-]*$/;

export function assertMetricDefinition(definition: MetricDefinition): void {
  if (definition.synthetic !== true) {
    throw new AnalyticsInvariantError('metric definitions must be synthetic-watermarked');
  }
  if (!refPattern.test(definition.metricId)) {
    throw new AnalyticsInvariantError('metricId must be a constrained reference');
  }
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
    throw new AnalyticsInvariantError('metric version must be a positive integer');
  }
  if (!['draft', 'active', 'superseded'].includes(definition.status)) {
    throw new AnalyticsInvariantError('metric status is outside the closed vocabulary');
  }
  if (!['none', 'demographic', 'PHI'].includes(definition.maximumClassification)) {
    throw new AnalyticsInvariantError('metric classification ceiling is not analytics-safe');
  }
  if (
    !refPattern.test(definition.denominatorRef) ||
    !refPattern.test(definition.accountableOwnerRef)
  ) {
    throw new AnalyticsInvariantError(
      'metric denominator and owner must be constrained references',
    );
  }
  if (!Number.isSafeInteger(definition.minimumCellCount) || definition.minimumCellCount < 2) {
    throw new AnalyticsInvariantError('minimumCellCount must be an integer of at least 2');
  }
  if (
    !Number.isFinite(definition.freshnessObjectiveMinutes) ||
    definition.freshnessObjectiveMinutes <= 0
  ) {
    throw new AnalyticsInvariantError('freshness objective must be positive');
  }
  if (definition.allowedEventTypes.length === 0 || definition.requiredSourceRefs.length === 0) {
    throw new AnalyticsInvariantError('a metric declares event types and required sources');
  }
  if (
    definition.allowedEventTypes.some((value) => !refPattern.test(value)) ||
    new Set(definition.allowedEventTypes).size !== definition.allowedEventTypes.length ||
    definition.requiredSourceRefs.some((value) => !refPattern.test(value)) ||
    new Set(definition.requiredSourceRefs).size !== definition.requiredSourceRefs.length
  ) {
    throw new AnalyticsInvariantError('metric event types and sources must be unique references');
  }
  if (definition.dimensions.some((dimension) => !analyticsDimensions.includes(dimension))) {
    throw new AnalyticsInvariantError('metric contains an unknown dimension');
  }
  const atoms = new Set(definition.releaseFamily.atomicCellIds);
  if (atoms.size === 0 || atoms.size !== definition.releaseFamily.atomicCellIds.length) {
    throw new AnalyticsInvariantError('release family atomic cells must be unique and non-empty');
  }
  if (
    !refPattern.test(definition.releaseFamily.familyId) ||
    definition.releaseFamily.atomicCellIds.some((cell) => !refPattern.test(cell))
  ) {
    throw new AnalyticsInvariantError('release family ids must be constrained references');
  }
  if (definition.releaseFamily.nodes.length === 0) {
    throw new AnalyticsInvariantError('release family must declare at least one query node');
  }
  const nodeIds = new Set<string>();
  const coveredAtoms = new Set<string>();
  for (const node of definition.releaseFamily.nodes) {
    if (nodeIds.has(node.nodeId) || node.memberCellIds.length === 0) {
      throw new AnalyticsInvariantError('release nodes must be unique and non-empty');
    }
    if (!refPattern.test(node.nodeId)) {
      throw new AnalyticsInvariantError('release node ids must be constrained references');
    }
    nodeIds.add(node.nodeId);
    const members = new Set(node.memberCellIds);
    if (members.size !== node.memberCellIds.length) {
      throw new AnalyticsInvariantError(`release node ${node.nodeId} repeats an atomic cell`);
    }
    if (node.memberCellIds.some((cell) => !atoms.has(cell))) {
      throw new AnalyticsInvariantError(`release node ${node.nodeId} names an unknown atomic cell`);
    }
    for (const cell of node.memberCellIds) coveredAtoms.add(cell);
  }
  if (coveredAtoms.size !== atoms.size) {
    throw new AnalyticsInvariantError('every atomic cell must appear in the declared query family');
  }
}

export function metricDefinitionKey(definition: MetricDefinition): string {
  assertMetricDefinition(definition);
  return `${definition.metricId}:v${definition.version}`;
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

export function metricDefinitionHash(definition: MetricDefinition): string {
  assertMetricDefinition(definition);
  return createHash('sha256').update(canonical(definition)).digest('hex');
}
