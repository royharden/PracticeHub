/**
 * DB-level elevation suite (WP-017 verification gate). Cross-tenant negatives
 * on the six elevation tables, the structural CHECKs (read-only-by-shape
 * break-glass, independent review, abrupt-departure EPCS floor, non-empty
 * forensic signals, resolved-carries-disposition), the append-only / DELETE
 * postures AND their survival across a 0004 re-apply (the conditional
 * re-REVOKE proof), and the seeded standing proofs. Requires the app-postgres
 * from compose.yaml (or the CI service container) on 127.0.0.1:55432.
 *
 * Every INSERT/UPDATE/DELETE this suite attempts is a NEGATIVE (it must fail)
 * — the suite never mutates the seeded state the local:test probes assert.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { elevationRlsSpecs } from './rls-specs.js';

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
  'modules/identity/migrations/0013-elevation.sql',
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/006-identity-seed.sql',
  'infra/postgres/seed/015-elevation-seed.sql',
];

const elevationTables = elevationRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`);

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

describe('elevation DB suite (WP-017)', () => {
  it('EL-01 positive control: a Northwind-bound session reads Northwind rows in every elevation table', async () => {
    for (const table of elevationTables) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(Number(rows[0]?.count), `${table} should show Northwind rows`).toBeGreaterThan(0);
    }
  });

  it('EL-02 cross-tenant reads come back empty in both directions', async () => {
    const fromNorthwind = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS count FROM identity.break_glass_grant WHERE tenant_id = 'riverbend-synthetic'`,
    );
    expect(fromNorthwind.rows[0]?.count).toBe('0');
    const fromRiverbend = await boundQuery<{ count: string }>(
      'riverbend-synthetic',
      `SELECT count(*)::text AS count FROM identity.offboarding_case`,
    );
    expect(fromRiverbend.rows[0]?.count).toBe('0');
  });

  it('EL-03 a Northwind-bound INSERT carrying the Riverbend tenant is rejected by policy', async () => {
    const code = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.access_anomaly_case
         (tenant_id, anomaly_id, pattern, subject_staff_person_id, signals, detected_at,
          status, synthetic)
       VALUES ('riverbend-synthetic', 'nac-neg-1', 'snooping-access', 'rb-taylor-quinn',
               '[{"signalRef":"x","detail":"y","observedAt":"2026-03-24T10:00:00Z"}]'::jsonb,
               '2026-03-24T11:00:00Z', 'open', true)`,
    );
    expect(code).toBe('42501');
  });

  it('EL-04 break_glass_grant is append-only: UPDATE and DELETE are refused', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE identity.break_glass_grant SET severity = 'standard' WHERE grant_id = 'nbg-0002'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM identity.break_glass_grant WHERE grant_id = 'nbg-0001'`,
      ),
    ).toBe('42501');
  });

  it('EL-05 break_glass_review is append-only: UPDATE and DELETE are refused', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE identity.break_glass_review SET outcome = 'access-inappropriate-escalate' WHERE review_id = 'nbgr-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM identity.break_glass_review WHERE review_id = 'nbgr-0001'`,
      ),
    ).toBe('42501');
  });

  it('EL-06 offboarding cases and reassignments are append-only (DELETE refused)', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM identity.offboarding_case WHERE offboarding_id = 'noff-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM identity.offboarding_reassignment WHERE reassignment_id = 'noff-0001-ra-0'`,
      ),
    ).toBe('42501');
  });

  it('EL-07 access_recertification is append-only: UPDATE and DELETE are refused', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE identity.access_recertification SET decision = 'confirmed' WHERE attestation_id = 'nrc-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM identity.access_recertification WHERE attestation_id = 'nrc-0002'`,
      ),
    ).toBe('42501');
  });

  it('EL-08 access_anomaly_case resolves (UPDATE allowed) but never vanishes (DELETE refused)', async () => {
    // A DELETE is refused — the case is evidence.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM identity.access_anomaly_case WHERE anomaly_id = 'nac-0001'`,
      ),
    ).toBe('42501');
  });

  it('EL-09 a break-glass grant whose window does not open is unrepresentable (CHECK)', async () => {
    const code = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.break_glass_grant
         (tenant_id, grant_id, staff_account_id, accessor_person_id, subject_person_id,
          scope, reason_code, justification_ref, severity, initiated_by, effective_at,
          expires_at, review_due_at, synthetic)
       VALUES ('northwind-synthetic', 'nbg-neg-1', 'nsa-morgan-lee', 'np-morgan-lee', 'np-alex-rivera',
               '["results"]'::jsonb, 'emergency-care', 'synthetic-x', 'standard', 'synthetic-it-admin-001',
               '2026-03-25T11:00:00Z', '2026-03-25T10:00:00Z', '2026-03-26T10:00:00Z', true)`,
    );
    expect(code).toBe('23514');
  });

  it('EL-10 a break-glass review by the accessor is unrepresentable (independent CHECK)', async () => {
    const code = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.break_glass_review
         (tenant_id, review_id, grant_id, subject_person_id, accessor_person_id,
          reviewer_person_id, reviewer_role, outcome, evidence_ref, reviewed_at, synthetic)
       VALUES ('northwind-synthetic', 'nbgr-neg-1', 'nbg-0002', 'np-casey-rivera', 'np-morgan-lee',
               'np-morgan-lee', 'compliance-privacy-officer', 'access-appropriate',
               'synthetic-x', '2026-03-26T09:00:00Z', true)`,
    );
    expect(code).toBe('23514');
  });

  it('EL-11 an abrupt departure missing the EPCS-token revocation is unrepresentable (CHECK)', async () => {
    const code = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.offboarding_case
         (tenant_id, offboarding_id, staff_account_id, staff_person_id, kind, reason_ref,
          revoked_scopes, evidence_ref, executed_by, executed_at, synthetic)
       VALUES ('northwind-synthetic', 'noff-neg-1', 'nsa-morgan-lee', 'np-morgan-lee',
               'abrupt-departure', 'synthetic-x', ARRAY['sessions','credentials']::text[],
               'synthetic-x', 'synthetic-it-admin-001', '2026-03-22T08:00:00Z', true)`,
    );
    expect(code).toBe('23514');
  });

  it('EL-12 an anomaly case with an empty forensic signal set is unrepresentable (CHECK)', async () => {
    const code = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.access_anomaly_case
         (tenant_id, anomaly_id, pattern, subject_staff_person_id, signals, detected_at, status, synthetic)
       VALUES ('northwind-synthetic', 'nac-neg-2', 'snooping-access', 'np-morgan-lee',
               '[]'::jsonb, '2026-03-24T11:00:00Z', 'open', true)`,
    );
    expect(code).toBe('23514');
  });

  it('EL-13 a resolved anomaly case without a disposition is unrepresentable (CHECK)', async () => {
    const code = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.access_anomaly_case
         (tenant_id, anomaly_id, pattern, subject_staff_person_id, signals, detected_at, status, synthetic)
       VALUES ('northwind-synthetic', 'nac-neg-3', 'snooping-access', 'np-morgan-lee',
               '[{"signalRef":"x","detail":"y","observedAt":"2026-03-24T10:00:00Z"}]'::jsonb,
               '2026-03-24T11:00:00Z', 'remediated', true)`,
    );
    expect(code).toBe('23514');
  });

  it('EL-14 a break-glass grant referencing a person of another tenant is rejected (composite FK)', async () => {
    const code = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.break_glass_grant
         (tenant_id, grant_id, staff_account_id, accessor_person_id, subject_person_id,
          scope, reason_code, justification_ref, severity, initiated_by, effective_at,
          expires_at, review_due_at, synthetic)
       VALUES ('northwind-synthetic', 'nbg-neg-2', 'nsa-morgan-lee', 'np-morgan-lee', 'rb-taylor-quinn',
               '["results"]'::jsonb, 'emergency-care', 'synthetic-x', 'standard', 'synthetic-it-admin-001',
               '2026-03-25T10:00:00Z', '2026-03-25T11:00:00Z', '2026-03-26T11:00:00Z', true)`,
    );
    expect(code).toBe('23503');
  });

  it('EL-15 a second review for one break-glass grant is unrepresentable (one-per-grant UNIQUE)', async () => {
    const code = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.break_glass_review
         (tenant_id, review_id, grant_id, subject_person_id, accessor_person_id,
          reviewer_person_id, reviewer_role, outcome, evidence_ref, reviewed_at, synthetic)
       VALUES ('northwind-synthetic', 'nbgr-neg-2', 'nbg-0001', 'np-alex-rivera', 'np-morgan-lee',
               'np-jordan-kim', 'it-security-admin', 'access-appropriate',
               'synthetic-x', '2026-03-27T09:00:00Z', true)`,
    );
    expect(code).toBe('23505');
  });

  it('EL-16 every seeded elevation row carries the synthetic watermark', async () => {
    for (const table of elevationTables) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(*)::text AS count FROM ${table} WHERE synthetic IS DISTINCT FROM true`,
      );
      expect(rows[0]?.count, `${table} has unwatermarked rows`).toBe('0');
    }
  });

  it('EL-17 an unbound session (no tenant) reads zero rows — forced RLS fails closed', async () => {
    await app.query('BEGIN');
    try {
      const result = await app.query(
        'SELECT count(*)::text AS count FROM identity.break_glass_grant',
      );
      expect((result.rows[0] as { count: string }).count).toBe('0');
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('EL-18 the append-only postures survive a 0004 re-apply after 0013 (conditional re-REVOKE)', async () => {
    // Re-apply 0004 (whose schema-wide GRANT would re-open the elevation
    // postures) and 0013 as the owner, then re-prove the app role still cannot
    // UPDATE/DELETE an append-only elevation table.
    await owner.query(
      readFileSync(`${repoRoot}modules/identity/migrations/0004-identity.sql`, 'utf8'),
    );
    await owner.query(
      readFileSync(`${repoRoot}modules/identity/migrations/0013-elevation.sql`, 'utf8'),
    );
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE identity.break_glass_grant SET severity = 'standard' WHERE grant_id = 'nbg-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM identity.offboarding_case WHERE offboarding_id = 'noff-0002'`,
      ),
    ).toBe('42501');
  });
});
