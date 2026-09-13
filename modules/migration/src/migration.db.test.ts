/**
 * Serialized DB proof for the WP-110 effect-free staging increment. The suite
 * applies M27 and seed 028 itself against the local synthetic PostgreSQL stack.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { evaluateFailureThreshold } from './validation.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const host = process.env['PRACTICEHUB_DB_HOST'] ?? '127.0.0.1';
const port = Number(process.env['PRACTICEHUB_DB_PORT'] ?? '55432');
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
const baseFiles = [
  'infra/postgres/init/001-bootstrap.sql',
  'modules/platform-core/migrations/0001-tenancy.sql',
  'modules/platform-core/migrations/0003-capability.sql',
  'modules/identity/migrations/0004-identity.sql',
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/005-capability-seed.sql',
  'infra/postgres/seed/006-identity-seed.sql',
];
const migrationFile = 'modules/migration/migrations/0027-migration.sql';
const rollbackFile = 'modules/migration/migrations/0027-migration.rollback.sql';
const seedFile = 'infra/postgres/seed/028-migration-seed.sql';
const northwind = 'northwind-synthetic';

let owner: Client;
let app: Client;
let externalCounts: Record<string, number>;

function sql(file: string): string {
  return readFileSync(`${repoRoot}${file}`, 'utf8');
}

async function boundQuery<T extends Record<string, unknown>>(
  tenantId: string,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  await app.query('BEGIN');
  try {
    await app.query("SELECT set_config('practicehub.tenant_id', $1, true)", [tenantId]);
    const result = await app.query(text, [...params]);
    await app.query('COMMIT');
    return result.rows as T[];
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

async function snapshotExternalCounts(): Promise<Record<string, number>> {
  const result = await owner.query<{ schema_name: string; table_name: string }>(
    `SELECT schemaname AS schema_name, tablename AS table_name
       FROM pg_tables
      WHERE schemaname NOT IN ('migration', 'information_schema')
        AND schemaname NOT LIKE 'pg_%'
      ORDER BY schemaname, tablename`,
  );
  const counts: Record<string, number> = {};
  for (const row of result.rows) {
    const key = `${row.schema_name}.${row.table_name}`;
    const count = await owner.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${key}`);
    counts[key] = count.rows[0]?.count ?? -1;
  }
  return counts;
}

async function applyWorkbench(): Promise<void> {
  await owner.query(sql(migrationFile));
  await owner.query(sql(seedFile));
}

async function insertClonedRun(
  runRef: string,
  inScopeRecordCount: number,
  comparison: Readonly<Record<string, unknown>>,
): Promise<void> {
  await boundQuery(
    northwind,
    `INSERT INTO migration.validation_run
       (tenant_id, run_ref, predecessor_run_ref, source_manifest_ref, mapping_version_ref,
        source_manifest_hash, mapping_version_hash, failed_record_count, in_scope_record_count,
        threshold_basis_points, previously_threshold_blocked, threshold_state, readiness,
        blocker_codes, code_version_ref, config_version_ref, sample_evidence_refs,
        runtime_milliseconds, signoff_refs, proposed_write_set_hash, comparison_json,
        failed_record_count_change, target_data_writes, synthetic)
     SELECT tenant_id, $1, NULL, source_manifest_ref, mapping_version_ref,
            source_manifest_hash, mapping_version_hash, failed_record_count, $2,
            threshold_basis_points, false, threshold_state, readiness, blocker_codes,
            code_version_ref, config_version_ref, sample_evidence_refs, runtime_milliseconds,
            signoff_refs, proposed_write_set_hash, $3::jsonb, NULL, 0, true
       FROM migration.validation_run
      WHERE tenant_id = $4 AND run_ref = 'run:synthetic-v1'`,
    [runRef, inScopeRecordCount, JSON.stringify(comparison), northwind],
  );
}

beforeAll(async () => {
  owner = new Client(ownerConfig);
  await owner.connect();
  for (const file of baseFiles) {
    await owner.query(sql(file));
  }
  externalCounts = await snapshotExternalCounts();
  await applyWorkbench();
  app = new Client(appConfig);
  await app.connect();
}, 60000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
});

describe('migration staging persistence is effect-free and tenant-bound', () => {
  it('applies only the seven forced-RLS migration tables and leaves protected domains unchanged', async () => {
    const tables = await owner.query<{
      table_name: string;
      rowsecurity: boolean;
      forcerowsecurity: boolean;
    }>(
      `SELECT c.relname AS table_name, c.relrowsecurity AS rowsecurity,
              c.relforcerowsecurity AS forcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'migration' AND c.relkind = 'r'
        ORDER BY c.relname`,
    );
    expect(tables.rows).toHaveLength(7);
    expect(tables.rows.every((row) => row.rowsecurity && row.forcerowsecurity)).toBe(true);
    expect(await snapshotExternalCounts()).toEqual(externalCounts);
    const grants = await owner.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM platform_core.capability_grant
        WHERE capability_id IN ('migration.workbench', 'migration.wave-import')`,
    );
    expect(grants.rows[0]?.count).toBe(0);
  });

  it('fails closed when unbound and denies a Northwind session a Riverbend staging write', async () => {
    const unbound = await app.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM migration.validation_run',
    );
    expect(unbound.rows[0]?.count).toBe(0);
    await expect(
      boundQuery(
        northwind,
        `INSERT INTO migration.source_manifest
           (tenant_id, source_manifest_ref, source_system_ref, source_manifest_hash,
            structurally_readable, in_scope_record_count, source_fields, artifact_refs, synthetic)
         VALUES ('riverbend-synthetic', 'manifest:forged', 'legacy-forged', $1,
                 true, 1, ARRAY['patient-id'], ARRAY['artifact:forged'], true)`,
        ['e'.repeat(64)],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('persists exact blocked, held-at-equality and below-threshold release semantics', async () => {
    const vectors = [
      { run: 'run:db-blocked', failed: 11, previous: false, predecessor: null },
      { run: 'run:db-held', failed: 10, previous: true, predecessor: 'run:db-blocked' },
      { run: 'run:db-released', failed: 9, previous: true, predecessor: 'run:db-held' },
    ] as const;
    await owner.query('BEGIN');
    try {
      for (const vector of vectors) {
        const decision = evaluateFailureThreshold({
          failedRecordCount: vector.failed,
          inScopeRecordCount: 200,
          thresholdBasisPoints: 500,
          previouslyThresholdBlocked: vector.previous,
        });
        await owner.query(
          `INSERT INTO migration.validation_run
             (tenant_id, run_ref, predecessor_run_ref, source_manifest_ref, mapping_version_ref,
              failed_record_count, in_scope_record_count, threshold_basis_points,
              previously_threshold_blocked, threshold_state, readiness, blocker_codes,
              code_version_ref, config_version_ref, sample_evidence_refs, runtime_milliseconds,
              signoff_refs, proposed_write_set_hash, source_manifest_hash, mapping_version_hash,
              comparison_json, failed_record_count_change, target_data_writes, synthetic)
           VALUES ($1, $2, $3, 'manifest:synthetic-v1', 'mapping:synthetic-v1',
                   $4, 200, 500, $5, $6, $7, $8, 'code:db-proof', 'config:db-proof',
                   ARRAY['sample:db-proof'], 1, ARRAY['signoff:db-proof'], $9, $10, $11,
                   $12::jsonb, $13, 0, true)
           ON CONFLICT (tenant_id, run_ref) DO UPDATE SET
             predecessor_run_ref = EXCLUDED.predecessor_run_ref,
             failed_record_count = EXCLUDED.failed_record_count,
             previously_threshold_blocked = EXCLUDED.previously_threshold_blocked,
             threshold_state = EXCLUDED.threshold_state,
             readiness = EXCLUDED.readiness,
             blocker_codes = EXCLUDED.blocker_codes`,
          [
            northwind,
            vector.run,
            vector.predecessor,
            vector.failed,
            vector.previous,
            decision.state,
            decision.state === 'clear' ? 'ready-for-review' : 'blocked',
            decision.state === 'clear' ? [] : [`threshold:${decision.state}`],
            'f'.repeat(64),
            'a'.repeat(64),
            'b'.repeat(64),
            JSON.stringify({
              sourceRecordCount: 200,
              candidateRecordCount: 200 - vector.failed,
              keyFieldCompleteness: {},
              identityMatchResults: { matched: 200, candidate: 0, ambiguous: 0, unmatched: 0 },
              outcomeCounts: {
                created: 200 - vector.failed,
                updated: 0,
                merged: 0,
                flagged: vector.failed,
              },
            }),
            vector.predecessor === null ? null : vector.run === 'run:db-held' ? -1 : -1,
          ],
        );
      }
      const rows = await owner.query<{ run_ref: string; threshold_state: string }>(
        `SELECT run_ref, threshold_state FROM migration.validation_run
          WHERE tenant_id = $1 AND run_ref LIKE 'run:db-%' ORDER BY run_ref`,
        [northwind],
      );
      expect(
        Object.fromEntries(rows.rows.map((row) => [row.run_ref, row.threshold_state])),
      ).toEqual({
        'run:db-blocked': 'blocked',
        'run:db-held': 'held-until-below',
        'run:db-released': 'clear',
      });
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('rejects persisted threshold state that contradicts the predecessor-bound rule', async () => {
    await expect(
      owner.query(
        `UPDATE migration.validation_run
            SET threshold_state = 'blocked', readiness = 'blocked'
          WHERE tenant_id = $1 AND run_ref = 'run:synthetic-v1'`,
        [northwind],
      ),
    ).rejects.toThrow(/exact predecessor-bound rule/);
  });

  it('rejects evidence hashes and comparison counts that contradict immutable inputs', async () => {
    await expect(
      owner.query(
        `UPDATE migration.validation_run
            SET source_manifest_hash = $2
          WHERE tenant_id = $1 AND run_ref = 'run:synthetic-v1'`,
        [northwind, '0'.repeat(64)],
      ),
    ).rejects.toThrow(/hashes do not match/);
    await expect(
      owner.query(
        `UPDATE migration.validation_run
            SET comparison_json = jsonb_set(comparison_json, '{sourceRecordCount}', '199')
          WHERE tenant_id = $1 AND run_ref = 'run:synthetic-v1'`,
        [northwind],
      ),
    ).rejects.toThrow(/comparison does not match/);
  });

  it('rejects malformed nested comparison evidence and an inflated persisted denominator', async () => {
    await expect(
      insertClonedRun('run:db-missing-identity', 200, {
        sourceRecordCount: 200,
        candidateRecordCount: 200,
        keyFieldCompleteness: {},
        identityMatchResults: {},
        outcomeCounts: { created: 200, updated: 0, merged: 0, flagged: 0 },
      }),
    ).rejects.toThrow(/comparison does not match/);
    await expect(
      insertClonedRun('run:db-inflated-population', 400, {
        sourceRecordCount: 400,
        candidateRecordCount: 400,
        keyFieldCompleteness: {},
        identityMatchResults: { matched: 400, candidate: 0, ambiguous: 0, unmatched: 0 },
        outcomeCounts: { created: 400, updated: 0, merged: 0, flagged: 0 },
      }),
    ).rejects.toThrow(/hashes do not match/);
    await expect(
      insertClonedRun('run:db-string-completeness', 200, {
        sourceRecordCount: 200,
        candidateRecordCount: 200,
        keyFieldCompleteness: {
          'patient-id': { sourceCompleteCount: '200', candidateCompleteCount: 200 },
        },
        identityMatchResults: { matched: 200, candidate: 0, ambiguous: 0, unmatched: 0 },
        outcomeCounts: { created: 200, updated: 0, merged: 0, flagged: 0 },
      }),
    ).rejects.toThrow(/key-field completeness/);
  });

  it('enforces persisted semantic-total uniqueness through the app role', async () => {
    await expect(
      boundQuery(
        northwind,
        `INSERT INTO migration.control_total
           (tenant_id, run_ref, total_ref, side, name, value_minor, unit, checksum,
            reconciliation_state, synthetic)
         SELECT tenant_id, run_ref, 'total:duplicate-source-records', side, name,
                value_minor, unit, checksum, reconciliation_state, true
           FROM migration.control_total
          WHERE tenant_id = $1 AND run_ref = 'run:synthetic-v1'
            AND total_ref = 'total:source-records'`,
        [northwind],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('keeps an advanced review projection intact when seed 028 is replayed', async () => {
    await owner.query(
      `INSERT INTO migration.batch_event
         (tenant_id, batch_ref, version, event_ref, event_type, run_ref, work_item_ref,
          evidence_hash, occurred_at, synthetic)
       VALUES ($1, 'batch:synthetic-v1', 3, 'event:migration-batch-v1-review',
               'review-workitem-linked', 'run:synthetic-v1', 'workitem:go-no-go-v1',
               $2, '2026-01-01T00:01:00Z', true)
       ON CONFLICT DO NOTHING`,
      [northwind, '3'.repeat(64)],
    );
    await owner.query(
      `UPDATE migration.batch_state
          SET version = 3, review_work_item_ref = 'workitem:go-no-go-v1'
        WHERE tenant_id = $1 AND batch_ref = 'batch:synthetic-v1'`,
      [northwind],
    );
    await owner.query(sql(seedFile));
    const projection = await owner.query<{ version: number; review_work_item_ref: string }>(
      `SELECT version, review_work_item_ref FROM migration.batch_state
        WHERE tenant_id = $1 AND batch_ref = 'batch:synthetic-v1'`,
      [northwind],
    );
    expect(projection.rows[0]).toEqual({
      version: 3,
      review_work_item_ref: 'workitem:go-no-go-v1',
    });
  });

  it('re-applies idempotently; rollback removes only staging and a clean re-apply restores it', async () => {
    await applyWorkbench();
    expect(await snapshotExternalCounts()).toEqual(externalCounts);
    await owner.query(sql(rollbackFile));
    const absent = await owner.query<{ present: boolean }>(
      "SELECT to_regnamespace('migration') IS NOT NULL AS present",
    );
    expect(absent.rows[0]?.present).toBe(false);
    expect(await snapshotExternalCounts()).toEqual(externalCounts);
    await applyWorkbench();
    const restored = await owner.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM migration.validation_run',
    );
    expect(restored.rows[0]?.count).toBeGreaterThan(0);
  });
});
