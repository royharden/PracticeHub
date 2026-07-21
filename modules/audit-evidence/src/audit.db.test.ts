/**
 * DB-level audit-evidence suite (WP-020 verification gate). Cross-tenant
 * negatives, the append-only postures (R6-REQ-001: no app role can edit or
 * delete the log), the per-stream completeness CHECKs, the SAME-COMMIT crash
 * test (an audited operation and its audit record persist together or not at
 * all), and the hash-chain recompute over the SEEDED rows via the domain
 * verifier. Requires the app-postgres from compose.yaml (or the CI service
 * container) on 127.0.0.1:55432.
 *
 * Every INSERT is either a NEGATIVE (must fail) or — in the same-commit
 * test only — cleaned up by the owner connection before the test ends, so
 * the seeded state the local:test probes assert is never disturbed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { verifyAuditChain, type AuditRecord } from './audit.js';
import { auditEvidenceRlsSpecs } from './rls-specs.js';

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
  'modules/audit-evidence/migrations/0007-audit.sql',
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/009-audit-seed.sql',
];

const auditTables = auditEvidenceRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`);
const tenantScopedTables = auditEvidenceRlsSpecs
  .filter((spec) => spec.kind === 'tenant-scoped')
  .map((spec) => `${spec.schema}.${spec.table}`);
const hexHash = 'ab'.repeat(32);

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

function forgedEvent(auditId: string, overrides: Readonly<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    tenant_id: `'northwind-synthetic'`,
    audit_id: `'${auditId}'`,
    stream: `'access'`,
    action: `'chart-view'`,
    actor_ref: `'synthetic-staff:db-forge'`,
    subject_ref: `'np-db-forge'`,
    decision: `'allow'`,
    reason: `'treatment'`,
    chain_day: `'2026-03-17'`,
    chain_seq: '1',
    prev_hash: `'genesis'`,
    entry_hash: `'${hexHash}'`,
    occurred_at: `'2026-03-17T09:00:00Z'`,
    synthetic: 'true',
    ...overrides,
  };
  const columns = Object.keys(fields).join(', ');
  const values = Object.values(fields).join(', ');
  return `INSERT INTO audit_evidence.audit_event (${columns}) VALUES (${values})`;
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

describe('audit-evidence DB suite (WP-020)', () => {
  it('AU-01 positive control: a Northwind-bound session reads its audit rows and the registry', async () => {
    for (const table of [...tenantScopedTables, 'audit_evidence.retention_schedule']) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(Number(rows[0]?.count), `${table} should show rows`).toBeGreaterThan(0);
    }
  });

  it('AU-02 cross-tenant reads come back empty in both directions', async () => {
    const fromNorthwind = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS count FROM audit_evidence.audit_event WHERE tenant_id = 'riverbend-synthetic'`,
    );
    expect(fromNorthwind.rows[0]?.count).toBe('0');
    const fromRiverbend = await boundQuery<{ count: string }>(
      'riverbend-synthetic',
      `SELECT count(*)::text AS count FROM audit_evidence.destruction_evidence`,
    );
    expect(fromRiverbend.rows[0]?.count).toBe('0');
  });

  it('AU-03 a Northwind-bound INSERT carrying the Riverbend tenant is rejected by policy', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('dbf-0001', { tenant_id: `'riverbend-synthetic'` }),
      ),
    ).toBe('42501');
  });

  it('AU-04 the log is append-only for every app role; the registry is runtime-read-only', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE audit_evidence.audit_event SET actor_ref = 'synthetic-staff:rewritten' WHERE audit_id = 'nae-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM audit_evidence.audit_event WHERE audit_id = 'nae-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE audit_evidence.destruction_evidence SET authority_ref = 'forged' WHERE destruction_id = 'nde-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM audit_evidence.destruction_evidence WHERE destruction_id = 'nde-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM audit_evidence.legal_hold WHERE hold_id = 'nlh-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO audit_evidence.retention_schedule
           (record_class, version, status, basis, fixed_term_years, minimum_years,
            minors_extension, age_of_majority_years, basis_ref, change_control_ref, synthetic)
         VALUES ('audit-log', 99, 'draft', 'fixed-term', 1, 1, 'none', 18, 'forged', 'forged', true)`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE audit_evidence.retention_schedule SET minimum_years = 1 WHERE record_class = 'audit-log'`,
      ),
    ).toBe('42501');
  });

  it('AU-05 per-stream completeness and chain shape are CHECK-enforced', async () => {
    // Access without a reason.
    expect(
      await boundQueryError('northwind-synthetic', forgedEvent('dbf-0002', { reason: 'NULL' })),
    ).toBe('23514');
    // AI interaction without model version.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('dbf-0003', {
          stream: `'ai-interaction'`,
          model_ref: `'model-sim:claude-sonnet'`,
          prompt_ref: `'minio://synthetic-ai/prompts/dbf-0003'`,
          prompt_hash: `'${hexHash}'`,
          output_ref: `'minio://synthetic-ai/outputs/dbf-0003'`,
          output_hash: `'${hexHash}'`,
        }),
      ),
    ).toBe('23514');
    // Disclosure without recipient/purpose.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('dbf-0004', { stream: `'disclosure'`, reason: 'NULL' }),
      ),
    ).toBe('23514');
    // Genesis rule: link 2 cannot claim genesis; link 1 cannot carry a hash.
    expect(
      await boundQueryError('northwind-synthetic', forgedEvent('dbf-0005', { chain_seq: '2' })),
    ).toBe('23514');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('dbf-0006', { prev_hash: `'${hexHash}'` }),
      ),
    ).toBe('23514');
    // A duplicate chain position is unrepresentable.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('dbf-0007', { chain_day: `'2026-03-15'` }),
      ),
    ).toBe('23505');
    // Unknown partition tags and malformed hashes are refused.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('dbf-0008', { partition_tags: `ARRAY['secret-club']::text[]` }),
      ),
    ).toBe('23514');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('dbf-0009', { entry_hash: `'not-a-hash'` }),
      ),
    ).toBe('23514');
  });

  it('AU-06 a hold release without evidence, or an active hold carrying one, is unrepresentable', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO audit_evidence.legal_hold
           (tenant_id, hold_id, matter_ref, record_classes, status, placed_by,
            placed_basis_ref, synthetic)
         VALUES ('northwind-synthetic', 'dbh-0001', 'synthetic-matter-forge', '{}', 'released',
                 'synthetic-staff:db-forge', 'synthetic-order-forge', true)`,
      ),
    ).toBe('23514');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO audit_evidence.legal_hold
           (tenant_id, hold_id, matter_ref, record_classes, status, placed_by,
            placed_basis_ref, released_by, release_evidence_ref, synthetic)
         VALUES ('northwind-synthetic', 'dbh-0002', 'synthetic-matter-forge', '{}', 'active',
                 'synthetic-staff:db-forge', 'synthetic-order-forge',
                 'synthetic-staff:db-forge', 'synthetic-memo-forge', true)`,
      ),
    ).toBe('23514');
  });

  it('AU-07 destruction evidence requires refs, authority, manifest hash, and its audit record', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO audit_evidence.destruction_evidence
           (tenant_id, destruction_id, record_class, record_refs, why_basis_refs,
            authority_ref, manifest_hash, audit_id, synthetic)
         VALUES ('northwind-synthetic', 'dbd-0001', 'gfe-record', '{}', '{basis}',
                 'synthetic-staff:db-forge', '${hexHash}', 'nae-0006', true)`,
      ),
    ).toBe('23514');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO audit_evidence.destruction_evidence
           (tenant_id, destruction_id, record_class, record_refs, why_basis_refs,
            authority_ref, manifest_hash, audit_id, synthetic)
         VALUES ('northwind-synthetic', 'dbd-0002', 'gfe-record', '{ref}', '{basis}',
                 'synthetic-staff:db-forge', 'not-a-hash', 'nae-0006', true)`,
      ),
    ).toBe('23514');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO audit_evidence.destruction_evidence
           (tenant_id, destruction_id, record_class, record_refs, why_basis_refs,
            authority_ref, manifest_hash, audit_id, synthetic)
         VALUES ('northwind-synthetic', 'dbd-0003', 'gfe-record', '{ref}', '{basis}',
                 'synthetic-staff:db-forge', '${hexHash}', 'nae-missing', true)`,
      ),
    ).toBe('23503');
  });

  it('AU-08 SAME-COMMIT GUARANTEE: operation and audit record persist together or not at all', async () => {
    const operationInsert = `INSERT INTO audit_evidence.legal_hold
        (tenant_id, hold_id, matter_ref, record_classes, status, placed_by,
         placed_basis_ref, synthetic)
      VALUES ('northwind-synthetic', 'dbh-crash', 'synthetic-matter-crash', '{}', 'active',
              'synthetic-staff:db-crash', 'synthetic-order-crash', true)`;
    const auditInsert = forgedEvent('dba-crash', {
      stream: `'config-change'`,
      action: `'legal-hold-placed'`,
      subject_ref: 'NULL',
      decision: 'NULL',
      reason: 'NULL',
      correlation_ref: `'dbh-crash'`,
      detail: `'{"config_ref": "legal-hold:dbh-crash"}'::jsonb`,
      chain_day: `'2026-03-18'`,
      occurred_at: `'2026-03-18T09:00:00Z'`,
    });
    const countBoth = async (): Promise<string> => {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT ((SELECT count(*) FROM audit_evidence.legal_hold WHERE hold_id = 'dbh-crash')
               + (SELECT count(*) FROM audit_evidence.audit_event WHERE audit_id = 'dba-crash'))::text AS count`,
      );
      return rows[0]?.count ?? '?';
    };

    // Crash direction: the transaction dies after both writes — NEITHER persists.
    await app.query('BEGIN');
    await app.query(tenantBindingSql('northwind-synthetic'));
    await app.query(operationInsert);
    await app.query(auditInsert);
    await app.query('ROLLBACK');
    expect(await countBoth()).toBe('0');

    // Commit direction: BOTH persist atomically.
    await app.query('BEGIN');
    await app.query(tenantBindingSql('northwind-synthetic'));
    await app.query(operationInsert);
    await app.query(auditInsert);
    await app.query('COMMIT');
    expect(await countBoth()).toBe('2');

    // Restore the seeded state exactly (owner bypasses the append-only posture).
    await owner.query(`DELETE FROM audit_evidence.audit_event WHERE audit_id = 'dba-crash'`);
    await owner.query(`DELETE FROM audit_evidence.legal_hold WHERE hold_id = 'dbh-crash'`);
    expect(await countBoth()).toBe('0');
  });

  it('AU-09 the stored hash chains recompute exactly via the domain verifier', async () => {
    const result = await owner.query(
      `SELECT tenant_id, audit_id, stream, action, actor_ref, subject_ref, decision, reason,
              source_ref, correlation_ref, recipient_ref, purpose, model_ref, model_version,
              prompt_ref, prompt_hash, output_ref, output_hash, detail, partition_tags,
              chain_day::text AS chain_day, chain_seq, prev_hash, entry_hash,
              to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS occurred_at_iso
         FROM audit_evidence.audit_event
        ORDER BY tenant_id, chain_day, chain_seq`,
    );
    const records = result.rows.map((row): AuditRecord => {
      const record: Record<string, unknown> = {
        auditId: row.audit_id,
        tenantId: row.tenant_id,
        stream: row.stream,
        action: row.action,
        actorRef: row.actor_ref,
        occurredAt: row.occurred_at_iso,
        detail: row.detail,
        partitionTags: row.partition_tags,
        chainDay: row.chain_day,
        chainSeq: row.chain_seq,
        prevHash: row.prev_hash,
        entryHash: row.entry_hash,
        synthetic: true,
      };
      const optionalColumns = {
        subjectRef: row.subject_ref,
        decision: row.decision,
        reason: row.reason,
        sourceRef: row.source_ref,
        correlationRef: row.correlation_ref,
        recipientRef: row.recipient_ref,
        purpose: row.purpose,
        modelRef: row.model_ref,
        modelVersion: row.model_version,
        promptRef: row.prompt_ref,
        promptHash: row.prompt_hash,
        outputRef: row.output_ref,
        outputHash: row.output_hash,
      } as Record<string, unknown>;
      for (const [key, value] of Object.entries(optionalColumns)) {
        if (value !== null && value !== undefined) {
          record[key] = value;
        }
      }
      return record as unknown as AuditRecord;
    });
    expect(records.length).toBeGreaterThanOrEqual(8);
    const verification = verifyAuditChain(records);
    expect(verification.breaks).toEqual([]);
    expect(verification.valid).toBe(true);
  });

  it('AU-10 every seeded audit row carries the synthetic watermark', async () => {
    for (const table of auditTables) {
      const result = await owner.query(
        `SELECT count(*)::text AS count FROM ${table} WHERE synthetic IS DISTINCT FROM true`,
      );
      expect(result.rows[0]?.count, `${table} must be fully watermarked`).toBe('0');
    }
  });

  it('AU-11 idempotency across modules: 0007 re-applies, 0001 re-applies after it, postures hold', async () => {
    await owner.query(
      readFileSync(`${repoRoot}modules/audit-evidence/migrations/0007-audit.sql`, 'utf8'),
    );
    await owner.query(
      readFileSync(`${repoRoot}modules/platform-core/migrations/0001-tenancy.sql`, 'utf8'),
    );
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE audit_evidence.audit_event SET actor_ref = 'synthetic-staff:reopened' WHERE audit_id = 'nae-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE audit_evidence.retention_schedule SET minimum_years = 1 WHERE record_class = 'audit-log'`,
      ),
    ).toBe('42501');
  });

  it('AU-12 forced RLS is live; an unbound session reads zero rows and cannot write', async () => {
    const unprotected = await owner.query(
      `SELECT count(*)::text AS count FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'audit_evidence' AND c.relkind = 'r'
         AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`,
    );
    expect(unprotected.rows[0]?.count).toBe('0');
    for (const table of tenantScopedTables) {
      const result = await app.query(`SELECT count(*)::text AS count FROM ${table}`);
      expect(result.rows[0]?.count, `${table} must be empty without a binding`).toBe('0');
    }
    await expect(app.query(forgedEvent('dbf-unbound'))).rejects.toMatchObject({ code: '42501' });
  });

  it('AU-13 the retention registry is seeded complete: every record class at v1', async () => {
    const result = await owner.query(
      `SELECT count(*)::text AS count FROM audit_evidence.retention_schedule WHERE version = 1`,
    );
    expect(result.rows[0]?.count).toBe('6');
  });

  it('AU-14 seeded destruction evidence joins its audit record with a matching manifest hash', async () => {
    const { rows } = await boundQuery<{ manifest_hash: string; detail_hash: string }>(
      'northwind-synthetic',
      `SELECT d.manifest_hash, e.detail->>'manifest_hash' AS detail_hash
         FROM audit_evidence.destruction_evidence d
         JOIN audit_evidence.audit_event e
           ON e.tenant_id = d.tenant_id AND e.audit_id = d.audit_id
        WHERE d.destruction_id = 'nde-0001'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.manifest_hash).toBe(rows[0]?.detail_hash);
  });
});
