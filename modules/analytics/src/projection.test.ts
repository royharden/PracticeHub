import type { TenantId } from '@practicehub/contracts';
import { describe, expect, it } from 'vitest';

import { makeFacts, makeMetricDefinition, makeProjection } from './analytics-fixture-harness.js';
import { aggregateNode, buildProjection } from './projection.js';
import { createPostgresProjectionStore } from './source-ports.js';

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected fixture fact');
  return value;
}

describe('analytics projection', () => {
  it('builds an immutable version with source offsets and WorkItem drill-through refs', () => {
    const projection = makeProjection({ a: 5, b: 5 });
    expect(aggregateNode(projection, ['a', 'b'])).toMatchObject({ count: 10, value: 10 });
    expect(projection.sourceOffsets).toEqual([
      {
        sourceRef: 'source-a',
        highWaterMark: '10',
        loadedAt: '2026-03-10T12:00:00.000Z',
        receiptRef: 'receipt:source-a:0001',
      },
    ]);
    expect(projection.cells[0]?.workItemRefs).toContain('work-item:source-1');
  });

  it('hashes the same facts deterministically regardless of input order', () => {
    const facts = makeFacts({ a: 5, b: 5 });
    const common = {
      definition: makeMetricDefinition(),
      datasetId: 'dataset:visits',
      cohortRef: 'cohort:all',
      versionRef: 'projection:0001',
      builtAt: '2026-03-10T12:00:00.000Z',
    };
    const forward = buildProjection({ ...common, facts });
    const reverse = buildProjection({ ...common, facts: [...facts].reverse() });
    expect(reverse.contentHash).toBe(forward.contentHash);
  });

  it('uses numeric source-offset ordering rather than lexical ordering', () => {
    const facts = makeFacts({ a: 2, b: 0 }).map((fact, index) => ({
      ...fact,
      sourceOffset: index === 0 ? '9' : '10',
    }));
    const projection = buildProjection({
      definition: makeMetricDefinition(),
      facts,
      datasetId: 'dataset:visits',
      cohortRef: 'cohort:all',
      versionRef: 'projection:offsets',
      builtAt: '2026-03-10T12:00:00.000Z',
    });
    expect(projection.sourceOffsets[0]?.highWaterMark).toBe('10');
  });

  it('rejects inexact measure arithmetic', () => {
    const fact = required(makeFacts({ a: 1, b: 0 })[0]);
    expect(() =>
      buildProjection({
        definition: makeMetricDefinition(),
        facts: [{ ...fact, measure: Number.MAX_SAFE_INTEGER + 1 }],
        datasetId: 'dataset:visits',
        cohortRef: 'cohort:all',
        versionRef: 'projection:inexact',
        builtAt: '2026-03-10T12:00:00.000Z',
      }),
    ).toThrow(/exact safe integer/);
  });

  it('rejects an inexact aggregate even when individual cells are safe', () => {
    const projection = {
      ...makeProjection(),
      cells: [
        { cellId: 'a', count: 5, value: Number.MAX_SAFE_INTEGER, workItemRefs: [] },
        { cellId: 'b', count: 5, value: 2, workItemRefs: [] },
      ],
    };
    expect(() => aggregateNode(projection, ['a', 'b'])).toThrow(/aggregate exceeds/);
  });

  it('treats redelivery of an identical event as idempotent', () => {
    const facts = makeFacts({ a: 5, b: 5 });
    const first = required(facts[0]);
    const common = {
      definition: makeMetricDefinition(),
      datasetId: 'dataset:visits',
      cohortRef: 'cohort:all',
      versionRef: 'projection:0001',
      builtAt: '2026-03-10T12:00:00.000Z',
    };
    expect(buildProjection({ ...common, facts: [...facts, first] }).contentHash).toBe(
      buildProjection({ ...common, facts }).contentHash,
    );
  });

  it('rejects facts from mixed tenant scopes', () => {
    const facts = makeFacts({ a: 1, b: 1 });
    expect(() =>
      buildProjection({
        definition: makeMetricDefinition(),
        facts: [
          required(facts[0]),
          { ...required(facts[1]), tenantId: 'riverbend-synthetic' as TenantId },
        ],
        datasetId: 'dataset:visits',
        cohortRef: 'cohort:all',
        versionRef: 'projection:bad',
        builtAt: '2026-03-10T12:00:00.000Z',
      }),
    ).toThrow(/share scope/);
  });

  it('cannot bypass structural exclusions through the direct fact entrypoint', () => {
    const fact = required(makeFacts({ a: 1, b: 0 })[0]);
    expect(() =>
      buildProjection({
        definition: makeMetricDefinition(),
        facts: [
          {
            ...fact,
            classification: 'PHI-restricted',
            partitionTags: ['gipa-genetic'],
          },
        ],
        datasetId: 'dataset:visits',
        cohortRef: 'cohort:all',
        versionRef: 'projection:blocked',
        builtAt: '2026-03-10T12:00:00.000Z',
      }),
    ).toThrow(/classification exceeds|genetic data/);
  });

  it('folds supersession and reversal without erasing lineage', () => {
    const facts = makeFacts({ a: 5, b: 5 });
    const originalA = required(facts[0]);
    const originalB = required(facts[5]);
    const correction = {
      ...originalA,
      eventId: '01H00000000000000000000011' as typeof originalA.eventId,
      sourceOffset: '11',
      measure: 2,
      supersedesEventId: originalA.eventId,
      workItemRefs: ['work-item:correction'],
    };
    const corrected = buildProjection({
      definition: makeMetricDefinition(),
      facts: [...facts, correction],
      datasetId: 'dataset:visits',
      cohortRef: 'cohort:all',
      versionRef: 'projection:corrected',
      builtAt: '2026-03-10T12:05:00.000Z',
    });
    expect(corrected.cells[0]).toMatchObject({ count: 5, value: 6 });
    expect(corrected.eventIds).toContain(originalA.eventId);
    expect(corrected.eventIds).toContain(correction.eventId);

    const reversal = {
      ...originalB,
      eventId: '01H00000000000000000000012' as typeof originalB.eventId,
      sourceOffset: '12',
      reversalOfEventId: originalB.eventId,
      measure: 0,
      workItemRefs: ['work-item:reversal'],
    };
    const reversed = buildProjection({
      definition: makeMetricDefinition(),
      facts: [...facts, reversal],
      datasetId: 'dataset:visits',
      cohortRef: 'cohort:all',
      versionRef: 'projection:reversed',
      builtAt: '2026-03-10T12:06:00.000Z',
    });
    expect(reversed.cells[1]).toMatchObject({ count: 4, value: 4 });
    expect(reversed.eventIds).toContain(reversal.eventId);
  });

  it('rejects correction links that do not name an active prior fact', () => {
    const original = required(makeFacts({ a: 1, b: 0 })[0]);
    expect(() =>
      buildProjection({
        definition: makeMetricDefinition(),
        facts: [
          original,
          {
            ...original,
            eventId: '01H00000000000000000000011' as typeof original.eventId,
            sourceOffset: '11',
            supersedesEventId: '01H99999999999999999999999' as typeof original.eventId,
          },
        ],
        datasetId: 'dataset:visits',
        cohortRef: 'cohort:all',
        versionRef: 'projection:bad-correction',
        builtAt: '2026-03-10T12:05:00.000Z',
      }),
    ).toThrow(/active prior fact/);
  });

  it('rehydrates every persisted component and rejects corrupt child rows', async () => {
    const definition = makeMetricDefinition({
      releaseFamily: {
        familyId: 'reverse-definition-order',
        atomicCellIds: ['b', 'a'],
        nodes: [
          { nodeId: 'total', memberCellIds: ['b', 'a'] },
          { nodeId: 'b', memberCellIds: ['b'] },
          { nodeId: 'a', memberCellIds: ['a'] },
        ],
      },
    });
    const projection = buildProjection({
      definition,
      facts: makeFacts({ a: 5, b: 5 }).map((fact) => ({
        ...fact,
        occurredAt: '2026-03-10T12:00:00Z',
        recordedAt: '2026-03-10T12:00:00Z',
      })),
      datasetId: 'dataset:visits',
      cohortRef: 'cohort:all',
      versionRef: 'projection:representation-roundtrip',
      builtAt: '2026-03-10T12:00:00Z',
    });
    expect(projection.builtAt).toBe('2026-03-10T12:00:00.000Z');
    expect(projection.sourceOffsets[0]?.loadedAt).toBe('2026-03-10T12:00:00.000Z');
    expect(projection.cells.map((cell) => cell.cellId)).toEqual(['a', 'b']);
    const executor = (corrupt: boolean) => ({
      query: async (text: string) => {
        if (text.includes('FROM analytics.projection_version')) {
          return {
            rows: [
              {
                legal_entity_id: projection.legalEntityId,
                dataset_id: projection.datasetId,
                cohort_ref: projection.cohortRef,
                metric_id: projection.metricId,
                metric_version: projection.metricVersion,
                definition_hash: projection.definitionHash,
                built_at: projection.builtAt,
                event_ids: projection.eventIds,
                maximum_classification: projection.maximumClassification,
                partition_tags: projection.partitionTags,
                verification_status: projection.verificationStatus,
                content_hash: projection.contentHash,
                supersedes_version_ref: projection.supersedesVersionRef ?? null,
              },
            ],
          };
        }
        if (text.includes('FROM analytics.projection_cell')) {
          return {
            rows: projection.cells.map((cell, index) => ({
              cell_id: cell.cellId,
              member_count: cell.count,
              measure_value: corrupt && index === 0 ? cell.value + 1 : cell.value,
              work_item_refs: cell.workItemRefs,
            })),
          };
        }
        return {
          rows: projection.sourceOffsets.map((offset) => ({
            source_ref: offset.sourceRef,
            high_water_mark: offset.highWaterMark,
            loaded_at: offset.loadedAt,
            receipt_ref: offset.receiptRef ?? null,
          })),
        };
      },
    });
    await expect(
      createPostgresProjectionStore(executor(false)).load(
        projection.tenantId,
        projection.versionRef,
      ),
    ).resolves.toEqual(projection);
    await expect(
      createPostgresProjectionStore(executor(true)).load(
        projection.tenantId,
        projection.versionRef,
      ),
    ).rejects.toThrow(/failed content-hash validation/);
  });
});
