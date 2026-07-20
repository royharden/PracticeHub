/**
 * DB-level capability-registry suite (WP-012). Proves the grant/event tables'
 * posture against the live schema: forced RLS with cross-tenant negatives,
 * append-only event log, adjacency CHECK (illegal jumps unrepresentable at the
 * database), projection sync between the seeded event log and the seeded
 * grants (and against the TypeScript seed of record), the opposite-state
 * tenant proof, and migration idempotency. Requires the app-postgres from
 * compose.yaml (or the CI `tenancy-db` service) on 127.0.0.1:55432.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { canonicalScopeKey, foldCapabilityEvents } from './capability.js';
import { capabilityRegistryV1, syntheticCapabilitySeedV1 } from './capability-definitions.js';
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
  'modules/platform-core/migrations/0003-capability.sql',
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/004-jurisdiction-seed.sql',
  'infra/postgres/seed/005-capability-seed.sql',
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

async function ownerError(sql: string): Promise<string> {
  try {
    await owner.query(sql);
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

describe('capability registry (DB level)', () => {
  it('PROJECTION-SYNC: seeded grants equal the fold of the TypeScript seed of record', async () => {
    const expected = [
      ...syntheticCapabilitySeedV1.initialGrants,
      ...foldCapabilityEvents(capabilityRegistryV1, [], syntheticCapabilitySeedV1.events),
    ]
      .map((grant) => ({
        tenant_id: grant.tenantId,
        capability_id: grant.capabilityId,
        scope_key: canonicalScopeKey(grant.scope),
        state: grant.state,
        since_event_id: grant.sinceEventId,
      }))
      .sort((left, right) =>
        `${left.tenant_id}|${left.capability_id}|${left.scope_key}`.localeCompare(
          `${right.tenant_id}|${right.capability_id}|${right.scope_key}`,
        ),
      );
    const rows = await owner.query(
      `SELECT tenant_id, capability_id, scope_key, state, since_event_id
         FROM platform_core.capability_grant
        ORDER BY tenant_id || '|' || capability_id || '|' || scope_key COLLATE "C"`,
    );
    expect(rows.rows).toEqual(expected);
  });

  it('PROJECTION-SYNC: every minted grant matches the LATEST event of its stream, both ways', async () => {
    const orphanGrants = await owner.query(
      `SELECT count(*)::text AS count FROM platform_core.capability_grant g
        WHERE g.since_event_id IS NOT NULL AND NOT EXISTS (
          SELECT FROM platform_core.capability_event e
           WHERE e.event_id = g.since_event_id
             AND e.tenant_id = g.tenant_id AND e.capability_id = g.capability_id
             AND e.scope_key = g.scope_key AND e.to_state = g.state
             AND e.seq = (SELECT max(e2.seq) FROM platform_core.capability_event e2
                           WHERE e2.tenant_id = g.tenant_id
                             AND e2.capability_id = g.capability_id
                             AND e2.scope_key = g.scope_key))`,
    );
    expect(orphanGrants.rows[0]?.count).toBe('0');

    const orphanStreams = await owner.query(
      `SELECT count(*)::text AS count FROM (
         SELECT DISTINCT ON (tenant_id, capability_id, scope_key)
                tenant_id, capability_id, scope_key, to_state
           FROM platform_core.capability_event
          ORDER BY tenant_id, capability_id, scope_key, seq DESC
       ) latest
        WHERE NOT EXISTS (
          SELECT FROM platform_core.capability_grant g
           WHERE g.tenant_id = latest.tenant_id
             AND g.capability_id = latest.capability_id
             AND g.scope_key = latest.scope_key
             AND g.state = latest.to_state)`,
    );
    expect(orphanStreams.rows[0]?.count).toBe('0');
  });

  it('OPPOSITE-STATES: tenant 1 registry at simulated, Riverbend declared disabled', async () => {
    const rows = await owner.query(
      `SELECT tenant_id, state, since_event_id FROM platform_core.capability_grant
        WHERE capability_id = 'platform.capability-registry'
        ORDER BY tenant_id COLLATE "C"`,
    );
    expect(rows.rows).toEqual([
      {
        tenant_id: 'northwind-synthetic',
        state: 'simulated',
        since_event_id: 'synthetic-cap-evt-0002',
      },
      { tenant_id: 'riverbend-synthetic', state: 'disabled', since_event_id: null },
    ]);
  });

  it('APPEND-ONLY: the runtime role can append events but never rewrite or erase them', async () => {
    await boundQuery(
      'northwind-synthetic',
      `INSERT INTO platform_core.capability_event
         (event_id, tenant_id, capability_id, scope, scope_key, from_state, to_state,
          initiator_ref, approvals, evidence_refs, rollback_ref, synthetic)
       VALUES ('cap-db-probe-0001', 'northwind-synthetic', 'platform.bootstrap', '{}'::jsonb,
               '(root)', 'simulated', 'shadow', 'synthetic-db-suite', '[]'::jsonb,
               '["synthetic-gate:db-probe"]'::jsonb, 'registry-event-replay', true)
       ON CONFLICT (event_id) DO NOTHING`,
    );
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE platform_core.capability_event SET to_state = 'active'
          WHERE event_id = 'cap-db-probe-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM platform_core.capability_event WHERE event_id = 'cap-db-probe-0001'`,
      ),
    ).toBe('42501');
    const cleanup = await owner.query(
      `DELETE FROM platform_core.capability_event WHERE event_id = 'cap-db-probe-0001'`,
    );
    expect(cleanup.rowCount).toBe(1);
  });

  it('the runtime role can never delete a grant projection row', async () => {
    expect(
      await boundQueryError(
        'riverbend-synthetic',
        `DELETE FROM platform_core.capability_grant WHERE tenant_id = 'riverbend-synthetic'`,
      ),
    ).toBe('42501');
  });

  it('ADJACENCY: an illegal jump is unrepresentable even for the owner (CHECK 23514)', async () => {
    expect(
      await ownerError(
        `INSERT INTO platform_core.capability_event
           (event_id, tenant_id, capability_id, scope, scope_key, from_state, to_state,
            initiator_ref, approvals, evidence_refs, rollback_ref, synthetic)
         VALUES ('cap-db-probe-0002', 'northwind-synthetic', 'platform.bootstrap', '{}'::jsonb,
                 '(root)', 'simulated', 'active', 'synthetic-db-suite', '[]'::jsonb,
                 '["synthetic-gate:db-probe"]'::jsonb, 'registry-event-replay', true)`,
      ),
    ).toBe('23514');
  });

  it('INITIAL-STATE: a grant without a minting event can only be disabled (CHECK 23514)', async () => {
    expect(
      await ownerError(
        `INSERT INTO platform_core.capability_grant
           (tenant_id, capability_id, scope, scope_key, state, since_event_id,
            evidence_refs, rollback_ref, synthetic)
         VALUES ('northwind-synthetic', 'platform.bootstrap', '{}'::jsonb, 'feature=cap-db-probe',
                 'simulated', NULL, '[]'::jsonb, 'registry-event-replay', true)`,
      ),
    ).toBe('23514');
  });

  it('cross-tenant: a Northwind-bound session cannot see Riverbend capability rows', async () => {
    const grants = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS count FROM platform_core.capability_grant
        WHERE tenant_id = 'riverbend-synthetic'`,
    );
    expect(grants.rows[0]?.count).toBe('0');
    const events = await boundQuery<{ count: string }>(
      'riverbend-synthetic',
      `SELECT count(*)::text AS count FROM platform_core.capability_event`,
    );
    expect(events.rows[0]?.count).toBe('0');
  });

  it('every capability row carries the synthetic watermark', async () => {
    const rows = await owner.query(
      `SELECT (SELECT count(*) FROM platform_core.capability_event
                WHERE synthetic IS DISTINCT FROM true)
            + (SELECT count(*) FROM platform_core.capability_grant
                WHERE synthetic IS DISTINCT FROM true) AS count`,
    );
    expect(String(rows.rows[0]?.count)).toBe('0');
  });

  it('migration idempotency: re-applying 0003-capability.sql is clean', async () => {
    await expect(
      owner.query(
        readFileSync(`${repoRoot}modules/platform-core/migrations/0003-capability.sql`, 'utf8'),
      ),
    ).resolves.toBeDefined();
  });

  it('re-applying 0001-tenancy.sql after 0003 stays clean (schema-wide guard declares all tables)', async () => {
    await expect(
      owner.query(
        readFileSync(`${repoRoot}modules/platform-core/migrations/0001-tenancy.sql`, 'utf8'),
      ),
    ).resolves.toBeDefined();
  });
});
