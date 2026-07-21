/**
 * DB-level identity suite (WP-013 verification gate). Cross-tenant negatives
 * on the identity schema, the shared-endpoint standing proof, crosswalk
 * uniqueness, opaque payment refs, proxy/evidence CHECK constraints, and the
 * append-only timeline. Requires the app-postgres from compose.yaml (or the
 * CI service container) on 127.0.0.1:55432.
 *
 * The suite provisions its own schema state by applying the bootstrap SQL,
 * the platform_core tenancy migration, the identity migration, and the seed
 * files as the database owner — idempotent by construction, so re-running
 * against the live local stack is itself the migration idempotency proof.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { generateRlsCoverageGuard, tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { identityRlsSpecs, identitySchemaRlsSpecs } from './rls-specs.js';

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
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/006-identity-seed.sql',
];

const identityTables = identityRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`);

let owner: Client;
let app: Client;

async function boundQuery<T extends Record<string, unknown>>(
  tenantId: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<{ rows: T[]; rowCount: number }> {
  await app.query('BEGIN');
  try {
    await app.query(tenantBindingSql(tenantId));
    const result = await app.query(sql, [...params]);
    await app.query('COMMIT');
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
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

async function ownerQueryError(sql: string): Promise<string> {
  try {
    await owner.query(sql);
  } catch (error) {
    await owner.query('ROLLBACK').catch(() => undefined);
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

describe('identity schema DB suite (WP-013)', () => {
  it('I-01 positive control: a Northwind-bound session reads Northwind rows in every identity table', async () => {
    for (const table of identityTables) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(Number(rows[0]?.count), `${table} should show Northwind rows`).toBeGreaterThan(0);
    }
  });

  it('I-02: a Northwind-bound session reads zero Riverbend rows in every identity table', async () => {
    for (const table of identityTables) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id = 'riverbend-synthetic'`,
      );
      expect(rows[0]?.count, `${table} must hide Riverbend from Northwind`).toBe('0');
    }
  });

  it('I-03: a Northwind-bound INSERT carrying the Riverbend tenant is rejected by policy', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.person
           (tenant_id, person_id, status, provenance_source, captured_by, synthetic)
         VALUES ('riverbend-synthetic', 'np-forged', 'provisional', 'synthetic-forge',
                 'synthetic-db-suite', true)`,
      ),
    ).toBe('42501');
  });

  it('I-04: an unbound session reads zero identity rows and cannot write', async () => {
    for (const table of identityTables) {
      const result = await app.query(`SELECT count(*)::text AS count FROM ${table}`);
      expect(result.rows[0]?.count, `${table} must be empty without a binding`).toBe('0');
    }
    await expect(
      app.query(
        `INSERT INTO identity.person
           (tenant_id, person_id, status, provenance_source, captured_by, synthetic)
         VALUES ('northwind-synthetic', 'np-unbound', 'provisional', 'synthetic-forge',
                 'synthetic-db-suite', true)`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('I-05: cross-tenant composite FK is unrepresentable — Northwind record cannot attach to a Riverbend entity', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.patient_record
           (tenant_id, patient_record_id, person_id, legal_entity_id, status, synthetic)
         VALUES ('northwind-synthetic', 'npr-forged', 'np-jordan-kim', 'riverbend-medical-il',
                 'active', true)`,
      ),
    ).toBe('23503');
  });

  it('I-06: live RLS coverage — every identity table has enabled+forced RLS and passes the generated guard', async () => {
    const unprotected = await owner.query(
      `SELECT count(*)::text AS count FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'identity' AND c.relkind = 'r'
         AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`,
    );
    expect(unprotected.rows[0]?.count).toBe('0');
    // Schema-wide registry, not this migration's DDL scope: the guard must
    // accept every declared identity table (WP-011 guard-vs-DDL split; the
    // WP-014 authn tables share the schema).
    await owner.query(generateRlsCoverageGuard('identity', identitySchemaRlsSpecs));
  });

  it('I-07: the identity timeline is append-only for the runtime role', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE identity.identity_timeline SET detail = 'rewritten' WHERE entry_id = 'nti-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM identity.identity_timeline WHERE entry_id = 'nti-0001'`,
      ),
    ).toBe('42501');
  });

  it('I-08: the crosswalk maps each source id to at most one person — duplicates are unrepresentable', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.source_identifier
           (tenant_id, source_system, source_value, person_id, verification, provenance_source, synthetic)
         VALUES ('northwind-synthetic', 'athena', 'ath-100234', 'np-jordan-kim', 'asserted',
                 'synthetic-forge', true)`,
      ),
    ).toBe('23505');
  });

  it('I-09: a payment-rail source value carrying contact or date detail is rejected by CHECK', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.source_identifier
           (tenant_id, source_system, source_value, person_id, verification, provenance_source, synthetic)
         VALUES ('northwind-synthetic', 'stripe', 'alex@synthetic.invalid', 'np-alex-rivera',
                 'asserted', 'synthetic-forge', true)`,
      ),
    ).toBe('23514');
  });

  it('I-10: proxy grants are scoped and expiring by construction', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.proxy_grant
           (tenant_id, proxy_grant_id, grantee_person_id, subject_person_id, scope,
            evidence_ref, status, synthetic)
         VALUES ('northwind-synthetic', 'npx-unbounded', 'np-alex-rivera', 'np-jordan-kim',
                 '{scheduling}', 'synthetic-evidence', 'active', true)`,
      ),
    ).toBe('23502');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.proxy_grant
           (tenant_id, proxy_grant_id, grantee_person_id, subject_person_id, scope,
            expires_on, evidence_ref, status, synthetic)
         VALUES ('northwind-synthetic', 'npx-self', 'np-alex-rivera', 'np-alex-rivera',
                 '{scheduling}', '2029-06-02', 'synthetic-evidence', 'active', true)`,
      ),
    ).toBe('23514');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.proxy_grant
           (tenant_id, proxy_grant_id, grantee_person_id, subject_person_id, scope,
            expires_on, evidence_ref, status, synthetic)
         VALUES ('northwind-synthetic', 'npx-unscoped', 'np-alex-rivera', 'np-jordan-kim',
                 '{}', '2029-06-02', 'synthetic-evidence', 'active', true)`,
      ),
    ).toBe('23514');
  });

  it('I-11: a verified person without identity-proofing evidence is unrepresentable', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO identity.person
           (tenant_id, person_id, status, provenance_source, captured_by, synthetic)
         VALUES ('northwind-synthetic', 'np-unevidenced', 'verified', 'synthetic-forge',
                 'synthetic-db-suite', true)`,
      ),
    ).toBe('23514');
  });

  it('I-12: shared-endpoint standing proof — two distinct persons per shared endpoint, never merged', async () => {
    for (const endpointId of ['nce-rivera-phone', 'nce-rivera-email']) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(DISTINCT person_id)::text AS count FROM identity.endpoint_association
          WHERE endpoint_id = '${endpointId}'`,
      );
      expect(rows[0]?.count, `${endpointId} must attach two distinct persons`).toBe('2');
    }
    const persons = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS count FROM identity.person
        WHERE person_id IN ('np-alex-rivera', 'np-casey-rivera')`,
    );
    expect(persons.rows[0]?.count).toBe('2');
  });

  it('I-13: one patient record per person per tenant — a second record is unrepresentable', async () => {
    expect(
      await ownerQueryError(
        `INSERT INTO identity.patient_record
           (tenant_id, patient_record_id, person_id, legal_entity_id, status, synthetic)
         VALUES ('northwind-synthetic', 'npr-alex-second', 'np-alex-rivera', 'northwind-health-nv',
                 'active', true)`,
      ),
    ).toBe('23505');
  });

  it('I-14: every seeded identity row carries the synthetic watermark', async () => {
    for (const table of identityTables) {
      const result = await owner.query(
        `SELECT count(*)::text AS count FROM ${table} WHERE synthetic IS DISTINCT FROM true`,
      );
      expect(result.rows[0]?.count, `${table} must be fully watermarked`).toBe('0');
    }
  });

  it('I-15: migrations stay idempotent in cross-module order — 0004 re-applies, then 0001 re-applies after it', async () => {
    await owner.query(
      readFileSync(`${repoRoot}modules/identity/migrations/0004-identity.sql`, 'utf8'),
    );
    await owner.query(
      readFileSync(`${repoRoot}modules/platform-core/migrations/0001-tenancy.sql`, 'utf8'),
    );
    const guard = await owner.query(
      `SELECT count(*)::text AS count FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('identity', 'platform_core') AND c.relkind = 'r'
         AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`,
    );
    expect(guard.rows[0]?.count).toBe('0');
  });
});
