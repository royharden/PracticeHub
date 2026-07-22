/**
 * DB-level policy/clock suite (WP-019 verification gate). Cross-tenant negatives,
 * the append-only reference registries + clock event log, the structural CHECKs
 * (duration-basis, trigger-has-due, satisfy/closure evidence, escalate-not-after-due),
 * the projection FK, effective-dated content at rest, and the C-05 obligation ×
 * jurisdiction proof (FL 30-day breach clock beats the federal 60-day floor).
 * Requires the app-postgres from compose.yaml (or the CI service container).
 *
 * Every forged INSERT is a NEGATIVE (must fail); positive controls read the
 * SEEDED rows, so the state the local:test probes assert is never disturbed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { policyClockRlsSpecs } from './rls-specs.js';

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
  'modules/consent/migrations/0009-consent.sql',
  'modules/consent/migrations/0011-policy-clocks.sql',
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/013-policy-clocks-seed.sql',
];

const allClockTables = policyClockRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`);
const tenantScopedTables = policyClockRlsSpecs
  .filter((spec) => spec.kind === 'tenant-scoped')
  .map((spec) => `${spec.schema}.${spec.table}`);

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
    clock_event_id: `'${id}'`,
    clock_id: `'clk-db-forge'`,
    obligation_type: `'records-request-closure'`,
    kind: `'trigger'`,
    subject_ref: `'np-db-forge'`,
    occurred_at: `'2026-03-01T00:00:00Z'`,
    due_at: `'2026-03-31T00:00:00Z'`,
    actor_ref: `'synthetic-clock'`,
    synthetic: 'true',
    ...overrides,
  };
  const columns = Object.keys(fields).join(', ');
  const values = Object.values(fields).join(', ');
  return `INSERT INTO consent.obligation_clock_event (${columns}) VALUES (${values})`;
}

function forgedPolicy(overrides: Readonly<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    obligation_type: `'breach-notification'`,
    jurisdiction: `'FL'`,
    version: '99',
    effective_on: `DATE '2026-01-01'`,
    status: `'draft'`,
    change_control_ref: `'wp-019-db-forge'`,
    duration_days: '30',
    escalation_lead_days: '10',
    source_ref: `'synthetic-source'`,
    synthetic: 'true',
    ...overrides,
  };
  const columns = Object.keys(fields).join(', ');
  const values = Object.values(fields).join(', ');
  return `INSERT INTO consent.obligation_clock_policy (${columns}) VALUES (${values})`;
}

function forgedClock(overrides: Readonly<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    tenant_id: `'northwind-synthetic'`,
    clock_id: `'clk-db-forge'`,
    obligation_type: `'records-request-closure'`,
    subject_ref: `'np-db-forge'`,
    trigger_ref: `'records-request:forge'`,
    triggered_at: `'2026-03-01T00:00:00Z'`,
    due_at: `'2026-03-31T00:00:00Z'`,
    escalate_at: `'2026-03-21T00:00:00Z'`,
    status: `'pending'`,
    owner_role: `'compliance'`,
    last_event_id: `'ncle-0006'`,
    synthetic: 'true',
    ...overrides,
  };
  const columns = Object.keys(fields).join(', ');
  const values = Object.values(fields).join(', ');
  return `INSERT INTO consent.obligation_clock (${columns}) VALUES (${values})`;
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

describe('policy/clock DB suite (WP-019)', () => {
  it('PC-01 positive control: a Northwind-bound session reads its clock rows', async () => {
    for (const table of allClockTables) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(Number(rows[0]?.count), `${table} should show rows`).toBeGreaterThan(0);
    }
  });

  it('PC-02 cross-tenant reads come back empty in both directions', async () => {
    const fromNorthwind = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS count FROM consent.obligation_clock WHERE tenant_id = 'riverbend-synthetic'`,
    );
    expect(fromNorthwind.rows[0]?.count).toBe('0');
    const fromRiverbend = await boundQuery<{ count: string }>(
      'riverbend-synthetic',
      `SELECT count(*)::text AS count FROM consent.obligation_clock WHERE clock_id = 'ncl-breach-0001'`,
    );
    expect(fromRiverbend.rows[0]?.count).toBe('0');
  });

  it('PC-03 a Northwind-bound INSERT carrying the Riverbend tenant is rejected by policy', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('pdbf-0001', { tenant_id: `'riverbend-synthetic'` }),
      ),
    ).toBe('42501');
  });

  it('PC-04 the reference registries + event log are append-only; the projection never deletes', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE consent.obligation_clock_event SET kind = 'satisfy' WHERE clock_event_id = 'ncle-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM consent.obligation_clock_event WHERE clock_event_id = 'ncle-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM consent.policy_document WHERE tenant_id = 'northwind-synthetic'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM consent.obligation_clock_policy WHERE obligation_type = 'breach-notification'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM consent.obligation_clock WHERE clock_id = 'ncl-mhra-0001'`,
      ),
    ).toBe('42501');
  });

  it('PC-05 the structural clock CHECKs are enforced (23514)', async () => {
    // an mhra-renewal policy carrying a duration is unrepresentable (anchor-basis).
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedPolicy({
          obligation_type: `'mhra-renewal'`,
          jurisdiction: `'MN'`,
          duration_days: '30',
        }),
      ),
    ).toBe('23514');
    // a duration-basis policy with no duration is unrepresentable.
    expect(
      await boundQueryError('northwind-synthetic', forgedPolicy({ duration_days: 'NULL' })),
    ).toBe('23514');
    // a trigger event must name its computed deadline.
    expect(
      await boundQueryError('northwind-synthetic', forgedEvent('pdbf-0002', { due_at: 'NULL' })),
    ).toBe('23514');
    // a satisfy event must carry evidence-of-completion.
    expect(
      await boundQueryError('northwind-synthetic', forgedEvent('pdbf-0003', { kind: `'satisfy'` })),
    ).toBe('23514');
    // a satisfied clock must carry closure evidence.
    expect(
      await boundQueryError('northwind-synthetic', forgedClock({ status: `'satisfied'` })),
    ).toBe('23514');
    // escalate_at may never be after due_at.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedClock({ escalate_at: `'2026-04-15T00:00:00Z'` }),
      ),
    ).toBe('23514');
    // a bad obligation_type enum.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('pdbf-0004', { obligation_type: `'foo'` }),
      ),
    ).toBe('23514');
  });

  it('PC-06 the clock projection FK requires an existing same-tenant event', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedClock({ clock_id: `'clk-db-orphan'`, last_event_id: `'ncle-missing'` }),
      ),
    ).toBe('23503');
  });

  it('PC-07 every seeded clock row carries the synthetic watermark', async () => {
    for (const table of allClockTables) {
      const result = await owner.query(
        `SELECT count(*)::text AS count FROM ${table} WHERE synthetic IS DISTINCT FROM true`,
      );
      expect(result.rows[0]?.count, `${table} must be fully watermarked`).toBe('0');
    }
  });

  it('PC-08 idempotency: 0011 re-applies, 0009 re-applies after it, 0001 re-applies, postures hold', async () => {
    await owner.query(
      readFileSync(`${repoRoot}modules/consent/migrations/0011-policy-clocks.sql`, 'utf8'),
    );
    await owner.query(
      readFileSync(`${repoRoot}modules/consent/migrations/0009-consent.sql`, 'utf8'),
    );
    await owner.query(
      readFileSync(`${repoRoot}modules/platform-core/migrations/0001-tenancy.sql`, 'utf8'),
    );
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE consent.obligation_clock_event SET kind = 'cancel' WHERE clock_event_id = 'ncle-0001'`,
      ),
    ).toBe('42501');
  });

  it('PC-09 forced RLS is live; an unbound session reads zero tenant-scoped rows and cannot write', async () => {
    const unprotected = await owner.query(
      `SELECT count(*)::text AS count FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'consent' AND c.relkind = 'r'
         AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`,
    );
    expect(unprotected.rows[0]?.count).toBe('0');
    for (const table of tenantScopedTables) {
      const result = await app.query(`SELECT count(*)::text AS count FROM ${table}`);
      expect(result.rows[0]?.count, `${table} must be empty without a binding`).toBe('0');
    }
    await expect(app.query(forgedEvent('pdbf-unbound'))).rejects.toMatchObject({ code: '42501' });
  });

  it('PC-10 C-05 at rest: the FL breach clock runs 30 days, the floor breach clock 60', async () => {
    const fl = await boundQuery<{ days: string }>(
      'northwind-synthetic',
      `SELECT EXTRACT(DAY FROM (due_at - triggered_at))::text AS days
         FROM consent.obligation_clock WHERE clock_id = 'ncl-breach-0001'`,
    );
    expect(fl.rows[0]?.days).toBe('30');
    const floor = await boundQuery<{ days: string }>(
      'riverbend-synthetic',
      `SELECT EXTRACT(DAY FROM (due_at - triggered_at))::text AS days
         FROM consent.obligation_clock WHERE clock_id = 'rcl-breach-0001'`,
    );
    expect(floor.rows[0]?.days).toBe('60');
  });

  it('PC-11 the clock projection matches the folded event log (every clock names its latest event)', async () => {
    const orphanClocks = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS count FROM consent.obligation_clock c WHERE NOT EXISTS (
         SELECT FROM consent.obligation_clock_event e
          WHERE e.tenant_id = c.tenant_id AND e.clock_event_id = c.last_event_id
            AND e.clock_id = c.clock_id)`,
    );
    expect(orphanClocks.rows[0]?.count).toBe('0');
    // the seeded statute-tracker clock is escalated (its worklist opened) and the
    // access clock is satisfied with closure evidence.
    const posture = await boundQuery<{ clock_id: string; status: string }>(
      'northwind-synthetic',
      `SELECT clock_id, status FROM consent.obligation_clock
        WHERE clock_id IN ('ncl-tracker-0001', 'ncl-access-0001') ORDER BY clock_id`,
    );
    expect(posture.rows).toEqual([
      { clock_id: 'ncl-access-0001', status: 'satisfied' },
      { clock_id: 'ncl-tracker-0001', status: 'escalated' },
    ]);
  });

  it('PC-12 effective-dated policy content is stored (effective_on) for as-of resolution', async () => {
    const { rows } = await boundQuery<{ jurisdiction: string; effective_on: string }>(
      'northwind-synthetic',
      `SELECT jurisdiction, effective_on::text AS effective_on FROM consent.policy_document
        WHERE tenant_id = 'northwind-synthetic' AND document_type = 'disclosure-authorization'
        ORDER BY jurisdiction`,
    );
    expect(rows).toEqual([
      { jurisdiction: 'MN', effective_on: '2026-01-01' },
      { jurisdiction: 'floor', effective_on: '1970-01-01' },
    ]);
  });
});
