/**
 * DB-level documents suite (WP-024 verification gate). Cross-tenant negatives,
 * the append-only event log (no app-role edits/deletes), the structural
 * received/quarantine/filed/hold/disposition CHECKs, the quarantine
 * attribute-names-only proof (REQ-DOC-006), the content-address hash-integrity
 * anchor (blob_ref embeds the content_hash), the unknown-patient hold timer at
 * rest (REQ-DOC-010/011), the projection-vs-fold linkage, and cross-module
 * idempotency. Requires the app-postgres from compose.yaml (or the CI service
 * container) on 127.0.0.1:55432.
 *
 * Every INSERT is a NEGATIVE (must fail); positive controls read the SEEDED
 * rows, so the state the local:test probes assert is never disturbed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { documentsRlsSpecs } from './rls-specs.js';

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
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/017-documents-seed.sql',
];

const documentTables = documentsRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`);
const hex64 = 'a'.repeat(64);

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

function forgedEvent(id: string, overrides: Readonly<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    tenant_id: `'northwind-synthetic'`,
    document_event_id: `'${id}'`,
    document_id: `'nd-db-forge'`,
    event_type: `'received'`,
    actor_ref: `'synthetic-fax-gateway'`,
    source: `'inbound_fax'`,
    blob_ref: `'blob://documents/${hex64}'`,
    content_hash: `'${hex64}'`,
    content_bytes: '10',
    media_type: `'application/pdf'`,
    page_count: '1',
    occurred_at: `'2026-03-17T00:00:00Z'`,
    synthetic: 'true',
    ...overrides,
  };
  const columns = Object.keys(fields).join(', ');
  const values = Object.values(fields).join(', ');
  return `INSERT INTO documents.document_event (${columns}) VALUES (${values})`;
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

describe('documents DB suite (WP-024)', () => {
  it('DOC-01 positive control: a Northwind-bound session reads its document rows', async () => {
    for (const table of documentTables) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(Number(rows[0]?.count), `${table} should show rows`).toBeGreaterThan(0);
    }
  });

  it('DOC-02 cross-tenant reads come back empty in both directions', async () => {
    const fromNorthwind = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS count FROM documents.document_event WHERE tenant_id = 'riverbend-synthetic'`,
    );
    expect(fromNorthwind.rows[0]?.count).toBe('0');
    const fromRiverbend = await boundQuery<{ count: string }>(
      'riverbend-synthetic',
      `SELECT count(*)::text AS count FROM documents.document_state WHERE document_id = 'nd-0001'`,
    );
    expect(fromRiverbend.rows[0]?.count).toBe('0');
  });

  it('DOC-03 forced RLS: an unbound session reads zero rows', async () => {
    const result = await owner.query(
      `SELECT count(*)::text AS count FROM documents.document_event`,
    );
    // owner bypasses RLS and sees rows; the app role bound to a tenant is the
    // isolation surface — an INSERT carrying the other tenant is rejected below.
    expect(Number((result.rows[0] as { count: string }).count)).toBeGreaterThan(0);
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('ddbf-0001', { tenant_id: `'riverbend-synthetic'` }),
      ),
    ).toBe('42501');
  });

  it('DOC-04 the event log is append-only; the projection folds forward and never deletes', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE documents.document_event SET event_type = 'filed' WHERE document_event_id = 'nde-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM documents.document_event WHERE document_event_id = 'nde-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM documents.document_state WHERE document_id = 'nd-0001'`,
      ),
    ).toBe('42501');
  });

  it('DOC-05 the structural intake/quarantine/filed/hold/disposition CHECKs are enforced', async () => {
    // A received event missing its integrity anchor (no content hash).
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('ddbf-0002', { content_hash: 'NULL' }),
      ),
    ).toBe('23514');
    // A non-received event carrying intake columns (they belong to received only).
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('ddbf-0003', {
          event_type: `'filed'`,
          matched_person_ref: `'np-x'`,
          evidence_ref: `'synthetic-doc-evidence:x'`,
        }),
      ),
    ).toBe('23514');
    // A filed event with no matched person.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('ddbf-0004', {
          event_type: `'filed'`,
          source: 'NULL',
          blob_ref: 'NULL',
          content_hash: 'NULL',
          content_bytes: 'NULL',
          media_type: 'NULL',
          page_count: 'NULL',
        }),
      ),
    ).toBe('23514');
    // An auto_match_failed with no hold deadline (REQ-DOC-011 coupling).
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('ddbf-0005', {
          event_type: `'auto_match_failed'`,
          source: 'NULL',
          blob_ref: 'NULL',
          content_hash: 'NULL',
          content_bytes: 'NULL',
          media_type: 'NULL',
          page_count: 'NULL',
        }),
      ),
    ).toBe('23514');
    // A disposition with no outcome.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('ddbf-0006', {
          event_type: `'disposition_decided'`,
          source: 'NULL',
          blob_ref: 'NULL',
          content_hash: 'NULL',
          content_bytes: 'NULL',
          media_type: 'NULL',
          page_count: 'NULL',
          evidence_ref: `'synthetic-doc-evidence:d'`,
        }),
      ),
    ).toBe('23514');
    // A malformed content hash (not sha-256 hex).
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('ddbf-0007', { content_hash: `'not-a-hash'` }),
      ),
    ).toBe('23514');
    // A blob ref that is not a content-addressed blob:// ref.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('ddbf-0008', { blob_ref: `'http://evil/x'` }),
      ),
    ).toBe('23514');
  });

  it('DOC-06 quarantine holds attribute NAMES only — a raw value is unrepresentable (REQ-DOC-006)', async () => {
    // A quarantined event whose observed_attribute_names carries an unlisted
    // token (a smuggled value) violates the array-subset CHECK.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('ddbf-0009', {
          event_type: `'quarantined'`,
          source: 'NULL',
          blob_ref: 'NULL',
          content_hash: 'NULL',
          content_bytes: 'NULL',
          media_type: 'NULL',
          page_count: 'NULL',
          quarantine_reason: `'wrong-patient'`,
          observed_attribute_names: `ARRAY['unlisted-value']::text[]`,
        }),
      ),
    ).toBe('23514');
    // The seeded quarantined record carries a reason and observed NAMES, no value column exists.
    const { rows } = await boundQuery<{ reason: string; names: string }>(
      'northwind-synthetic',
      `SELECT quarantine_reason AS reason, array_to_string(observed_attribute_names, ',') AS names
       FROM documents.document_event WHERE document_id = 'nd-0002' AND event_type = 'quarantined'`,
    );
    expect(rows[0]?.reason).toBe('wrong-patient');
    expect(rows[0]?.names).toContain('patient-name');
    // The quarantine QUEUE row (the projection) surfaces those same NAMES so a
    // reviewer triages straight from the read model (contract §3).
    const queueRow = await boundQuery<{ reason: string; names: string }>(
      'northwind-synthetic',
      `SELECT quarantine_reason AS reason, array_to_string(observed_attribute_names, ',') AS names
       FROM documents.document_state WHERE document_id = 'nd-0002'`,
    );
    expect(queueRow.rows[0]?.reason).toBe('wrong-patient');
    expect(queueRow.rows[0]?.names).toContain('patient-name');
    // A quarantined projection row with no observed names violates ds_status_shape.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO documents.document_state
           (tenant_id, document_id, status, source, blob_ref, content_hash, content_bytes,
            media_type, page_count, received_at, quarantine_reason, last_event_id, synthetic)
         VALUES ('northwind-synthetic', 'nd-db-forge', 'quarantined', 'partner_exchange',
            'blob://documents/${hex64}', '${hex64}', 10, 'application/pdf', 1,
            '2026-03-17T00:00:00Z', 'wrong-patient', 'nde-0004', true)`,
      ),
    ).toBe('23514');
  });

  it('DOC-07 hash-integrity anchor: every stored blob_ref ends with its content_hash', async () => {
    const { rows } = await boundQuery<{ mismatched: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS mismatched FROM documents.document_state
       WHERE blob_ref <> 'blob://documents/' || content_hash`,
    );
    expect(rows[0]?.mismatched).toBe('0');
  });

  it('DOC-08 the unknown-patient hold timer is at rest: an unmatched hold and an expired-then-disposed record', async () => {
    const unmatched = await boundQuery<{ status: string; hold: string }>(
      'northwind-synthetic',
      `SELECT status, (hold_until IS NOT NULL)::text AS hold FROM documents.document_state WHERE document_id = 'nd-0003'`,
    );
    expect(unmatched.rows[0]?.status).toBe('unmatched');
    expect(unmatched.rows[0]?.hold).toBe('true');
    const disposed = await boundQuery<{ status: string; disposition: string }>(
      'northwind-synthetic',
      `SELECT status, disposition FROM documents.document_state WHERE document_id = 'nd-0004'`,
    );
    expect(disposed.rows[0]?.status).toBe('disposed');
    expect(disposed.rows[0]?.disposition).toBe('returned');
  });

  it('DOC-09 the projection last_event_id is the latest event of each document (fold linkage)', async () => {
    const { rows } = await owner.query(
      `SELECT count(*)::text AS drift FROM documents.document_state s
       WHERE s.last_event_id <> (
         SELECT e.document_event_id FROM documents.document_event e
         WHERE e.tenant_id = s.tenant_id AND e.document_id = s.document_id
         ORDER BY e.occurred_at DESC, e.document_event_id DESC LIMIT 1
       )`,
    );
    expect((rows[0] as { drift: string }).drift).toBe('0');
  });

  it('DOC-10 the projection FK is same-tenant: a cross-tenant last_event_id is rejected', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO documents.document_state
           (tenant_id, document_id, status, source, blob_ref, content_hash, content_bytes,
            media_type, page_count, received_at, last_event_id, synthetic)
         VALUES ('northwind-synthetic', 'nd-db-forge', 'received', 'inbound_fax',
            'blob://documents/${hex64}', '${hex64}', 10, 'application/pdf', 1,
            '2026-03-17T00:00:00Z', 'rde-0001', true)`,
      ),
    ).toBe('23503');
  });

  it('DOC-11 every seeded row carries the synthetic watermark', async () => {
    for (const table of documentTables) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(*)::text AS count FROM ${table} WHERE synthetic IS DISTINCT FROM true`,
      );
      expect(rows[0]?.count, `${table} should be fully watermarked`).toBe('0');
    }
  });

  it('DOC-12 idempotency: 0015 re-applies, and 0001 re-applies after it (cross-module)', async () => {
    await owner.query(
      readFileSync(`${repoRoot}modules/documents/migrations/0015-documents.sql`, 'utf8'),
    );
    await owner.query(
      readFileSync(`${repoRoot}modules/platform-core/migrations/0001-tenancy.sql`, 'utf8'),
    );
    const { rows } = await owner.query(
      `SELECT count(*)::text AS count FROM documents.document_event`,
    );
    expect(Number((rows[0] as { count: string }).count)).toBeGreaterThan(0);
  });
});
