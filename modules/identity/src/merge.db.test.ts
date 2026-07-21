/**
 * DB-level merge-governance suite (WP-016 verification gate). Cross-tenant
 * negatives on the merge tables, the append-only event/lineage postures (and
 * their survival across a 0004 re-apply — the conditional re-REVOKE proof),
 * the merge-basis floor mirrored in CHECK, case-resolution structural rules,
 * and the seeded alias-preservation proof. Requires the app-postgres from
 * compose.yaml (or the CI service container) on 127.0.0.1:55432.
 *
 * Every INSERT this suite attempts is a NEGATIVE (it must fail) — the suite
 * never mutates the seeded state the local:test probes assert.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mergeRlsSpecs } from './rls-specs.js';

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

const provisioningFiles = [
  'infra/postgres/init/001-bootstrap.sql',
  'modules/platform-core/migrations/0001-tenancy.sql',
  'modules/identity/migrations/0004-identity.sql',
  'modules/identity/migrations/0006-merge.sql',
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/006-identity-seed.sql',
  'infra/postgres/seed/008-merge-seed.sql',
];

const mergeTables = mergeRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`);

let owner: Client;
let app: Client;

async function boundQuery<T extends Record<string, unknown>>(
  tenantId: string,
  sql: string,
): Promise<{ rows: T[] }> {
  await app.query('BEGIN');
  try {
    await app.query(tenantBindingSql(tenantId));
    const result = await app.query(sql);
    await app.query('COMMIT');
    return { rows: result.rows as T[] };
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

async function boundQueryError(tenantId: string, sql: string): Promise<string> {
  try {
    await boundQuery(tenantId, sql);
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  throw new Error(`expected ${sql} to be rejected`);
}

beforeAll(async () => {
  owner = new Client(ownerConfig);
  await owner.connect();
  for (const file of provisioningFiles) {
    await owner.query(readFileSync(`${repoRoot}${file}`, 'utf8'));
  }
  app = new Client(appConfig);
  await app.connect();
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
});

describe('merge-governance DB suite (WP-016)', () => {
  it('MG-01 positive control: a Northwind-bound session reads Northwind rows in every merge table', async () => {
    for (const table of mergeTables) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(Number(rows[0]?.count), `${table} should show Northwind rows`).toBeGreaterThan(0);
    }
  });

  it('MG-02: cross-tenant reads come back empty in both directions', async () => {
    const fromNorthwind = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS count FROM identity.merge_case WHERE tenant_id = 'riverbend-synthetic'`,
    );
    expect(fromNorthwind.rows[0]?.count).toBe('0');
    const fromRiverbend = await boundQuery<{ count: string }>(
      'riverbend-synthetic',
      `SELECT count(*)::text AS count FROM identity.merge_event`,
    );
    expect(fromRiverbend.rows[0]?.count).toBe('0');
  });

  it('MG-03: a Northwind-bound INSERT carrying the Riverbend tenant is rejected by policy', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.merge_case
           (tenant_id, case_id, kind, status, matched_attributes, confidence,
            opened_by, source, synthetic)
         VALUES ('riverbend-synthetic', 'rmc-forged', 'possible-match', 'open',
                 '{given-name,birth-date}', 'low', 'synthetic-forge', 'synthetic-forge', true)`,
      ),
    ).toBe('42501');
  });

  it('MG-04: events and lineage are append-only; cases never delete', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE identity.merge_event SET rationale = 'rewritten' WHERE event_id = 'nme-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM identity.merge_event WHERE event_id = 'nme-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE identity.merge_lineage SET to_person_id = 'np-jordan-kim' WHERE lineage_id = 'nml-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM identity.merge_lineage WHERE lineage_id = 'nml-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM identity.merge_case WHERE case_id = 'nmc-0002'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM identity.merge_case_person WHERE case_id = 'nmc-0002'`,
      ),
    ).toBe('42501');
  });

  it('MG-05: a merge event below the authorization-basis floor is unrepresentable', async () => {
    // Endpoint-only basis — REQ-ID-017 exception mirrored in CHECK.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.merge_event
           (tenant_id, event_id, case_id, kind, survivor_person_id, merged_person_id,
            basis_attributes, decided_by, rationale, evidence_ref, synthetic)
         VALUES ('northwind-synthetic', 'nme-forged-1', 'nmc-0002', 'merge',
                 'np-jordan-kim', 'np-alex-rivera', '{phone,email,postal-address}',
                 'synthetic-forge', 'endpoint-only forgery', 'synthetic-evidence', true)`,
      ),
    ).toBe('23514');
    // Single compared attribute.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.merge_event
           (tenant_id, event_id, case_id, kind, survivor_person_id, merged_person_id,
            basis_attributes, decided_by, rationale, evidence_ref, synthetic)
         VALUES ('northwind-synthetic', 'nme-forged-2', 'nmc-0002', 'merge',
                 'np-jordan-kim', 'np-alex-rivera', '{given-name}',
                 'synthetic-forge', 'single-attribute forgery', 'synthetic-evidence', true)`,
      ),
    ).toBe('23514');
    // A merge without evidence, and a self-merge, are equally unrepresentable.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.merge_event
           (tenant_id, event_id, case_id, kind, survivor_person_id, merged_person_id,
            basis_attributes, decided_by, rationale, synthetic)
         VALUES ('northwind-synthetic', 'nme-forged-3', 'nmc-0002', 'merge',
                 'np-jordan-kim', 'np-alex-rivera', '{given-name,birth-date}',
                 'synthetic-forge', 'unevidenced forgery', true)`,
      ),
    ).toBe('23514');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.merge_event
           (tenant_id, event_id, case_id, kind, survivor_person_id, merged_person_id,
            basis_attributes, decided_by, rationale, evidence_ref, synthetic)
         VALUES ('northwind-synthetic', 'nme-forged-4', 'nmc-0002', 'merge',
                 'np-jordan-kim', 'np-jordan-kim', '{given-name,birth-date}',
                 'synthetic-forge', 'self-merge forgery', 'synthetic-evidence', true)`,
      ),
    ).toBe('23514');
  });

  it('MG-06: an unmerge names what it reverses; a merge reverses nothing', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.merge_event
           (tenant_id, event_id, case_id, kind, survivor_person_id, merged_person_id,
            decided_by, rationale, synthetic)
         VALUES ('northwind-synthetic', 'nme-forged-5', 'nmc-0001', 'unmerge',
                 'np-sam-porter', 'np-sam-porter-legacy',
                 'synthetic-forge', 'reversal without target', true)`,
      ),
    ).toBe('23514');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.merge_event
           (tenant_id, event_id, case_id, kind, survivor_person_id, merged_person_id,
            basis_attributes, decided_by, rationale, evidence_ref, reverses_event_id, synthetic)
         VALUES ('northwind-synthetic', 'nme-forged-6', 'nmc-0002', 'merge',
                 'np-jordan-kim', 'np-alex-rivera', '{given-name,birth-date}',
                 'synthetic-forge', 'merge posing as reversal', 'synthetic-evidence',
                 'nme-0001', true)`,
      ),
    ).toBe('23514');
  });

  it('MG-07: case resolutions are structurally governed by CHECK', async () => {
    // Resolved without attribution.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.merge_case
           (tenant_id, case_id, kind, status, matched_attributes, confidence,
            opened_by, source, resolved_kind, synthetic)
         VALUES ('northwind-synthetic', 'nmc-forged-1', 'possible-match', 'dismissed',
                 '{given-name,birth-date}', 'low', 'synthetic-forge', 'synthetic-forge',
                 'dismissed', true)`,
      ),
    ).toBe('23514');
    // Merged without its merge event.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.merge_case
           (tenant_id, case_id, kind, status, matched_attributes, confidence,
            opened_by, source, resolved_kind, resolved_by, resolved_reason,
            resolution_evidence_ref, synthetic)
         VALUES ('northwind-synthetic', 'nmc-forged-2', 'possible-match', 'resolved-merged',
                 '{given-name,birth-date}', 'high', 'synthetic-forge', 'synthetic-forge',
                 'merged', 'synthetic-forge', 'case edit posing as merge',
                 'synthetic-evidence', true)`,
      ),
    ).toBe('23514');
    // Linked without evidence.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.merge_case
           (tenant_id, case_id, kind, status, matched_attributes, confidence,
            opened_by, source, resolved_kind, resolved_by, resolved_reason, synthetic)
         VALUES ('northwind-synthetic', 'nmc-forged-3', 'possible-match', 'resolved-linked',
                 '{given-name,birth-date}', 'high', 'synthetic-forge', 'synthetic-forge',
                 'linked', 'synthetic-forge', 'unevidenced link', true)`,
      ),
    ).toBe('23514');
    // Specialized patterns resolved toward link without the checks reference.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.merge_case
           (tenant_id, case_id, kind, status, matched_attributes, confidence,
            specialized_patterns, opened_by, source, resolved_kind, resolved_by,
            resolved_reason, resolution_evidence_ref, synthetic)
         VALUES ('northwind-synthetic', 'nmc-forged-4', 'possible-match', 'resolved-linked',
                 '{given-name,birth-date}', 'high', '{minor-or-proxy}',
                 'synthetic-forge', 'synthetic-forge', 'linked', 'synthetic-forge',
                 'specialized checks skipped', 'synthetic-evidence', true)`,
      ),
    ).toBe('23514');
    // Status/resolution mismatch.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.merge_case
           (tenant_id, case_id, kind, status, matched_attributes, confidence,
            opened_by, source, resolved_kind, resolved_by, resolved_reason, synthetic)
         VALUES ('northwind-synthetic', 'nmc-forged-5', 'possible-match', 'open',
                 '{given-name,birth-date}', 'low', 'synthetic-forge', 'synthetic-forge',
                 'dismissed', 'synthetic-forge', 'open but resolved', true)`,
      ),
    ).toBe('23514');
  });

  it('MG-08: lineage direction matches disposition, and artifact kinds are a closed vocabulary', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.merge_lineage
           (tenant_id, lineage_id, event_id, artifact_kind, artifact_ref,
            from_person_id, to_person_id, disposition, synthetic)
         VALUES ('northwind-synthetic', 'nml-forged-1', 'nme-0001', 'source-identifier',
                 'x', 'np-sam-porter', 'np-sam-porter', 're-attributed', true)`,
      ),
    ).toBe('23514');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.merge_lineage
           (tenant_id, lineage_id, event_id, artifact_kind, artifact_ref,
            from_person_id, to_person_id, disposition, synthetic)
         VALUES ('northwind-synthetic', 'nml-forged-2', 'nme-0001', 'implant-registry',
                 'x', 'np-sam-porter-legacy', 'np-sam-porter', 're-attributed', true)`,
      ),
    ).toBe('23514');
  });

  it('MG-09: cross-tenant composite FK is unrepresentable on merge events', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.merge_event
           (tenant_id, event_id, case_id, kind, survivor_person_id, merged_person_id,
            basis_attributes, decided_by, rationale, evidence_ref, synthetic)
         VALUES ('northwind-synthetic', 'nme-forged-7', 'nmc-0002', 'merge',
                 'rb-taylor-quinn', 'np-alex-rivera', '{given-name,birth-date}',
                 'synthetic-forge', 'cross-tenant forgery', 'synthetic-evidence', true)`,
      ),
    ).toBe('23503');
  });

  it('MG-10: the seeded alias-preservation proof — the legacy id resolves to the survivor with lineage', async () => {
    const { rows } = await boundQuery<{ person_id: string; lineage: string }>(
      'northwind-synthetic',
      `SELECT s.person_id,
              (SELECT count(*)::text FROM identity.merge_lineage l
                WHERE l.artifact_kind = 'source-identifier'
                  AND l.artifact_ref = 'legacy-lakeside:lg-000778'
                  AND l.disposition = 're-attributed') AS lineage
         FROM identity.source_identifier s
        WHERE s.source_system = 'legacy-lakeside' AND s.source_value = 'lg-000778'`,
    );
    expect(rows[0]?.person_id).toBe('np-sam-porter');
    expect(rows[0]?.lineage).toBe('1');
  });

  it('MG-11: every seeded merge row carries the synthetic watermark', async () => {
    for (const table of mergeTables) {
      const result = await owner.query(
        `SELECT count(*)::text AS count FROM ${table} WHERE synthetic IS DISTINCT FROM true`,
      );
      expect(result.rows[0]?.count, `${table} must be fully watermarked`).toBe('0');
    }
  });

  it('MG-12: append-only postures SURVIVE a 0004 re-apply — the conditional re-REVOKE bites', async () => {
    // 0006 re-applies cleanly, then 0004 re-applies AFTER it: 0004's
    // schema-wide GRANT would re-open the merge tables without the
    // conditional re-REVOKE block (LESSONS: guard-vs-DDL split, WP-014).
    await owner.query(
      readFileSync(`${repoRoot}modules/identity/migrations/0006-merge.sql`, 'utf8'),
    );
    await owner.query(
      readFileSync(`${repoRoot}modules/identity/migrations/0004-identity.sql`, 'utf8'),
    );
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE identity.merge_event SET rationale = 'reopened' WHERE event_id = 'nme-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM identity.merge_lineage WHERE lineage_id = 'nml-0001'`,
      ),
    ).toBe('42501');
    // And the timeline posture 0004 owns survives its own re-apply too.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM identity.identity_timeline WHERE entry_id = 'nti-0004'`,
      ),
    ).toBe('42501');
  });

  it('MG-13: forced RLS is live on every merge table', async () => {
    const unprotected = await owner.query(
      `SELECT count(*)::text AS count FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'identity' AND c.relkind = 'r'
         AND c.relname IN ('merge_case', 'merge_case_person', 'merge_event', 'merge_lineage')
         AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`,
    );
    expect(unprotected.rows[0]?.count).toBe('0');
  });

  it('MG-14: an unbound session reads zero merge rows and cannot write', async () => {
    for (const table of mergeTables) {
      const result = await app.query(`SELECT count(*)::text AS count FROM ${table}`);
      expect(result.rows[0]?.count, `${table} must be empty without a binding`).toBe('0');
    }
    await expect(
      app.query(
        `INSERT INTO identity.merge_case
           (tenant_id, case_id, kind, status, matched_attributes, confidence,
            opened_by, source, synthetic)
         VALUES ('northwind-synthetic', 'nmc-unbound', 'possible-match', 'open',
                 '{given-name,birth-date}', 'low', 'synthetic-forge', 'synthetic-forge', true)`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
