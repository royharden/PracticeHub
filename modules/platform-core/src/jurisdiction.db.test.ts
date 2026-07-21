/**
 * DB-level jurisdiction suite (WP-011). Proves the rule-pack registry is
 * seeded in sync with the TypeScript data of record, the statutory tables are
 * read-only for the runtime role, and location capture is append-only with
 * divergence retention (R6-SR-001). Requires the app-postgres from
 * compose.yaml (or the CI `tenancy-db` service) on 127.0.0.1:55432.
 *
 * Provisioning is idempotent and self-contained, mirroring the tenancy suite.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { jurisdictionPacksV1 } from './jurisdiction-packs.js';
import { tenantBindingSql } from './rls.js';

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

describe('jurisdiction registry + location capture (DB level)', () => {
  it('REGISTRY-SYNC: the seeded packs match the TypeScript registry of record exactly', async () => {
    // Byte-order (COLLATE "C") on both sides so the comparison is
    // collation-independent across Postgres locale configurations.
    const byteOrder = (left: string, right: string): number =>
      left < right ? -1 : left > right ? 1 : 0;
    // effective_on::text keeps the comparison an ISO-string comparison —
    // timezone-independent, matching the resolver's day-granular UTC basis
    // (ADR-ADJ-002 semantics 5/7: REGISTRY-SYNC covers the column).
    const packRows = await owner.query(
      `SELECT jurisdiction, version, effective_on::text AS effective_on, status,
              counsel_signoff_ref, change_control_ref
         FROM platform_core.jurisdiction_rule_pack
        ORDER BY jurisdiction COLLATE "C", version`,
    );
    const expectedPacks = [...jurisdictionPacksV1]
      .sort((a, b) => byteOrder(a.jurisdiction, b.jurisdiction) || a.version - b.version)
      .map((pack) => ({
        jurisdiction: pack.jurisdiction,
        version: pack.version,
        effective_on: pack.effectiveOn,
        status: pack.status,
        counsel_signoff_ref: pack.counselSignoffRef ?? null,
        change_control_ref: pack.changeControlRef,
      }));
    expect(packRows.rows).toEqual(expectedPacks);

    const ruleRows = await owner.query(
      `SELECT jurisdiction, pack_version, topic, obligations, scalars
         FROM platform_core.jurisdiction_rule
        ORDER BY jurisdiction COLLATE "C", pack_version, topic COLLATE "C"`,
    );
    const expectedRules = [...jurisdictionPacksV1]
      .sort((a, b) => byteOrder(a.jurisdiction, b.jurisdiction) || a.version - b.version)
      .flatMap((pack) =>
        [...pack.rules]
          .sort((a, b) => byteOrder(a.topic, b.topic))
          .map((rule) => ({
            jurisdiction: pack.jurisdiction,
            pack_version: pack.version,
            topic: rule.topic,
            obligations: [...rule.obligations].sort(),
            scalars: rule.scalars ?? {},
          })),
      );
    expect(ruleRows.rows).toEqual(expectedRules);
  });

  it('every seeded pack covers all 12 topics — no topic gaps at the DB either', async () => {
    const incomplete = await owner.query(
      `SELECT count(*)::text AS count FROM platform_core.jurisdiction_rule_pack p
        WHERE (SELECT count(*) FROM platform_core.jurisdiction_rule r
                WHERE r.jurisdiction = p.jurisdiction AND r.pack_version = p.version) <> 12`,
    );
    expect(incomplete.rows[0]?.count).toBe('0');
  });

  it('the runtime role can read the statutory registry from a bound session', async () => {
    const { rows } = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      'SELECT count(*)::text AS count FROM platform_core.jurisdiction_rule_pack',
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(0);
  });

  it('READ-ONLY: the runtime role cannot write the statutory registry (changes are pack versions via change control)', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO platform_core.jurisdiction_rule_pack
           (jurisdiction, version, status, change_control_ref, synthetic)
         VALUES ('NV', 99, 'draft', 'synthetic-ccr-rogue-001', true)`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE platform_core.jurisdiction_rule SET obligations = '[]'::jsonb
          WHERE jurisdiction = 'NV'`,
      ),
    ).toBe('42501');
  });

  it('R6-SR-001: the seeded divergence pair retains BOTH facts with their timestamps', async () => {
    const { rows } = await boundQuery<{
      stage: string;
      state_code: string | null;
      captured_at: Date;
    }>(
      'northwind-synthetic',
      `SELECT stage, state_code, captured_at FROM platform_core.location_capture
        WHERE context_ref = 'synthetic-visit-0001' ORDER BY captured_at`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.stage).toBe('booking');
    expect(rows[0]?.state_code).toBe('NV');
    expect(rows[1]?.stage).toBe('visit-start');
    expect(rows[1]?.state_code).toBe('IL');
    expect(rows[0]?.captured_at).not.toBeNull();
    expect(rows[1]?.captured_at).not.toBeNull();
  });

  it('R6-SR-001: location capture is append-only for the runtime role (divergence cannot be papered over)', async () => {
    await boundQuery(
      'northwind-synthetic',
      `INSERT INTO platform_core.location_capture
         (tenant_id, capture_id, context_ref, stage, state_code, source, synthetic)
       VALUES ('northwind-synthetic', 'cap-db-probe-0001', 'synthetic-visit-db-probe', 'booking',
               'NV', 'synthetic-db-suite', true)
       ON CONFLICT (tenant_id, capture_id) DO NOTHING`,
    );
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE platform_core.location_capture SET state_code = 'FL'
          WHERE capture_id = 'cap-db-probe-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM platform_core.location_capture WHERE capture_id = 'cap-db-probe-0001'`,
      ),
    ).toBe('42501');
    const cleanup = await owner.query(
      `DELETE FROM platform_core.location_capture WHERE capture_id = 'cap-db-probe-0001'`,
    );
    expect(cleanup.rowCount).toBe(1);
  });

  it('cross-tenant: a Northwind-bound session cannot see Riverbend location captures', async () => {
    const { rows } = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS count FROM platform_core.location_capture
        WHERE tenant_id = 'riverbend-synthetic'`,
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('unknown-location seed row: state_code NULL is representable and watermarked', async () => {
    const { rows } = await boundQuery<{ state_code: string | null; synthetic: boolean }>(
      'northwind-synthetic',
      `SELECT state_code, synthetic FROM platform_core.location_capture
        WHERE context_ref = 'synthetic-visit-0003'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state_code).toBeNull();
    expect(rows[0]?.synthetic).toBe(true);
  });

  it('migration idempotency: re-applying 0002-jurisdiction.sql is clean', async () => {
    await expect(
      owner.query(
        readFileSync(`${repoRoot}modules/platform-core/migrations/0002-jurisdiction.sql`, 'utf8'),
      ),
    ).resolves.toBeDefined();
  });
});
