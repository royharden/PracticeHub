import { describe, expect, it } from 'vitest';

import {
  makeFixturePorts,
  makeMetricDefinition,
  makeProjection,
  qualityTaskIds,
} from './analytics-fixture-harness.js';
import { projectionContentHash } from './projection.js';
import { queryAnalytics, type AnalyticsQueryInput } from './query.js';

const baseInput = (): AnalyticsQueryInput => {
  const projection = makeProjection();
  return {
    definition: makeMetricDefinition(),
    projection,
    tenantId: projection.tenantId,
    ...(projection.legalEntityId === undefined ? {} : { legalEntityId: projection.legalEntityId }),
    actorRef: 'user:analytics-reader',
    purpose: 'operations',
    nodeId: 'total',
    surface: 'view',
    identityResolved: true,
    segments: ['administrative'],
    occurredAt: '2026-03-10T12:00:00.000Z',
    disclosureId: 'disclosure:query-test',
    qualityTaskIds: qualityTaskIds('query-test'),
  };
};

describe('analytics query decisions', () => {
  it('returns an available version with lineage and records disclosure/audit', async () => {
    const ports = makeFixturePorts();
    const decision = await queryAnalytics(baseInput(), ports);
    expect(decision).toMatchObject({ kind: 'available', count: 10, value: 10 });
    expect(ports.audits).toEqual(['allow']);
    expect(ports.disclosures.records).toHaveLength(1);
  });

  it('fails closed for inactive definitions and tampered projection bytes', async () => {
    const inactive = baseInput();
    expect(
      await queryAnalytics(
        { ...inactive, definition: { ...inactive.definition, status: 'superseded' } },
        makeFixturePorts(),
      ),
    ).toEqual({ kind: 'unavailable', reason: 'no-authorized-version' });
    const tampered = baseInput();
    expect(
      await queryAnalytics(
        { ...tampered, projection: { ...tampered.projection, cells: [] } },
        makeFixturePorts(),
      ),
    ).toEqual({ kind: 'unavailable', reason: 'no-authorized-version' });
    const quarantined = baseInput();
    const { contentHash: _priorHash, ...withoutHash } = quarantined.projection;
    if (_priorHash.length !== 64) throw new Error('fixture projection hash is malformed');
    const quarantineBytes = { ...withoutHash, verificationStatus: 'quarantined' as const };
    expect(
      await queryAnalytics(
        {
          ...quarantined,
          projection: {
            ...quarantineBytes,
            contentHash: projectionContentHash(quarantineBytes),
          },
        },
        makeFixturePorts(),
      ),
    ).toEqual({ kind: 'unavailable', reason: 'no-authorized-version' });
  });

  it('binds the authoritative definition contents, not only metric and version', async () => {
    const input = baseInput();
    const projection = makeProjection({ a: 3, b: 3 });
    const substituted = makeMetricDefinition({ minimumCellCount: 2 });
    expect(
      await queryAnalytics({ ...input, definition: substituted, projection }, makeFixturePorts()),
    ).toEqual({ kind: 'unavailable', reason: 'no-authorized-version' });
  });

  it.each([
    {
      label: 'cross-entity access',
      mutate: (input: AnalyticsQueryInput): AnalyticsQueryInput => ({
        ...input,
        tenantId: 'riverbend-synthetic',
      }),
      expectedKind: 'masked',
      expectedReason: 'cross-entity-access',
    },
    {
      label: 'small-cell or differencing suppression',
      mutate: (input: AnalyticsQueryInput): AnalyticsQueryInput => ({
        ...input,
        projection: makeProjection({ a: 5, b: 3 }),
      }),
      expectedKind: 'suppressed',
      expectedReason: 'small-cell-or-differencing',
    },
    {
      label: 'unresolved identity join',
      mutate: (input: AnalyticsQueryInput): AnalyticsQueryInput => ({
        ...input,
        identityResolved: false,
      }),
      expectedKind: 'masked',
      expectedReason: 'unresolved-identity-join',
    },
    {
      label: 'missing source receipt',
      mutate: (input: AnalyticsQueryInput): AnalyticsQueryInput => ({
        ...input,
        projection: makeProjection({ sourceReceiptRef: '' }),
      }),
      expectedKind: 'stale',
      expectedReason: 'missing-source-receipt',
    },
  ])(
    'opens a data-quality WorkItem for EX1: $label',
    async ({ mutate, expectedKind, expectedReason }) => {
      const ports = makeFixturePorts();
      const decision = await queryAnalytics(mutate(baseInput()), ports);
      expect(decision.kind).toBe(expectedKind);
      expect(ports.reasons).toEqual([expectedReason]);
      expect(ports.audits).toEqual(['deny']);
    },
  );

  it('uses one disclosure history across users, views and exports', async () => {
    const ports = makeFixturePorts();
    await queryAnalytics(baseInput(), ports);
    await queryAnalytics(
      {
        ...baseInput(),
        actorRef: 'user:second-reader',
        surface: 'export',
        disclosureId: 'disclosure:second-reader',
      },
      ports,
    );
    expect(ports.disclosures.records.map((record) => record.surface)).toEqual(['view', 'export']);
  });

  it('sends the complete analytic resource to authorization', async () => {
    const ports = makeFixturePorts();
    let resource: Parameters<typeof ports.access.evaluate>[0] | undefined;
    const decision = await queryAnalytics(baseInput(), {
      ...ports,
      access: {
        evaluate: async (input) => {
          resource = input;
          return { allowed: true, policyVersion: 'AUTH-021:v1' };
        },
      },
    });
    expect(decision.kind).toBe('available');
    expect(resource).toMatchObject({
      datasetId: 'dataset:visits',
      cohortRef: 'cohort:all',
      metricId: 'analytics.synthetic.completed-visits',
      metricVersion: 1,
      nodeId: 'total',
      maximumClassification: 'PHI',
      segments: ['administrative'],
      drilldown: 'work-item-refs',
    });
  });

  it.each([
    ['version order v1/v2', false, false],
    ['version order v2/v1', true, false],
    ['purpose order operations/audit', false, true],
    ['purpose order audit/operations', true, true],
  ] as const)('serializes concurrent global history: %s', async (_label, reverse, varyPurpose) => {
    const ports = makeFixturePorts();
    const first = {
      ...baseInput(),
      projection: makeProjection({ versionRef: 'projection:0001' }),
      purpose: 'operations',
      actorRef: 'user:first',
      surface: 'view' as const,
      disclosureId: 'disclosure:first',
    };
    const second = {
      ...baseInput(),
      projection: makeProjection({
        versionRef: varyPurpose ? 'projection:0001' : 'projection:0002',
      }),
      purpose: varyPurpose ? 'audit' : 'operations',
      actorRef: 'user:second',
      surface: 'export' as const,
      disclosureId: 'disclosure:second',
    };
    const requests = reverse ? [second, first] : [first, second];
    const decisions = await Promise.all(
      requests.map(async (request) => queryAnalytics(request, ports)),
    );
    expect(decisions.map((decision) => decision.kind).sort()).toEqual(['available', 'suppressed']);
    expect(ports.disclosures.records).toHaveLength(1);
  });
});
