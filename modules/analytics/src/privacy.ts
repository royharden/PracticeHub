import { aggregateNode } from './projection.js';
import {
  AnalyticsInvariantError,
  type DisclosureRecord,
  type DisclosureScope,
  type MetricDefinition,
  type ProjectionVersion,
  type ReleaseNode,
} from './types.js';

const sameDatasetCohort = (record: DisclosureRecord, scope: DisclosureScope): boolean =>
  record.tenantId === scope.tenantId &&
  record.datasetId === scope.datasetId &&
  record.cohortRef === scope.cohortRef;

const difference = (left: ReleaseNode, right: ReleaseNode): readonly string[] => {
  const rightCells = new Set(right.memberCellIds);
  return left.memberCellIds.filter((cell) => !rightCells.has(cell));
};

const residualSafe = (
  projection: ProjectionVersion,
  definition: MetricDefinition,
  cellIds: readonly string[],
): boolean =>
  cellIds.length === 0 || aggregateNode(projection, cellIds).count >= definition.minimumCellCount;

/**
 * Compute the safe release set for the WHOLE declared family. This is
 * independent of request order and principal. The conservative atomic-cell
 * proof covers arbitrary combinations, not only pairs of allowed nodes.
 */
export function safeReleaseNodeIds(
  definition: MetricDefinition,
  projection: ProjectionVersion,
): ReadonlySet<string> {
  // This intentionally conservative rule proves safety for an arbitrary closed
  // family, including combinations of three or more queries: if every atomic,
  // mutually-exclusive cell is independently at least k, no linear combination
  // of released family nodes can reconstruct a sub-k atom. Pairwise residual
  // checks alone are insufficient (for example total, b, c can reveal a).
  const allAtomsSafe = definition.releaseFamily.atomicCellIds.every(
    (cellId) => aggregateNode(projection, [cellId]).count >= definition.minimumCellCount,
  );
  if (!allAtomsSafe) return new Set<string>();

  const safe = new Set<string>();
  for (const candidate of definition.releaseFamily.nodes) {
    const candidateCell = aggregateNode(projection, candidate.memberCellIds);
    if (candidateCell.count < definition.minimumCellCount) continue;
    safe.add(candidate.nodeId);
  }
  return safe;
}

export type ReleaseDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: 'small-cell' | 'differencing-risk' };

export function evaluateRelease(input: {
  readonly definition: MetricDefinition;
  readonly projection: ProjectionVersion;
  readonly scope: DisclosureScope;
  readonly nodeId: string;
  readonly history: readonly DisclosureRecord[];
}): ReleaseDecision {
  if (
    input.scope.tenantId !== input.projection.tenantId ||
    input.scope.datasetId !== input.projection.datasetId ||
    input.scope.cohortRef !== input.projection.cohortRef ||
    input.scope.metricId !== input.projection.metricId ||
    input.scope.projectionVersionRef !== input.projection.versionRef
  ) {
    throw new AnalyticsInvariantError('disclosure scope does not match the projection');
  }
  const node = input.definition.releaseFamily.nodes.find(
    (candidate) => candidate.nodeId === input.nodeId,
  );
  if (node === undefined) {
    throw new AnalyticsInvariantError('query is outside the declared release family');
  }
  const count = aggregateNode(input.projection, node.memberCellIds).count;
  if (count < input.definition.minimumCellCount) {
    return { allowed: false, reason: 'small-cell' };
  }
  if (!safeReleaseNodeIds(input.definition, input.projection).has(node.nodeId)) {
    return { allowed: false, reason: 'differencing-risk' };
  }

  // History is deliberately scoped without actor/principal. Views and exports
  // from different accounts share one tenant/dataset/cohort release history.
  const relevant = input.history.filter((record) => sameDatasetCohort(record, input.scope));
  // A different version, metric, or purpose can encode another equation over
  // the same cohort. Until a reviewed temporal composition rule exists, such a
  // prior disclosure blocks release rather than trusting per-version history.
  if (
    relevant.some(
      (record) =>
        record.metricId !== input.projection.metricId ||
        record.projectionVersionRef !== input.projection.versionRef ||
        record.purpose !== input.scope.purpose,
    )
  ) {
    return { allowed: false, reason: 'differencing-risk' };
  }
  for (const record of relevant) {
    const prior = input.definition.releaseFamily.nodes.find(
      (candidate) => candidate.nodeId === record.nodeId,
    );
    if (
      prior !== undefined &&
      (!residualSafe(input.projection, input.definition, difference(node, prior)) ||
        !residualSafe(input.projection, input.definition, difference(prior, node)))
    ) {
      return { allowed: false, reason: 'differencing-risk' };
    }
  }
  return { allowed: true };
}
