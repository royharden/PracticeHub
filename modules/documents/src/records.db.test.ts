/**
 * DB-level documents-records suite (WP-025 verification gate). Cross-tenant
 * negatives, the append-only version log (no app-role edits/deletes), the
 * structural version/e-sign/disclosure CHECKs, SUPERSESSION at rest (the source
 * version is preserved beside its correction; a denied correction keeps the
 * source current), the PARTITION-SCOPED SEARCH NEGATIVE (a genetic row never
 * surfaces without genetic clearance), the disclosure-accounting closure
 * invariant, the content-address hash-integrity anchor, watermark, and
 * cross-module idempotency. Requires the app-postgres from compose.yaml (or the
 * CI service container) on 127.0.0.1:55432.
 *
 * Every forged INSERT is a NEGATIVE (must fail); positive controls read the
 * SEEDED rows, so the state the local:test probes assert is never disturbed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { documentsRecordsRlsSpecs } from './rls-specs.js';

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
  'modules/documents/migrations/0015-documents.sql',
  'modules/documents/migrations/0016-documents-records.sql',
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/017-documents-seed.sql',
  'infra/postgres/seed/018-documents-records-seed.sql',
];

const recordsTables = documentsRecordsRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`);
const hex64 = 'c'.repeat(64);

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

function forgedVersion(id: string, overrides: Readonly<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    tenant_id: `'northwind-synthetic'`,
    version_event_id: `'${id}'`,
    document_id: `'nd-db-rec-forge'`,
    version_no: '1',
    kind: `'original'`,
    blob_ref: `'blob://documents/${hex64}'`,
    content_hash: `'${hex64}'`,
    content_bytes: '10',
    media_type: `'application/pdf'`,
    actor_ref: `'synthetic-staff:records-clerk-001'`,
    occurred_at: `'2026-03-20T00:00:00Z'`,
    synthetic: 'true',
    ...overrides,
  };
  const columns = Object.keys(fields).join(', ');
  const values = Object.values(fields).join(', ');
  return `INSERT INTO documents.document_version (${columns}) VALUES (${values})`;
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

describe('documents-records DB suite (WP-025)', () => {
  it('REC-01 positive control: a Northwind-bound session reads its records rows', async () => {
    for (const table of recordsTables) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(Number(rows[0]?.count), `${table} should show rows`).toBeGreaterThan(0);
    }
  });

  it('REC-02 cross-tenant reads come back empty in both directions', async () => {
    const fromNorthwind = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS count FROM documents.document_version WHERE tenant_id = 'riverbend-synthetic'`,
    );
    expect(fromNorthwind.rows[0]?.count).toBe('0');
    const fromRiverbend = await boundQuery<{ count: string }>(
      'riverbend-synthetic',
      `SELECT count(*)::text AS count FROM documents.records_disclosure WHERE disclosure_id = 'ndd-0001'`,
    );
    expect(fromRiverbend.rows[0]?.count).toBe('0');
  });

  it('REC-03 forced RLS: an INSERT carrying the other tenant is rejected', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedVersion('ndrf-0001', { tenant_id: `'riverbend-synthetic'` }),
      ),
    ).toBe('42501');
  });

  it('REC-04 the version log is append-only; no app-role edit or delete', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE documents.document_version SET kind = 'amendment' WHERE version_event_id = 'ndv-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM documents.document_version WHERE version_event_id = 'ndv-0001'`,
      ),
    ).toBe('42501');
  });

  it('REC-05 the structural version/e-sign CHECKs are enforced', async () => {
    // an original carrying a supersedes pointer
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedVersion('ndrf-0002', { supersedes_version_no: '1' }),
      ),
    ).toBe('23514');
    // a correction without a reason
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedVersion('ndrf-0003', {
          kind: `'correction'`,
          version_no: '2',
          supersedes_version_no: '1',
        }),
      ),
    ).toBe('23514');
    // a superseding version (amendment) with no supersedes pointer
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedVersion('ndrf-0004', { kind: `'amendment'`, version_no: '2' }),
      ),
    ).toBe('23514');
    // an esign-execution missing its evidence chain
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedVersion('ndrf-0005', {
          kind: `'esign-execution'`,
          version_no: '2',
          supersedes_version_no: '1',
        }),
      ),
    ).toBe('23514');
    // a non-esign version carrying an esign column
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedVersion('ndrf-0006', { esign_method: `'click-to-sign'` }),
      ),
    ).toBe('23514');
    // a blob ref that is not content-addressed by its content hash
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedVersion('ndrf-0007', { blob_ref: `'blob://documents/${'d'.repeat(64)}'` }),
      ),
    ).toBe('23514');
  });

  it('REC-06 SUPERSESSION at rest: the correction is current and the source version is PRESERVED', async () => {
    // the current head of nd-0001 is the correction (v2); v1 is superseded but still present
    const head = await boundQuery<{ version_no: string; kind: string }>(
      'northwind-synthetic',
      `SELECT version_no::text AS version_no, kind FROM documents.document_version dv
       WHERE tenant_id = 'northwind-synthetic' AND document_id = 'nd-0001'
         AND kind <> 'statement-of-disagreement'
         AND NOT EXISTS (SELECT 1 FROM documents.document_version w
           WHERE w.tenant_id = dv.tenant_id AND w.document_id = dv.document_id
             AND w.supersedes_version_no = dv.version_no)
       ORDER BY version_no DESC LIMIT 1`,
    );
    expect(head.rows[0]?.version_no).toBe('2');
    expect(head.rows[0]?.kind).toBe('correction');
    const lineage = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS count FROM documents.document_version WHERE document_id = 'nd-0001'`,
    );
    expect(lineage.rows[0]?.count).toBe('2');
    // a DENIED correction: the statement of disagreement stands beside; the source (v1) is still current
    const denied = await boundQuery<{ version_no: string }>(
      'northwind-synthetic',
      `SELECT version_no::text AS version_no FROM documents.document_version dv
       WHERE tenant_id = 'northwind-synthetic' AND document_id = 'nd-0005'
         AND kind <> 'statement-of-disagreement'
         AND NOT EXISTS (SELECT 1 FROM documents.document_version w
           WHERE w.tenant_id = dv.tenant_id AND w.document_id = dv.document_id
             AND w.supersedes_version_no = dv.version_no)
       ORDER BY version_no DESC LIMIT 1`,
    );
    expect(denied.rows[0]?.version_no).toBe('1');
  });

  it('REC-07 PARTITION-SCOPED SEARCH NEGATIVE: a genetic row never surfaces without genetic clearance', async () => {
    // without genetic clearance the genetic panel does not surface
    const withoutClearance = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS count FROM documents.document_search_index
       WHERE search_vector @@ plainto_tsquery('english', 'panel')
         AND partition_tags <@ '{}'::text[]`,
    );
    expect(withoutClearance.rows[0]?.count).toBe('0');
    // with genetic clearance it surfaces (positive control)
    const withClearance = await boundQuery<{ document_id: string }>(
      'northwind-synthetic',
      `SELECT document_id FROM documents.document_search_index
       WHERE search_vector @@ plainto_tsquery('english', 'panel')
         AND partition_tags <@ ARRAY['gipa-genetic']::text[]`,
    );
    expect(withClearance.rows.map((r) => r.document_id)).toContain('nd-0007');
  });

  it('REC-08 disclosure accounting + closure invariant CHECKs', async () => {
    // the seeded audit disclosure is closed with evidence and excludes the genetic artifact
    const disclosure = await boundQuery<{ closure_status: string; excluded: string }>(
      'northwind-synthetic',
      `SELECT closure_status, array_length(excluded_genetic_refs, 1)::text AS excluded
       FROM documents.records_disclosure WHERE disclosure_id = 'ndd-0001'`,
    );
    expect(disclosure.rows[0]?.closure_status).toBe('closed-with-evidence');
    expect(disclosure.rows[0]?.excluded).toBe('1');
    // closed-with-evidence requires evidence
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO documents.records_disclosure
           (tenant_id, disclosure_id, subject_person_ref, recipient_ref, purpose, requested_by,
            included_artifact_refs, disclosed_at, closure_status, synthetic)
         VALUES ('northwind-synthetic', 'nd-db-disc-forge', 'np-x', 'synthetic-recipient:x', 'operations',
            'synthetic-staff:x', '{}'::text[], '2026-03-20T00:00:00Z', 'closed-with-evidence', true)`,
      ),
    ).toBe('23514');
    // a genetic authorization ref without its written-evidence pair
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO documents.records_disclosure
           (tenant_id, disclosure_id, subject_person_ref, recipient_ref, purpose, requested_by,
            included_artifact_refs, genetic_authorization_ref, disclosed_at, closure_status, synthetic)
         VALUES ('northwind-synthetic', 'nd-db-disc-forge2', 'np-x', 'synthetic-recipient:x', 'operations',
            'synthetic-staff:x', '{}'::text[], 'synthetic-gauth:x', '2026-03-20T00:00:00Z', 'transmitted', true)`,
      ),
    ).toBe('23514');
  });

  it('REC-09 the version content-address anchor holds: every blob_ref embeds its content_hash', async () => {
    const { rows } = await boundQuery<{ mismatched: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS mismatched FROM documents.document_version
       WHERE blob_ref <> 'blob://documents/' || content_hash`,
    );
    expect(rows[0]?.mismatched).toBe('0');
  });

  it('REC-10 every seeded records row carries the synthetic watermark', async () => {
    for (const table of recordsTables) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(*)::text AS count FROM ${table} WHERE synthetic IS DISTINCT FROM true`,
      );
      expect(rows[0]?.count, `${table} should be fully watermarked`).toBe('0');
    }
  });

  it('REC-11 idempotency: 0016 re-applies, and 0015 re-applies after it (cross-migration)', async () => {
    await owner.query(
      readFileSync(`${repoRoot}modules/documents/migrations/0016-documents-records.sql`, 'utf8'),
    );
    await owner.query(
      readFileSync(`${repoRoot}modules/documents/migrations/0015-documents.sql`, 'utf8'),
    );
    const { rows } = await owner.query(
      `SELECT count(*)::text AS count FROM documents.document_version`,
    );
    expect(Number((rows[0] as { count: string }).count)).toBeGreaterThan(0);
  });
});
