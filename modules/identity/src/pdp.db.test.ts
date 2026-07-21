/**
 * DB-level PDP suite (WP-015 verification gate). Cross-tenant negatives on
 * the seven PDP tables, the structural CHECKs (authority kinds, override
 * discipline, flag evidence, partition quarantine), the append-only /
 * immutability postures AND their survival across a 0004 re-apply (the
 * conditional re-REVOKE proof), and the seeded standing proofs. Requires the
 * app-postgres from compose.yaml (or the CI service container) on
 * 127.0.0.1:55432.
 *
 * Every INSERT/UPDATE this suite attempts is a NEGATIVE (it must fail) —
 * the suite never mutates the seeded state the local:test probes assert.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pdpRlsSpecs } from './rls-specs.js';

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
  'modules/identity/migrations/0008-pdp.sql',
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/006-identity-seed.sql',
  'infra/postgres/seed/008-merge-seed.sql',
  'infra/postgres/seed/010-pdp-seed.sql',
];

const pdpTables = pdpRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`);

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

describe('PDP DB suite (WP-015)', () => {
  it('PD-01 positive control: a Northwind-bound session reads Northwind rows in every PDP table', async () => {
    for (const table of pdpTables) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(Number(rows[0]?.count), `${table} should show Northwind rows`).toBeGreaterThan(0);
    }
  });

  it('PD-02: cross-tenant reads come back empty in both directions', async () => {
    const fromNorthwind = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS count FROM identity.authority_record WHERE tenant_id = 'riverbend-synthetic'`,
    );
    expect(fromNorthwind.rows[0]?.count).toBe('0');
    const fromRiverbend = await boundQuery<{ count: string }>(
      'riverbend-synthetic',
      `SELECT count(*)::text AS count FROM identity.role_template`,
    );
    expect(fromRiverbend.rows[0]?.count).toBe('0');
  });

  it('PD-03: a Northwind-bound INSERT carrying the Riverbend tenant is rejected by policy', async () => {
    const code = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.partition_tag
         (tenant_id, tag_id, subject_person_id, artifact_ref, tag, ingest_path,
          review_status, blocked_from_release, synthetic)
       VALUES ('riverbend-synthetic', 'rpt-neg-1', 'rb-taylor-quinn', 'synthetic-x', 'gipa-genetic',
               'lab-interface', 'auto-confirmed', false, true)`,
    );
    expect(code).toBe('42501');
  });

  it('PD-04: person_flag is append-only — UPDATE and DELETE are revoked', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE identity.person_flag SET action = 'corrected' WHERE flag_id = 'nfl-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM identity.person_flag WHERE flag_id = 'nfl-0001'`,
      ),
    ).toBe('42501');
  });

  it('PD-05: role_template versions are immutable — permits cannot UPDATE, rows cannot DELETE; status can', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE identity.role_template SET permits = permits WHERE role_key = 'front-desk'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM identity.role_template WHERE role_key = 'front-desk'`,
      ),
    ).toBe('42501');
    // The status column alone carries the supersede privilege (a no-op write).
    await boundQuery(
      'northwind-synthetic',
      `UPDATE identity.role_template SET status = status WHERE role_key = 'front-desk' AND version = 1`,
    );
  });

  it('PD-06: assignments/overrides/authority/tags/authorizations never DELETE', async () => {
    for (const [table, where] of [
      ['identity.role_assignment', `assignment_id = 'nra-morgan-itsec'`],
      ['identity.access_override', `override_id = 'nov-morgan-docs'`],
      ['identity.authority_record', `authority_id = 'nar-alex-casey'`],
      ['identity.partition_tag', `tag_id = 'npt-0001'`],
      ['identity.gipa_authorization', `authorization_id = 'nga-0001'`],
    ] as const) {
      expect(
        await boundQueryError('northwind-synthetic', `DELETE FROM ${table} WHERE ${where}`),
        table,
      ).toBe('42501');
    }
  });

  it('PD-07: a non-emancipation authority can never be self-directed (CHECK)', async () => {
    const code = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.authority_record
         (tenant_id, authority_id, version, kind, grantee_person_id, subject_person_id,
          scope, evidence_ref, effective_date, status, decided_by, synthetic)
       VALUES ('northwind-synthetic', 'nar-neg-self', 1, 'guardian-minor', 'np-alex-rivera',
               'np-alex-rivera', '[{"segment":"scheduling","actions":["view"]}]'::jsonb,
               'synthetic-evidence-neg', '2026-03-01', 'pending-verification',
               'synthetic-front-desk-001', true)`,
    );
    expect(code).toBe('23514');
  });

  it('PD-08: time-limited kinds without an expiry are unrepresentable (CHECK)', async () => {
    const code = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.authority_record
         (tenant_id, authority_id, version, kind, grantee_person_id, subject_person_id,
          scope, evidence_ref, effective_date, renewal_owner_ref, status, decided_by, synthetic)
       VALUES ('northwind-synthetic', 'nar-neg-temp', 1, 'temporary-guardianship', 'np-alex-rivera',
               'np-casey-rivera', '[{"segment":"scheduling","actions":["view"]}]'::jsonb,
               'synthetic-evidence-neg', '2026-03-01', 'synthetic-owner-neg',
               'pending-verification', 'synthetic-front-desk-001', true)`,
    );
    expect(code).toBe('23514');
  });

  it('PD-09: an ACTIVE incapacity authority without its triggering determination is unrepresentable (CHECK)', async () => {
    const code = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.authority_record
         (tenant_id, authority_id, version, kind, grantee_person_id, subject_person_id,
          scope, evidence_ref, effective_date, expires_on, verified_by, status, decided_by, synthetic)
       VALUES ('northwind-synthetic', 'nar-neg-incap', 1, 'incapacity-contingent', 'np-alex-rivera',
               'np-jordan-kim', '[{"segment":"scheduling","actions":["view"]}]'::jsonb,
               'synthetic-evidence-neg', '2026-03-01', '2026-09-01',
               'synthetic-front-desk-001', 'active', 'synthetic-front-desk-001', true)`,
    );
    expect(code).toBe('23514');
  });

  it('PD-10: an override cannot name the genetic segment, drop its justification, or shed its review flag (CHECK)', async () => {
    const geneticOverride = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.access_override
         (tenant_id, override_id, staff_account_id, segment, actions, justification,
          approved_by, expires_on, flagged_for_review, status, synthetic)
       VALUES ('northwind-synthetic', 'nov-neg-genetic', 'nsa-morgan-lee', 'genetic', '{view}',
               'synthetic escape hatch attempt', 'synthetic-compliance-officer-001',
               '2026-09-30', true, 'active', true)`,
    );
    expect(geneticOverride).toBe('23514');
    const emptyJustification = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.access_override
         (tenant_id, override_id, staff_account_id, segment, actions, justification,
          approved_by, expires_on, flagged_for_review, status, synthetic)
       VALUES ('northwind-synthetic', 'nov-neg-just', 'nsa-morgan-lee', 'documents', '{view}',
               '', 'synthetic-compliance-officer-001', '2026-09-30', true, 'active', true)`,
    );
    expect(emptyJustification).toBe('23514');
    const unflagged = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.access_override
         (tenant_id, override_id, staff_account_id, segment, actions, justification,
          approved_by, expires_on, flagged_for_review, status, synthetic)
       VALUES ('northwind-synthetic', 'nov-neg-flag', 'nsa-morgan-lee', 'documents', '{view}',
               'synthetic reason', 'synthetic-compliance-officer-001', '2026-09-30', false,
               'active', true)`,
    );
    expect(unflagged).toBe('23514');
  });

  it('PD-11: a flag set without its source, or a correction without evidence, is unrepresentable (CHECK)', async () => {
    const noSource = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.person_flag
         (tenant_id, flag_id, person_id, kind, action, actor_ref, synthetic)
       VALUES ('northwind-synthetic', 'nfl-neg-1', 'np-riley-fox', 'deceased', 'set',
               'synthetic-front-desk-001', true)`,
    );
    expect(noSource).toBe('23514');
    const noEvidence = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.person_flag
         (tenant_id, flag_id, person_id, kind, action, actor_ref, synthetic)
       VALUES ('northwind-synthetic', 'nfl-neg-2', 'np-riley-fox', 'deceased', 'corrected',
               'synthetic-compliance-officer-001', true)`,
    );
    expect(noEvidence).toBe('23514');
  });

  it('PD-12: a needs-classification-review partition tag must be blocked from release (CHECK)', async () => {
    const code = await boundQueryError(
      'northwind-synthetic',
      `INSERT INTO identity.partition_tag
         (tenant_id, tag_id, subject_person_id, artifact_ref, tag, ingest_path,
          review_status, blocked_from_release, synthetic)
       VALUES ('northwind-synthetic', 'npt-neg-1', 'np-alex-rivera', 'synthetic-x',
               'gipa-genetic', 'migration-workbench', 'needs-classification-review', false, true)`,
    );
    expect(code).toBe('23514');
  });

  it('PD-13: cross-tenant composite FKs refuse a foreign subject (23503)', async () => {
    const code = await boundQueryError(
      'riverbend-synthetic',
      `INSERT INTO identity.gipa_authorization
         (tenant_id, authorization_id, subject_person_id, scope_ref, granted_on, expires_on,
          written_evidence_ref, status, synthetic)
       VALUES ('riverbend-synthetic', 'rga-neg-1', 'np-alex-rivera',
               'synthetic-scope-neg', '2026-01-01', '2027-01-01',
               'synthetic-written-neg', 'active', true)`,
    );
    expect(code).toBe('23503');
  });

  it('PD-14: seeded standing proofs — riverbend authority stays unverified; the quarantine row is blocked', async () => {
    const pending = await boundQuery<{ status: string }>(
      'riverbend-synthetic',
      `SELECT status FROM identity.authority_record WHERE authority_id = 'rar-taylor-drew'`,
    );
    expect(pending.rows[0]?.status).toBe('pending-verification');
    const quarantined = await boundQuery<{ blocked: boolean }>(
      'northwind-synthetic',
      `SELECT blocked_from_release AS blocked FROM identity.partition_tag WHERE tag_id = 'npt-0002'`,
    );
    expect(quarantined.rows[0]?.blocked).toBe(true);
  });

  it('PD-15: 0008 re-applies idempotently, and the postures survive a 0004 re-apply (conditional re-REVOKE)', async () => {
    await owner.query(readFileSync(`${repoRoot}modules/identity/migrations/0008-pdp.sql`, 'utf8'));
    await owner.query(
      readFileSync(`${repoRoot}modules/identity/migrations/0004-identity.sql`, 'utf8'),
    );
    // The 0004 schema-wide GRANT ran again — the PDP postures must hold.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE identity.person_flag SET action = 'corrected' WHERE flag_id = 'nfl-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE identity.role_template SET permits = permits WHERE role_key = 'front-desk'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM identity.authority_record WHERE authority_id = 'nar-alex-casey'`,
      ),
    ).toBe('42501');
  });

  it('PD-16: every PDP row carries the synthetic watermark', async () => {
    for (const table of pdpTables) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(*)::text AS count FROM ${table} WHERE synthetic IS DISTINCT FROM true`,
      );
      expect(rows[0]?.count, table).toBe('0');
    }
  });
});
