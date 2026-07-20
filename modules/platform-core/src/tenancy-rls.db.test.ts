/**
 * DB-level cross-tenant negative suite (WP-010 verification gate). Derived
 * from docs/architecture/tenancy-partition-threat-model.md — test titles carry
 * the threat ids. Requires the app-postgres from compose.yaml (or the CI
 * `tenancy-db` service) on 127.0.0.1:55432.
 *
 * The suite provisions its own schema state by applying the bootstrap SQL,
 * the platform_core migration, and both seed files as the database owner —
 * idempotent by construction, so re-running against the live local stack is
 * itself the migration idempotency proof.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateRlsCoverageGuard, platformCoreRlsSpecs, tenantBindingSql } from './rls.js';

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
  'modules/platform-core/migrations/0002-jurisdiction.sql',
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/004-jurisdiction-seed.sql',
];

const tenantScopedTables = platformCoreRlsSpecs
  .filter((spec) => spec.kind === 'tenant-scoped')
  .map((spec) => `${spec.schema}.${spec.table}`);

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

describe('tenancy RLS cross-tenant negative suite (DB level)', () => {
  it('positive control: a Northwind-bound session reads Northwind rows and can write in-tenant', async () => {
    for (const table of tenantScopedTables) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(Number(rows[0]?.count), `${table} should show Northwind rows`).toBeGreaterThan(0);
    }
    await boundQuery(
      'northwind-synthetic',
      `INSERT INTO platform_core.tenant_config
         (tenant_id, namespace, key, value, phi_class, counsel_owned, revision, changed_by, synthetic)
       VALUES ('northwind-synthetic', 'template', 'db-suite-probe', '"probe"'::jsonb, 'none', false, 1,
               'synthetic-db-suite', true)
       ON CONFLICT ON CONSTRAINT tenant_config_scope_key DO UPDATE SET value = EXCLUDED.value`,
    );
    const { rowCount } = await boundQuery(
      'northwind-synthetic',
      `DELETE FROM platform_core.tenant_config WHERE key = 'db-suite-probe'`,
    );
    expect(rowCount).toBe(1);
  });

  it('T-01: a Northwind-bound session reads zero Riverbend rows in every tenant-scoped table', async () => {
    for (const table of tenantScopedTables) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(*)::text AS count FROM ${table} WHERE tenant_id = 'riverbend-synthetic'`,
      );
      expect(rows[0]?.count, `${table} must hide Riverbend from Northwind`).toBe('0');
    }
  });

  it('T-02: a Northwind-bound INSERT carrying a Riverbend tenant_id is rejected by policy', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO platform_core.tenant (tenant_id, display_name, status, synthetic)
         VALUES ('riverbend-forged', 'Forged Synthetic', 'active', true)`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO platform_core.tenant_config
           (tenant_id, namespace, key, value, phi_class, counsel_owned, revision, changed_by, synthetic)
         VALUES ('riverbend-synthetic', 'branding', 'display-name', '"Forged"'::jsonb, 'none', false, 9,
                 'synthetic-db-suite', true)`,
      ),
    ).toBe('42501');
  });

  it('T-03: Northwind-bound UPDATE and DELETE against Riverbend rows affect nothing', async () => {
    const update = await boundQuery(
      'northwind-synthetic',
      `UPDATE platform_core.tenant SET display_name = 'Hijacked' WHERE tenant_id = 'riverbend-synthetic'`,
    );
    expect(update.rowCount).toBe(0);
    const remove = await boundQuery(
      'northwind-synthetic',
      `DELETE FROM platform_core.tenant_config WHERE tenant_id = 'riverbend-synthetic'`,
    );
    expect(remove.rowCount).toBe(0);
    const intact = await owner.query(
      `SELECT display_name FROM platform_core.tenant WHERE tenant_id = 'riverbend-synthetic'`,
    );
    expect(intact.rows[0]?.display_name).toBe('Riverbend Synthetic');
  });

  it('T-04: an unbound session reads zero rows everywhere and cannot write', async () => {
    for (const table of tenantScopedTables) {
      const result = await app.query(`SELECT count(*)::text AS count FROM ${table}`);
      expect(result.rows[0]?.count, `${table} must be empty without a binding`).toBe('0');
    }
    await expect(
      app.query(
        `INSERT INTO platform_core.tenant (tenant_id, display_name, status, synthetic)
         VALUES ('northwind-synthetic-unbound', 'Unbound Synthetic', 'active', true)`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('T-05: the tenant binding does not survive its transaction', async () => {
    const during = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      'SELECT count(*)::text AS count FROM platform_core.tenant',
    );
    expect(Number(during.rows[0]?.count)).toBeGreaterThan(0);
    const after = await app.query('SELECT count(*)::text AS count FROM platform_core.tenant');
    expect(after.rows[0]?.count).toBe('0');
  });

  it('T-06: the runtime role cannot escape RLS and owns nothing; every table forces RLS', async () => {
    const role = await owner.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'practicehub_app'`,
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await owner.query(
      `SELECT count(*)::text AS count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'platform_core' AND pg_get_userbyid(c.relowner) = 'practicehub_app'`,
    );
    expect(owned.rows[0]?.count).toBe('0');
    const unforced = await owner.query(
      `SELECT count(*)::text AS count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'platform_core' AND c.relkind = 'r'
          AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`,
    );
    expect(unforced.rows[0]?.count).toBe('0');
  });

  it('T-07b: an undeclared table makes the coverage guard raise until it is removed', async () => {
    const guard = generateRlsCoverageGuard('platform_core', platformCoreRlsSpecs);
    await owner.query('CREATE TABLE IF NOT EXISTS platform_core.rogue_decoy (tenant_id text)');
    try {
      await expect(owner.query(guard)).rejects.toThrow(/rls coverage failure.*rogue_decoy/);
    } finally {
      await owner.query('DROP TABLE IF EXISTS platform_core.rogue_decoy');
    }
    await expect(owner.query(guard)).resolves.toBeDefined();
  });

  it("T-08b: a Northwind location cannot reference Riverbend's legal entity (composite FK)", async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO platform_core.location
           (tenant_id, location_id, legal_entity_id, name, state_code, kind, synthetic)
         VALUES ('northwind-synthetic', 'northwind-forged-loc', 'riverbend-medical-il',
                 'Forged Synthetic Location', 'IL', 'physical', true)`,
      ),
    ).toBe('23503');
  });

  it('T-09b: Riverbend branding is unreadable from a Northwind-bound session (brand leak)', async () => {
    const byTenant = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS count FROM platform_core.tenant_config
        WHERE tenant_id = 'riverbend-synthetic' AND namespace = 'branding'`,
    );
    expect(byTenant.rows[0]?.count).toBe('0');
    const byValue = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS count FROM platform_core.tenant_config
        WHERE value = '"Riverbend Health (Synthetic)"'::jsonb`,
    );
    expect(byValue.rows[0]?.count).toBe('0');
  });

  it('T-10b: config classed above the ceiling violates the table CHECK', async () => {
    await expect(
      owner.query(
        `INSERT INTO platform_core.tenant_config
           (tenant_id, namespace, key, value, phi_class, counsel_owned, revision, changed_by, synthetic)
         VALUES ('northwind-synthetic', 'template', 'phi-probe', '"x"'::jsonb, 'PHI', false, 1,
                 'synthetic-db-suite', true)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('T-11b: a counsel-owned config row without change control violates the CHECK', async () => {
    await expect(
      owner.query(
        `INSERT INTO platform_core.tenant_config
           (tenant_id, namespace, key, value, phi_class, counsel_owned, revision, changed_by, synthetic)
         VALUES ('northwind-synthetic', 'disclosure', 'counsel-probe', '"x"'::jsonb, 'none', true, 1,
                 'synthetic-db-suite', true)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('REQ-ADM-027 AC-3: tenant_config writes are timestamped and attributed', async () => {
    await expect(
      owner.query(
        `INSERT INTO platform_core.tenant_config
           (tenant_id, namespace, key, value, phi_class, counsel_owned, revision, synthetic)
         VALUES ('northwind-synthetic', 'template', 'attribution-probe', '"x"'::jsonb, 'none', false, 1, true)`,
      ),
    ).rejects.toMatchObject({ code: '23502' });
    const inserted = await owner.query(
      `INSERT INTO platform_core.tenant_config
         (tenant_id, namespace, key, value, phi_class, counsel_owned, revision, changed_by, synthetic)
       VALUES ('northwind-synthetic', 'template', 'attribution-probe', '"x"'::jsonb, 'none', false, 1,
               'synthetic-practice-manager-001', true)
       RETURNING changed_at, changed_by`,
    );
    expect(inserted.rows[0]?.changed_by).toBe('synthetic-practice-manager-001');
    expect(inserted.rows[0]?.changed_at).not.toBeNull();
    const removed = await owner.query(
      `DELETE FROM platform_core.tenant_config WHERE key = 'attribution-probe'`,
    );
    expect(removed.rowCount).toBe(1);
  });

  it('T-12b: a CPOM entity without counsel ratification violates the CHECK (R6-SR-110)', async () => {
    await expect(
      owner.query(
        `INSERT INTO platform_core.legal_entity
           (tenant_id, legal_entity_id, name, entity_type, cpom_state, counsel_ratification_ref, synthetic)
         VALUES ('northwind-synthetic', 'northwind-forged-entity', 'Forged Synthetic PLLC', 'PLLC', 'NV', NULL, true)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('migration idempotency: re-applying 0001-tenancy.sql is clean', async () => {
    await expect(
      owner.query(
        readFileSync(`${repoRoot}modules/platform-core/migrations/0001-tenancy.sql`, 'utf8'),
      ),
    ).resolves.toBeDefined();
  });

  it('synthetic watermark: every seeded tenancy row is watermarked', async () => {
    for (const table of tenantScopedTables) {
      const result = await owner.query(
        `SELECT count(*)::text AS count FROM ${table} WHERE synthetic IS DISTINCT FROM true`,
      );
      expect(result.rows[0]?.count, `${table} must hold only synthetic rows locally`).toBe('0');
    }
  });
});
