import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { EventId, LegalEntityId, TenantId } from '@practicehub/contracts';
import { deliverClaimedEvent, enqueueEnvelope } from '@practicehub/events';
import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  makeFixturePorts,
  makeEnvelope,
  makeFacts,
  makeMetricDefinition,
  makeProjection,
  qualityTaskIds,
} from './analytics-fixture-harness.js';
import { analyticsFactHash, createAnalyticsDrainConsumer } from './event-consumer.js';
import { metricDefinitionHash } from './metric-definition.js';
import { projectionContentHash, projectionIntegrityValid } from './projection.js';
import { queryAnalytics, type AnalyticsQueryInput } from './query.js';
import {
  createPostgresDisclosureHistory,
  createPostgresExportReceiptStore,
  createPostgresProjectionStore,
  createWp022DataQualityPort,
} from './source-ports.js';
import type {
  AnalyticsFact,
  DataQualityReason,
  MetricDefinition,
  ProjectionVersion,
} from './types.js';
import { rebuildProjection } from './rebuild.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const host = process.env['PRACTICEHUB_DB_HOST'] ?? '127.0.0.1';
const port = Number(process.env['PRACTICEHUB_DB_PORT'] ?? '55432');
const northwind = 'northwind-synthetic';

const ownerConfig = {
  host,
  port,
  database: 'practicehub',
  user: 'practicehub',
  password: 'practicehub_synthetic_local',
};
const appConfig = {
  host,
  port,
  database: 'practicehub',
  user: 'practicehub_app',
  password: 'practicehub_app_synthetic_local',
};

const provisioningFiles = [
  'infra/postgres/init/001-bootstrap.sql',
  'modules/platform-core/migrations/0001-tenancy.sql',
  'modules/events/migrations/0010-events.sql',
  'modules/events/migrations/0012-workitems.sql',
  'modules/analytics/migrations/0026-analytics.sql',
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/014-workitems-seed.sql',
  'infra/postgres/seed/027-analytics-seed.sql',
] as const;

const analyticsTables = [
  'metric_definition',
  'projection_version',
  'projection_cell',
  'projection_source_offset',
  'projection_event',
  'projection_disclosure',
  'projection_export_receipt',
] as const;

let owner: Client;
let app: Client;

async function boundQuery<T extends Record<string, unknown>>(
  tenantId: string,
  sql: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  await app.query('BEGIN');
  try {
    await app.query(tenantBindingSql(tenantId));
    const result = await app.query(sql, [...values]);
    await app.query('COMMIT');
    return result.rows as T[];
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

async function boundError(tenantId: string, sql: string): Promise<string> {
  try {
    await boundQuery(tenantId, sql);
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  throw new Error(`expected query to be rejected: ${sql}`);
}

async function cleanup(): Promise<void> {
  await owner.query(
    "DELETE FROM analytics.projection_export_receipt WHERE export_receipt_id LIKE 'ana-db-%'",
  );
  await owner.query(
    "DELETE FROM analytics.projection_disclosure WHERE disclosure_id LIKE 'ana-db-%'",
  );
  await owner.query(
    "DELETE FROM analytics.projection_source_offset WHERE version_ref LIKE 'ana-db-%'",
  );
  await owner.query("DELETE FROM analytics.projection_cell WHERE version_ref LIKE 'ana-db-%'");
  await owner.query("DELETE FROM analytics.projection_version WHERE version_ref LIKE 'ana-db-%'");
  await owner.query(
    "DELETE FROM analytics.projection_event WHERE event_id = '01HZZZZZZZZZZZZZZZZZZZZZZZ'",
  );
  await owner.query("DELETE FROM events.inbox WHERE event_id = '01HZZZZZZZZZZZZZZZZZZZZZZZ'");
  await owner.query(
    "DELETE FROM events.outbox_delivery WHERE event_id = '01HZZZZZZZZZZZZZZZZZZZZZZZ'",
  );
  await owner.query("DELETE FROM events.outbox WHERE event_id = '01HZZZZZZZZZZZZZZZZZZZZZZZ'");
  await owner.query("DELETE FROM events.sla_timer WHERE work_item_id LIKE 'ana-db-%'");
  await owner.query("DELETE FROM events.work_item_event WHERE work_item_id LIKE 'ana-db-%'");
  await owner.query("DELETE FROM events.work_item WHERE work_item_id LIKE 'ana-db-%'");
}

function projectionIdentity(
  projection: ProjectionVersion,
  versionRef: string,
  cohortRef: string,
): ProjectionVersion {
  const { contentHash: _priorHash, ...withoutHash } = projection;
  if (_priorHash.length !== 64) throw new Error('fixture projection hash is malformed');
  const changed: Omit<ProjectionVersion, 'contentHash'> = {
    ...withoutHash,
    versionRef,
    cohortRef,
  };
  return { ...changed, contentHash: projectionContentHash(changed) };
}

beforeAll(async () => {
  owner = new Client(ownerConfig);
  await owner.connect();
  for (const file of provisioningFiles) {
    await owner.query(readFileSync(`${repoRoot}${file}`, 'utf8'));
  }
  await cleanup();
  app = new Client(appConfig);
  await app.connect();
});

afterEach(async () => {
  await app?.query('ROLLBACK').catch(() => undefined);
});

afterAll(async () => {
  await cleanup();
  await app?.end();
  await owner?.end();
});

describe('analytics DB acceptance', () => {
  it('forces tenant RLS on every analytics table', async () => {
    const rows = await owner.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'analytics' AND c.relkind = 'r'`,
    );
    expect(rows.rows.map((row) => row.relname).sort()).toEqual([...analyticsTables].sort());
    expect(rows.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
  });

  it('isolates tenants and gives unbound sessions no rows', async () => {
    expect(
      await boundQuery<{ count: string }>(
        northwind,
        'SELECT count(*)::text AS count FROM analytics.metric_definition',
      ),
    ).toEqual([{ count: '1' }]);
    expect(
      await boundQuery<{ count: string }>(
        'riverbend-synthetic',
        'SELECT count(*)::text AS count FROM analytics.metric_definition',
      ),
    ).toEqual([{ count: '0' }]);
    const unbound = await app.query(
      'SELECT count(*)::text AS count FROM analytics.metric_definition',
    );
    expect(unbound.rows).toEqual([{ count: '0' }]);
  });

  it('rebuilds the seeded projection byte-for-byte from durable accepted facts', async () => {
    const result = await owner.query<Record<string, unknown>>(
      `SELECT event_id, legal_entity_id, event_type, metric_id, metric_version,
              to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS occurred_at,
              to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at,
              source_ref, source_offset, source_receipt_ref, cell_id, measure_value,
              supersedes_event_id, reversal_of_event_id, data_classification,
              partition_tags, work_item_refs, fact_hash
         FROM analytics.projection_event
        WHERE tenant_id = 'northwind-synthetic' ORDER BY event_id`,
    );
    const facts: AnalyticsFact[] = result.rows.map((row) => ({
      tenantId: northwind as TenantId,
      legalEntityId: String(row['legal_entity_id']) as LegalEntityId,
      eventId: String(row['event_id']) as EventId,
      eventType: String(row['event_type']),
      metricId: String(row['metric_id']),
      metricVersion: Number(row['metric_version']),
      occurredAt: String(row['occurred_at']),
      recordedAt: String(row['recorded_at']),
      sourceRef: String(row['source_ref']),
      sourceOffset: String(row['source_offset']),
      sourceReceiptRef: String(row['source_receipt_ref']),
      ...(row['supersedes_event_id'] === null
        ? {}
        : { supersedesEventId: String(row['supersedes_event_id']) as EventId }),
      ...(row['reversal_of_event_id'] === null
        ? {}
        : { reversalOfEventId: String(row['reversal_of_event_id']) as EventId }),
      cellId: String(row['cell_id']),
      measure: Number(row['measure_value']),
      classification: row['data_classification'] as AnalyticsFact['classification'],
      partitionTags: row['partition_tags'] as AnalyticsFact['partitionTags'],
      workItemRefs: row['work_item_refs'] as readonly string[],
      synthetic: true,
    }));
    expect(facts.map(analyticsFactHash)).toEqual(result.rows.map((row) => row['fact_hash']));
    const version = await owner.query<Record<string, unknown>>(
      `SELECT tenant_id, version_ref, legal_entity_id, dataset_id, cohort_ref,
              metric_id, metric_version, definition_hash,
              to_char(built_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS built_at,
              event_ids, maximum_classification, partition_tags, content_hash,
              verification_status, supersedes_version_ref
         FROM analytics.projection_version
        WHERE tenant_id = 'northwind-synthetic' AND version_ref = 'projection-seed-0001'`,
    );
    const definitionResult = await owner.query<Record<string, unknown>>(
      `SELECT metric_id, metric_version, definition_hash, status, denominator_ref,
              allowed_event_types, required_source_refs, freshness_objective_minutes,
              dimensions, minimum_cell_count, maximum_classification,
              accountable_owner_ref, release_family, synthetic
         FROM analytics.metric_definition
        WHERE tenant_id = 'northwind-synthetic'
          AND metric_id = 'analytics.synthetic.completed-visits' AND metric_version = 1`,
    );
    const cells = await owner.query<Record<string, unknown>>(
      `SELECT cell_id, member_count, measure_value, work_item_refs
         FROM analytics.projection_cell
        WHERE tenant_id = 'northwind-synthetic' AND version_ref = 'projection-seed-0001'
        ORDER BY cell_id`,
    );
    const offsets = await owner.query<Record<string, unknown>>(
      `SELECT source_ref, high_water_mark,
              to_char(loaded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS loaded_at,
              receipt_ref
         FROM analytics.projection_source_offset
        WHERE tenant_id = 'northwind-synthetic' AND version_ref = 'projection-seed-0001'
        ORDER BY source_ref`,
    );
    const row = version.rows[0];
    if (row === undefined) throw new Error('seed projection version missing');
    const definitionRow = definitionResult.rows[0];
    if (definitionRow === undefined) throw new Error('seed metric definition missing');
    const definition: MetricDefinition = {
      metricId: String(definitionRow['metric_id']),
      version: Number(definitionRow['metric_version']),
      status: definitionRow['status'] as MetricDefinition['status'],
      denominatorRef: String(definitionRow['denominator_ref']),
      allowedEventTypes: definitionRow['allowed_event_types'] as readonly string[],
      requiredSourceRefs: definitionRow['required_source_refs'] as readonly string[],
      freshnessObjectiveMinutes: Number(definitionRow['freshness_objective_minutes']),
      dimensions: definitionRow['dimensions'] as MetricDefinition['dimensions'],
      minimumCellCount: Number(definitionRow['minimum_cell_count']),
      maximumClassification: definitionRow[
        'maximum_classification'
      ] as MetricDefinition['maximumClassification'],
      accountableOwnerRef: String(definitionRow['accountable_owner_ref']),
      releaseFamily: definitionRow['release_family'] as MetricDefinition['releaseFamily'],
      synthetic: true,
    };
    const stored: ProjectionVersion = {
      tenantId: String(row['tenant_id']) as TenantId,
      legalEntityId: String(row['legal_entity_id']) as LegalEntityId,
      datasetId: String(row['dataset_id']),
      cohortRef: String(row['cohort_ref']),
      metricId: String(row['metric_id']),
      metricVersion: Number(row['metric_version']),
      definitionHash: String(row['definition_hash']),
      versionRef: String(row['version_ref']),
      builtAt: String(row['built_at']),
      eventIds: row['event_ids'] as readonly EventId[],
      sourceOffsets: offsets.rows.map((offset) => ({
        sourceRef: String(offset['source_ref']),
        highWaterMark: String(offset['high_water_mark']),
        loadedAt: String(offset['loaded_at']),
        receiptRef: String(offset['receipt_ref']),
      })),
      cells: cells.rows.map((cell) => ({
        cellId: String(cell['cell_id']),
        count: Number(cell['member_count']),
        value: Number(cell['measure_value']),
        workItemRefs: cell['work_item_refs'] as readonly string[],
      })),
      maximumClassification: row[
        'maximum_classification'
      ] as ProjectionVersion['maximumClassification'],
      partitionTags: row['partition_tags'] as ProjectionVersion['partitionTags'],
      verificationStatus: row['verification_status'] as ProjectionVersion['verificationStatus'],
      contentHash: String(row['content_hash']),
      synthetic: true,
    };
    expect(definition).toEqual(makeMetricDefinition());
    expect(stored.definitionHash).toBe(metricDefinitionHash(definition));
    expect(definitionRow['definition_hash']).toBe(stored.definitionHash);
    expect(projectionIntegrityValid(stored)).toBe(true);
    const rebuilt = rebuildProjection({
      definition,
      facts,
      expected: stored,
    });
    expect(rebuilt.equivalent).toBe(true);
    expect(rebuilt.projection).toEqual(stored);
  });

  it('keeps definitions, versions, facts, disclosures, and receipts append-only', async () => {
    expect(
      await boundError(
        northwind,
        `INSERT INTO analytics.metric_definition
           (tenant_id, metric_id, metric_version, status, denominator_ref,
            allowed_event_types, required_source_refs, freshness_objective_minutes,
            dimensions, minimum_cell_count, maximum_classification,
            accountable_owner_ref, release_family, synthetic)
         VALUES ('northwind-synthetic', 'analytics.forged', 1, 'active', 'forged',
                 ARRAY['forged'], ARRAY['forged'], 1, ARRAY['cohort'], 2, 'none',
                 'forged', '{}'::jsonb, true)`,
      ),
    ).toBe('42501');
    expect(
      await boundError(
        northwind,
        "UPDATE analytics.projection_cell SET measure_value = 99 WHERE version_ref = 'projection-seed-0001'",
      ),
    ).toBe('42501');
    expect(
      await boundError(
        northwind,
        "DELETE FROM analytics.metric_definition WHERE metric_id = 'analytics.synthetic.completed-visits'",
      ),
    ).toBe('42501');
  });

  it('rejects genetic and PHI-restricted facts structurally', async () => {
    await owner.query('BEGIN');
    try {
      await expect(
        owner.query(
          `INSERT INTO analytics.projection_event
             (tenant_id, event_id, legal_entity_id, event_type, metric_id,
              metric_version, occurred_at, recorded_at, source_ref, source_offset,
              source_receipt_ref, supersedes_event_id, reversal_of_event_id,
              cell_id, measure_value, data_classification, partition_tags,
              work_item_refs, fact_hash, synthetic)
           VALUES ('northwind-synthetic', 'ana-db-genetic',
                   'northwind-legal-entity-synthetic', 'synthetic.metric-observed',
                   'analytics.synthetic.completed-visits', 1,
                   '2026-03-10T12:00:00Z', '2026-03-10T12:00:00Z', 'source-a', '11',
                   'receipt:source-a:0011', NULL, NULL, 'a', 1, 'PHI-restricted',
                   ARRAY['gipa-genetic'], ARRAY[]::text[], repeat('a', 64), true)`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('binds accepted facts to the real WP-021 inbox dedup transaction', async () => {
    const baseFact = makeFacts({ a: 1, b: 0 })[0];
    if (baseFact === undefined) throw new Error('expected source fact');
    const sourceFact: AnalyticsFact = {
      ...baseFact,
      eventId: '01HZZZZZZZZZZZZZZZZZZZZZZZ' as EventId,
      sourceOffset: '999999',
      workItemRefs: ['work-item:source-inbox'],
    };
    const envelope = makeEnvelope(sourceFact);
    const consumer = createAnalyticsDrainConsumer(makeMetricDefinition(), {
      map: () => sourceFact,
    });
    const sideEffect = consumer.sideEffect;
    if (sideEffect === undefined) throw new Error('analytics consumer requires a side effect');
    await app.query('BEGIN');
    await app.query(tenantBindingSql(northwind));
    await enqueueEnvelope(app, envelope);
    await app.query('COMMIT');
    await app.query('BEGIN');
    try {
      await app.query(tenantBindingSql(northwind));
      const claimed = { envelope, delivery: { status: 'pending' as const, attempts: 0 } };
      const common = {
        claimed,
        consumer: consumer.consumer,
        capabilityAllowed: true,
        seen: new Set<string>(),
        retryPolicy: { maxAttempts: 3 },
        sideEffect,
      };
      expect((await deliverClaimedEvent(app, common)).effected).toBe(true);
      expect((await deliverClaimedEvent(app, common)).effected).toBe(false);
      const counts = await app.query<{ facts: string; inbox: string }>(
        `SELECT
           (SELECT count(*)::text FROM analytics.projection_event
             WHERE event_id = '01HZZZZZZZZZZZZZZZZZZZZZZZ') AS facts,
           (SELECT count(*)::text FROM events.inbox
             WHERE event_id = '01HZZZZZZZZZZZZZZZZZZZZZZZ'
               AND consumer = $1) AS inbox`,
        [consumer.consumer],
      );
      expect(counts.rows).toEqual([{ facts: '1', inbox: '1' }]);
      await app.query('COMMIT');
    } catch (error) {
      await app.query('ROLLBACK');
      throw error;
    }
  });

  it('opens real WP-022 WorkItems for every EX1 data-quality category', async () => {
    const reasons: readonly DataQualityReason[] = [
      'cross-entity-access',
      'small-cell-or-differencing',
      'unresolved-identity-join',
      'missing-source-receipt',
    ];
    await app.query('BEGIN');
    try {
      // The transaction is bound to the projection/resource tenant. The
      // cross-entity caller id is untrusted query input, never the DB binding.
      await app.query(tenantBindingSql(northwind));
      const workItems = createWp022DataQualityPort(app);
      const disclosures = createPostgresDisclosureHistory(app);
      for (const [index, reason] of reasons.entries()) {
        const projection =
          reason === 'small-cell-or-differencing'
            ? makeProjection({ a: 5, b: 3 })
            : reason === 'missing-source-receipt'
              ? makeProjection({ sourceReceiptRef: '' })
              : makeProjection();
        const base: AnalyticsQueryInput = {
          definition: makeMetricDefinition(),
          projection,
          tenantId: projection.tenantId,
          ...(projection.legalEntityId === undefined
            ? {}
            : { legalEntityId: projection.legalEntityId }),
          actorRef: `user:db-${index + 1}`,
          purpose: 'operations',
          nodeId: 'total',
          surface: 'view',
          identityResolved: true,
          segments: ['administrative'],
          occurredAt: '2026-03-10T12:00:00Z',
          disclosureId: `ana-db-disclosure-${index + 1}`,
          qualityTaskIds: qualityTaskIds(`ana-db-${index + 1}`),
        };
        const input: AnalyticsQueryInput =
          reason === 'cross-entity-access'
            ? { ...base, tenantId: 'riverbend-synthetic' }
            : reason === 'unresolved-identity-join'
              ? { ...base, identityResolved: false }
              : base;
        const doubles = makeFixturePorts();
        const decision = await queryAnalytics(input, {
          access: doubles.access,
          workItems,
          disclosures,
          audit: doubles.audit,
        });
        expect(['masked', 'suppressed', 'stale']).toContain(decision.kind);
      }
      const rows = await app.query<{ work_item_id: string; purpose: string }>(
        `SELECT work_item_id, purpose FROM events.work_item
          WHERE work_item_id LIKE 'ana-db-%' ORDER BY work_item_id`,
      );
      expect(rows.rows.map((row) => row.purpose)).toEqual(
        reasons.map((reason) => `analytics-data-quality:${reason}`),
      );
      await app.query('COMMIT');
    } catch (error) {
      await app.query('ROLLBACK');
      throw error;
    }
  });

  it('cannot route a Northwind quality task through a Riverbend-bound session', async () => {
    await app.query('BEGIN');
    try {
      await app.query(tenantBindingSql('riverbend-synthetic'));
      await expect(
        createWp022DataQualityPort(app).createDataQualityWorkItem({
          tenantId: northwind as TenantId,
          reason: 'cross-entity-access',
          subjectRef: 'analytics:dataset:visits:cohort:all',
          openedAt: '2026-03-10T12:00:00Z',
          workItemId: 'ana-db-wrong-binding',
          synthetic: true,
        }),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('persists a version, atomic disclosure, and export receipt in one transaction', async () => {
    await app.query('BEGIN');
    try {
      await app.query(tenantBindingSql(northwind));
      const projection = makeProjection({ versionRef: 'ana-db-projection' });
      await createPostgresProjectionStore(app).save(projection);
      const doubles = makeFixturePorts();
      const decision = await queryAnalytics(
        {
          definition: makeMetricDefinition(),
          projection,
          tenantId: projection.tenantId,
          ...(projection.legalEntityId === undefined
            ? {}
            : { legalEntityId: projection.legalEntityId }),
          actorRef: 'user:db-export',
          purpose: 'operations',
          nodeId: 'total',
          surface: 'export',
          identityResolved: true,
          segments: ['administrative'],
          occurredAt: '2026-03-10T12:00:00Z',
          disclosureId: 'ana-db-disclosure-export',
          qualityTaskIds: qualityTaskIds('ana-db-export'),
        },
        {
          access: doubles.access,
          workItems: createWp022DataQualityPort(app),
          disclosures: createPostgresDisclosureHistory(app),
          audit: doubles.audit,
        },
      );
      expect(decision.kind).toBe('available');
      await createPostgresExportReceiptStore(app).record({
        tenantId: projection.tenantId,
        exportReceiptId: 'ana-db-export-receipt',
        disclosureId: 'ana-db-disclosure-export',
        artifactRef: 'artifact:analytics-export',
        contentHash: 'b'.repeat(64),
        exportedAt: '2026-03-10T12:00:01Z',
        synthetic: true,
      });
      const counts = await app.query<{ disclosures: string; receipts: string }>(
        `SELECT
           (SELECT count(*)::text FROM analytics.projection_disclosure
             WHERE disclosure_id = 'ana-db-disclosure-export') AS disclosures,
           (SELECT count(*)::text FROM analytics.projection_export_receipt
             WHERE export_receipt_id = 'ana-db-export-receipt') AS receipts`,
      );
      expect(counts.rows).toEqual([{ disclosures: '1', receipts: '1' }]);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('serializes two-client cross-version disclosure and survives reconnect', async () => {
    const second = new Client(appConfig);
    await second.connect();
    const firstProjection = projectionIdentity(makeProjection(), 'ana-db-race-v1', 'cohort:race');
    const secondProjection = projectionIdentity(
      makeProjection({ a: 6, b: 5 }),
      'ana-db-race-v2',
      'cohort:race',
    );
    try {
      await app.query('BEGIN');
      await app.query(tenantBindingSql(northwind));
      await createPostgresProjectionStore(app).save(firstProjection);
      await createPostgresProjectionStore(app).save(secondProjection);
      await app.query('COMMIT');

      const queryFor = (
        client: Client,
        projection: ProjectionVersion,
        suffix: string,
      ): Promise<Awaited<ReturnType<typeof queryAnalytics>>> => {
        const doubles = makeFixturePorts();
        return queryAnalytics(
          {
            definition: makeMetricDefinition(),
            projection,
            tenantId: projection.tenantId,
            ...(projection.legalEntityId === undefined
              ? {}
              : { legalEntityId: projection.legalEntityId }),
            actorRef: `user:${suffix}`,
            purpose: 'operations',
            nodeId: 'total',
            surface: suffix === 'first' ? 'view' : 'export',
            identityResolved: true,
            segments: ['administrative'],
            occurredAt: '2026-03-10T12:00:00Z',
            disclosureId: `ana-db-race-${suffix}`,
            qualityTaskIds: qualityTaskIds(`ana-db-race-${suffix}`),
          },
          {
            access: doubles.access,
            workItems: createWp022DataQualityPort(client),
            disclosures: createPostgresDisclosureHistory(client),
            audit: doubles.audit,
          },
        );
      };

      await app.query('BEGIN');
      await app.query(tenantBindingSql(northwind));
      await second.query('BEGIN');
      await second.query(tenantBindingSql(northwind));
      const firstDecision = await queryFor(app, firstProjection, 'first');
      const blocked = queryFor(second, secondProjection, 'second');
      await new Promise<void>((resolve) => setImmediate(resolve));
      await app.query('COMMIT');
      const secondDecision = await blocked;
      await second.query('COMMIT');
      expect([firstDecision.kind, secondDecision.kind].sort()).toEqual(['available', 'suppressed']);

      const reconnected = new Client(appConfig);
      await reconnected.connect();
      await reconnected.query('BEGIN');
      await reconnected.query(tenantBindingSql(northwind));
      const persisted = await reconnected.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM analytics.projection_disclosure
          WHERE cohort_ref = 'cohort:race'`,
      );
      expect(persisted.rows).toEqual([{ count: '1' }]);
      await reconnected.query('ROLLBACK');
      await reconnected.end();
    } finally {
      await second.query('ROLLBACK').catch(() => undefined);
      await second.end().catch(() => undefined);
    }
  });

  it('rolls back projection and disclosure together on caller transaction failure', async () => {
    const projection = projectionIdentity(
      makeProjection(),
      'ana-db-rollback-v1',
      'cohort:rollback',
    );
    await app.query('BEGIN');
    await app.query(tenantBindingSql(northwind));
    await createPostgresProjectionStore(app).save(projection);
    const doubles = makeFixturePorts();
    const decision = await queryAnalytics(
      {
        definition: makeMetricDefinition(),
        projection,
        tenantId: projection.tenantId,
        ...(projection.legalEntityId === undefined
          ? {}
          : { legalEntityId: projection.legalEntityId }),
        actorRef: 'user:rollback',
        purpose: 'operations',
        nodeId: 'total',
        surface: 'view',
        identityResolved: true,
        segments: ['administrative'],
        occurredAt: '2026-03-10T12:00:00Z',
        disclosureId: 'ana-db-rollback-disclosure',
        qualityTaskIds: qualityTaskIds('ana-db-rollback'),
      },
      {
        access: doubles.access,
        workItems: createWp022DataQualityPort(app),
        disclosures: createPostgresDisclosureHistory(app),
        audit: doubles.audit,
      },
    );
    expect(decision.kind).toBe('available');
    await app.query('ROLLBACK');
    const rows = await boundQuery<{ versions: string; disclosures: string }>(
      northwind,
      `SELECT
         (SELECT count(*)::text FROM analytics.projection_version
           WHERE version_ref = 'ana-db-rollback-v1') AS versions,
         (SELECT count(*)::text FROM analytics.projection_disclosure
           WHERE disclosure_id = 'ana-db-rollback-disclosure') AS disclosures`,
    );
    expect(rows).toEqual([{ versions: '0', disclosures: '0' }]);
  });
});
