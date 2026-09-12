import { buildProjection, projectionContentHash } from './projection.js';
import type { AnalyticsFact, MetricDefinition, ProjectionVersion } from './types.js';

export interface RebuildResult {
  readonly projection: ProjectionVersion;
  readonly equivalent: boolean;
  readonly quarantineReason?: 'expected-integrity-invalid' | 'rebuild-divergence';
}

export function rebuildProjection(input: {
  readonly definition: MetricDefinition;
  readonly facts: readonly AnalyticsFact[];
  readonly expected: ProjectionVersion;
  readonly versionRef?: string;
  readonly builtAt?: string;
}): RebuildResult {
  const { contentHash: expectedHash, ...expectedWithoutHash } = input.expected;
  const expectedIntegrityValid = projectionContentHash(expectedWithoutHash) === expectedHash;
  const projection = buildProjection({
    definition: input.definition,
    facts: input.facts,
    datasetId: input.expected.datasetId,
    cohortRef: input.expected.cohortRef,
    versionRef: input.versionRef ?? input.expected.versionRef,
    builtAt: input.builtAt ?? input.expected.builtAt,
    ...(input.versionRef === undefined
      ? input.expected.supersedesVersionRef === undefined
        ? {}
        : { supersedesVersionRef: input.expected.supersedesVersionRef }
      : { supersedesVersionRef: input.expected.versionRef }),
  });
  const equivalent =
    expectedIntegrityValid && projection.contentHash === input.expected.contentHash;
  if (equivalent) return { projection, equivalent: true };
  const { contentHash: _verifiedHash, ...withoutHash } = projection;
  if (_verifiedHash.length !== 64) throw new Error('rebuilt projection hash is malformed');
  const quarantinedWithoutHash: Omit<ProjectionVersion, 'contentHash'> = {
    ...withoutHash,
    verificationStatus: 'quarantined',
  };
  return {
    projection: {
      ...quarantinedWithoutHash,
      contentHash: projectionContentHash(quarantinedWithoutHash),
    },
    equivalent: false,
    quarantineReason: expectedIntegrityValid ? 'rebuild-divergence' : 'expected-integrity-invalid',
  };
}
