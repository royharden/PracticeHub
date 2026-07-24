/**
 * DB-level vendor-registry suite (WP-026 verification gate). Runs against the
 * local synthetic app-postgres (or the CI service container) on 127.0.0.1:55432.
 * Proves, on the LIVE schema:
 *  - cross-tenant negatives + forced RLS (an unbound session reads zero, cannot
 *    write; a bound session cannot forge another tenant's row);
 *  - the append-only postures (vendor_event + egress_decision never edited or
 *    deleted; vendor + content_license never deleted) and the structural CHECKs;
 *  - the seeded posture at rest (the lapsed vendor is suspended; the AI-uncovered
 *    vendor lacks its no-training clause; the labs vendor is not permitted GEN;
 *    the egress feed carries an allow beside a block-with-incident);
 *  - projection-vs-fold: the seeded vendor projection equals foldVendorRegistry
 *    of the seeded lifecycle log (a materialized read model, not a second truth);
 *  - migration idempotency.
 *
 * Every mutation is either a NEGATIVE (must fail) or is rolled back / cleaned up
 * before the test ends, so the seeded posture the local:test probes assert is
 * never disturbed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  foldVendorRegistry,
  type BaaStatus,
  type PhiCategory,
  type VendorClass,
  type VendorEventKind,
  type VendorRegistryEvent,
} from './vendor-registry.js';

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
  'modules/platform-integration/migrations/0017-vendor-registry.sql',
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/019-vendor-registry-seed.sql',
];

const northwind = 'northwind-synthetic';
const riverbend = 'riverbend-synthetic';

function req<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a value to be present');
  }
  return value;
}

let owner: Client;
let app: Client;

async function boundQuery<T extends Record<string, unknown>>(
  tenantId: string,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  await app.query('BEGIN');
  try {
    await app.query(tenantBindingSql(tenantId));
    const result = await app.query(text, [...params]);
    await app.query('COMMIT');
    return result.rows as T[];
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

/** Run a mutation expected to fail; return the pg error code. */
async function expectFailureCode(
  tenantId: string,
  text: string,
  params: readonly unknown[] = [],
): Promise<string> {
  try {
    await boundQuery(tenantId, text, params);
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code';
  }
  throw new Error('expected the mutation to fail');
}

beforeAll(async () => {
  owner = new Client(ownerConfig);
  await owner.connect();
  for (const file of provisioningFiles) {
    await owner.query(readFileSync(`${repoRoot}${file}`, 'utf8'));
  }
  app = new Client(appConfig);
  await app.connect();
}, 60000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
});

describe('platform_integration RLS + cross-tenant negatives', () => {
  it('VR-01: an unbound app session reads zero vendor rows (fail-closed)', async () => {
    const rows = await app.query('SELECT count(*)::int AS n FROM platform_integration.vendor');
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });

  it('VR-02: a bound session reads ONLY its tenant, never the other', async () => {
    const own = await boundQuery<{ n: number }>(
      northwind,
      'SELECT count(*)::int AS n FROM platform_integration.vendor',
    );
    expect(req(own[0]).n).toBeGreaterThan(0);
    const cross = await boundQuery<{ n: number }>(
      northwind,
      `SELECT count(*)::int AS n FROM platform_integration.vendor WHERE tenant_id = '${riverbend}'`,
    );
    expect(req(cross[0]).n).toBe(0);
  });

  it('VR-03: forging another tenant on insert is refused by the RLS WITH CHECK', async () => {
    const code = await expectFailureCode(
      northwind,
      `INSERT INTO platform_integration.egress_decision
         (tenant_id, decision_id, vendor_id, decision, phi_class, categories, reason, incident_opened, synthetic)
       VALUES ('${riverbend}', 'vr-forge', 'synthetic-x', 'deny', 'PHI', '{}', 'no-registry-row', true, true)`,
    );
    expect(code).toBe('42501');
  });
});

describe('platform_integration append-only + no-delete postures', () => {
  it('VR-04: vendor_event cannot be UPDATEd or DELETEd (append-only)', async () => {
    expect(
      await expectFailureCode(
        northwind,
        "UPDATE platform_integration.vendor_event SET kind = 'suspended'",
      ),
    ).toBe('42501');
    expect(
      await expectFailureCode(northwind, 'DELETE FROM platform_integration.vendor_event'),
    ).toBe('42501');
  });

  it('VR-05: egress_decision cannot be UPDATEd or DELETEd (append-only feed)', async () => {
    expect(
      await expectFailureCode(
        northwind,
        "UPDATE platform_integration.egress_decision SET decision = 'allow'",
      ),
    ).toBe('42501');
    expect(
      await expectFailureCode(northwind, 'DELETE FROM platform_integration.egress_decision'),
    ).toBe('42501');
  });

  it('VR-06: the vendor + content_license projections cannot be DELETEd', async () => {
    expect(await expectFailureCode(northwind, 'DELETE FROM platform_integration.vendor')).toBe(
      '42501',
    );
    expect(
      await expectFailureCode(northwind, 'DELETE FROM platform_integration.content_license'),
    ).toBe('42501');
  });
});

describe('platform_integration structural CHECKs', () => {
  it('VR-07: an executed vendor with no BAA dates is refused (ambiguous is unrepresentable)', async () => {
    const code = await expectFailureCode(
      northwind,
      `INSERT INTO platform_integration.vendor
         (tenant_id, vendor_id, vendor_class, is_ai_vendor, enforcement_point, baa_status,
          permitted_categories, status, version, synthetic)
       VALUES ('${northwind}', 'vr-bad', 'labs', false, 'x', 'executed', '{}', 'active', 1, true)`,
    );
    expect(code).toBe('23514');
  });

  it('VR-08: an inverted BAA window is refused', async () => {
    const code = await expectFailureCode(
      northwind,
      `INSERT INTO platform_integration.vendor
         (tenant_id, vendor_id, vendor_class, is_ai_vendor, enforcement_point, baa_status,
          baa_effective, baa_expiry, permitted_categories, status, version, synthetic)
       VALUES ('${northwind}', 'vr-bad', 'labs', false, 'x', 'executed', '2027-01-01', '2026-01-01', '{}', 'active', 1, true)`,
    );
    expect(code).toBe('23514');
  });

  it('VR-09: a permission-increasing event with no compliance sign-off is refused', async () => {
    const code = await expectFailureCode(
      northwind,
      `INSERT INTO platform_integration.vendor_event
         (tenant_id, vendor_id, version, kind, baa_status, baa_effective, baa_expiry, synthetic)
       VALUES ('${northwind}', 'vr-bad', 9, 'baa-executed', 'executed', '2026-01-05', '2027-01-05', true)`,
    );
    expect(code).toBe('23514');
  });

  it('VR-10: a content_license active without dates is refused', async () => {
    const code = await expectFailureCode(
      northwind,
      `INSERT INTO platform_integration.content_license
         (tenant_id, license_id, content_family, status, rights_ref, checksum, synthetic)
       VALUES ('${northwind}', 'vr-bad-lic', 'cpt', 'active', 'synthetic-license:x', '${'a'.repeat(64)}', true)`,
    );
    expect(code).toBe('23514');
  });

  it('VR-11: a PHI category outside the closed vocabulary is refused', async () => {
    const code = await expectFailureCode(
      northwind,
      `INSERT INTO platform_integration.vendor
         (tenant_id, vendor_id, vendor_class, is_ai_vendor, enforcement_point, baa_status,
          baa_effective, baa_expiry, permitted_categories, status, version, synthetic)
       VALUES ('${northwind}', 'vr-bad', 'labs', false, 'x', 'executed', '2026-01-05', '2027-01-05',
               ARRAY['NOPE']::text[], 'active', 1, true)`,
    );
    expect(code).toBe('23514');
  });
});

describe('platform_integration seeded posture + projection sync', () => {
  it('VR-12: the lapsed vendor is suspended, the AI-uncovered vendor lacks its no-training clause, labs has no GEN', async () => {
    const rows = await boundQuery<{
      vendor_id: string;
      status: string;
      no_training_on_phi: boolean;
      permitted_categories: string[];
    }>(
      northwind,
      `SELECT vendor_id, status, no_training_on_phi, permitted_categories
         FROM platform_integration.vendor
        WHERE vendor_id IN ('synthetic-lapsed-vendor', 'synthetic-ai-uncovered', 'synthetic-labs-vendor')
        ORDER BY vendor_id`,
    );
    const byId = new Map(rows.map((row) => [row.vendor_id, row]));
    expect(req(byId.get('synthetic-lapsed-vendor')).status).toBe('suspended');
    expect(req(byId.get('synthetic-ai-uncovered')).no_training_on_phi).toBe(false);
    expect(req(byId.get('synthetic-labs-vendor')).permitted_categories).not.toContain('GEN');
  });

  it('VR-13: the seeded egress feed carries one allow and one block-with-incident', async () => {
    const rows = await boundQuery<{ decision: string; incident_opened: boolean }>(
      northwind,
      'SELECT decision, incident_opened FROM platform_integration.egress_decision ORDER BY decision_id',
    );
    expect(rows.some((row) => row.decision === 'allow' && !row.incident_opened)).toBe(true);
    expect(rows.some((row) => row.decision === 'deny' && row.incident_opened)).toBe(true);
  });

  it('VR-14: the seeded vendor projection equals the fold of the seeded lifecycle log', async () => {
    const eventRows = await boundQuery<{
      tenant_id: string;
      vendor_id: string;
      version: number;
      kind: string;
      vendor_class: string | null;
      is_ai_vendor: boolean | null;
      enforcement_point: string | null;
      baa_status: string | null;
      baa_effective: string | null;
      baa_expiry: string | null;
      no_training_on_phi: boolean | null;
      zero_retention: boolean | null;
      permitted_categories: string[] | null;
      approved_by: string | null;
    }>(
      northwind,
      `SELECT tenant_id, vendor_id, version, kind, vendor_class, is_ai_vendor, enforcement_point,
              baa_status, baa_effective::text AS baa_effective, baa_expiry::text AS baa_expiry,
              no_training_on_phi, zero_retention, permitted_categories, approved_by
         FROM platform_integration.vendor_event ORDER BY vendor_id, version`,
    );
    const events: VendorRegistryEvent[] = eventRows.map((row) => ({
      tenantId: row.tenant_id,
      vendorId: row.vendor_id,
      version: row.version,
      kind: row.kind as VendorEventKind,
      ...(row.vendor_class !== null ? { vendorClass: row.vendor_class as VendorClass } : {}),
      ...(row.is_ai_vendor !== null ? { isAiVendor: row.is_ai_vendor } : {}),
      ...(row.enforcement_point !== null ? { enforcementPoint: row.enforcement_point } : {}),
      ...(row.baa_status !== null ? { baaStatus: row.baa_status as BaaStatus } : {}),
      ...(row.baa_effective !== null ? { baaEffective: row.baa_effective } : {}),
      ...(row.baa_expiry !== null ? { baaExpiry: row.baa_expiry } : {}),
      ...(row.no_training_on_phi !== null ? { noTrainingOnPhi: row.no_training_on_phi } : {}),
      ...(row.zero_retention !== null ? { zeroRetention: row.zero_retention } : {}),
      ...(row.permitted_categories !== null
        ? { permittedCategories: row.permitted_categories as PhiCategory[] }
        : {}),
      ...(row.approved_by !== null ? { approvedBy: row.approved_by } : {}),
      occurredAt: '2026-01-01T00:00:00Z',
      synthetic: true,
    }));
    const folded = foldVendorRegistry(events);

    const projectionRows = await boundQuery<{
      vendor_id: string;
      baa_status: string;
      status: string;
      version: number;
      permitted_categories: string[];
      no_training_on_phi: boolean;
    }>(
      northwind,
      `SELECT vendor_id, baa_status, status, version, permitted_categories, no_training_on_phi
         FROM platform_integration.vendor WHERE tenant_id = '${northwind}' ORDER BY vendor_id`,
    );
    for (const projection of projectionRows) {
      const row = req(folded.get(`${northwind}|${projection.vendor_id}`));
      expect(row.baaStatus).toBe(projection.baa_status);
      expect(row.status).toBe(projection.status);
      expect(row.version).toBe(projection.version);
      expect([...row.permittedCategories].sort()).toEqual(
        [...projection.permitted_categories].sort(),
      );
      expect(row.noTrainingOnPhi).toBe(projection.no_training_on_phi);
    }
  });

  it('VR-15: every seeded row carries the synthetic watermark', async () => {
    for (const table of ['vendor', 'vendor_event', 'egress_decision', 'content_license']) {
      const rows = await boundQuery<{ n: number }>(
        northwind,
        `SELECT count(*)::int AS n FROM platform_integration.${table} WHERE synthetic IS DISTINCT FROM true`,
      );
      expect(req(rows[0]).n).toBe(0);
    }
  });
});

describe('platform_integration migration idempotency', () => {
  it('VR-16: 0017 re-applies cleanly, and 0001 re-applies after 0017', async () => {
    await owner.query(
      readFileSync(
        `${repoRoot}modules/platform-integration/migrations/0017-vendor-registry.sql`,
        'utf8',
      ),
    );
    await owner.query(
      readFileSync(`${repoRoot}modules/platform-core/migrations/0001-tenancy.sql`, 'utf8'),
    );
    // The seeded posture survives the re-apply (append-only grants re-asserted).
    const rows = await boundQuery<{ n: number }>(
      northwind,
      'SELECT count(*)::int AS n FROM platform_integration.vendor',
    );
    expect(req(rows[0]).n).toBeGreaterThan(0);
  });
});
