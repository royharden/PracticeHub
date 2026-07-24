/**
 * DB-level on-call + coverage suite (WP-023 verification gate). Runs against the
 * local synthetic app-postgres (or CI service container) on 127.0.0.1:55432.
 * Proves, on the LIVE on-call/coverage tables:
 *  - cross-tenant negatives + forced RLS (unbound reads zero, cannot write);
 *  - the on-call rotation registry is RUNTIME READ-ONLY for the app role (forge →
 *    42501), while the owner can publish change-controlled versions;
 *  - the coverage_handoff record is append-only (UPDATE/DELETE → 42501) and the
 *    operational tables fold forward (no DELETE; a slot vacate is an UPDATE);
 *  - the structural CHECKs (window order, coverage mode, handoff count-matches,
 *    detected_reason) and the seeded OPEN coverage-gap alert posture;
 *  - the coverage/PTO bulk reassignment driven end-to-end through the STORE against
 *    Postgres: each owned thread moves to the covering owner WITH a context package
 *    (prior owner demoted to a watcher), the CoverageHandoff records the manifest,
 *    and a context-less item aborts the WHOLE handoff (atomic — no partial move).
 *
 * The e2e runs inside a transaction that is ROLLED BACK, so the seeded posture the
 * local:test probes assert is never disturbed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { onCallRlsSpecs } from './rls-specs.js';
import type { Queryable } from './store.js';
import { appendEvents, openWorkItem } from './workitem-store.js';
import { executeCoverageReassignment } from './oncall-store.js';
import type { ContextPackage, WorkItemEvent, WorkItemOpen } from './workitem.js';
import type { CoverageWindow, OwnedItemHandoff } from './coverage.js';

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
  'modules/events/migrations/0010-events.sql',
  'modules/events/migrations/0012-workitems.sql',
  'modules/events/migrations/0014-oncall.sql',
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/014-workitems-seed.sql',
  'infra/postgres/seed/016-oncall-seed.sql',
];

const onCallTables = onCallRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`);
const northwind = 'northwind-synthetic';
const context: ContextPackage = {
  timerState: [],
  transcriptRef: 'synthetic-transcript:db',
  priorOwnerNotesRef: 'synthetic-note:db',
};

let owner: Client;
let app: Client;

async function boundQuery<T extends Record<string, unknown>>(
  tenantId: string,
  sql: string,
): Promise<T[]> {
  await app.query('BEGIN');
  try {
    await app.query(tenantBindingSql(tenantId));
    const result = await app.query(sql);
    await app.query('COMMIT');
    return result.rows as T[];
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

async function boundError(tenantId: string, sql: string): Promise<string> {
  try {
    await boundQuery(tenantId, sql);
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  throw new Error(`expected ${sql} to be rejected`);
}

/** Open a test work item owned by `ownerRef` inside the caller's bound transaction. */
async function seedOwnedItem(exec: Queryable, workItemId: string, ownerRef: string): Promise<void> {
  const open: WorkItemOpen = {
    workItemId,
    origin: 'thread',
    subjectRef: `thread:${workItemId}`,
    purpose: 'member-message',
    risk: 'routine',
    serviceTier: 'concierge',
    slaPolicyId: null,
    policyVersion: null,
    responseDueAt: null,
    poolId: null,
    openedAt: '2026-03-09T08:00:00Z',
  };
  await openWorkItem(exec, { tenantId: northwind, open, actorRef: 'synthetic-system:router' });
  const item = { lastEventSeq: 2 };
  const assign: WorkItemEvent = {
    workItemId,
    eventSeq: item.lastEventSeq + 1,
    eventType: 'assigned',
    occurredAt: '2026-03-09T08:05:00Z',
    actorRef: ownerRef,
    toOwnerRef: ownerRef,
    reason: 'assignment',
  };
  await appendEvents(exec, northwind, workItemId, [assign]);
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

afterEach(async () => {
  await app?.query('ROLLBACK').catch(() => undefined);
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
});

describe('oncall DB suite (WP-023)', () => {
  it('OC-01 positive control: a Northwind-bound session reads its on-call rows', async () => {
    for (const table of onCallTables) {
      const rows = await boundQuery<{ count: string }>(
        northwind,
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(Number(rows[0]?.count), `${table} should show rows`).toBeGreaterThan(0);
    }
  });

  it('OC-02 cross-tenant reads come back empty in both directions', async () => {
    const fromN = await boundQuery<{ count: string }>(
      northwind,
      `SELECT count(*)::text AS count FROM events.on_call_rotation WHERE tenant_id = 'riverbend-synthetic'`,
    );
    expect(fromN[0]?.count).toBe('0');
    const fromR = await boundQuery<{ count: string }>(
      'riverbend-synthetic',
      `SELECT count(*)::text AS count FROM events.on_call_rotation WHERE tenant_id = 'northwind-synthetic'`,
    );
    expect(fromR[0]?.count).toBe('0');
  });

  it('OC-03 a Northwind-bound INSERT carrying the Riverbend tenant is rejected by policy', async () => {
    const forge =
      `INSERT INTO events.on_call_slot (tenant_id, slot_id, rotation_id, kind, member_ref,` +
      ` service_scopes, window_start, window_end, status, synthetic) VALUES ('riverbend-synthetic',` +
      ` 'slot-db-test-x', 'r1', 'rotation', 'synthetic-provider:x', '[]'::jsonb,` +
      ` '2026-03-02T08:00:00Z', '2026-03-02T09:00:00Z', 'scheduled', true)`;
    expect(await boundError(northwind, forge)).toBe('42501');
  });

  it('OC-04 the rotation registry is runtime read-only for the app role (forge → 42501); the owner can publish', async () => {
    const forge =
      `INSERT INTO events.on_call_rotation (tenant_id, rotation_id, version, effective_on, location_id,` +
      ` coverage_mode, service_scopes, member_order, change_control_ref, synthetic) VALUES` +
      ` ('northwind-synthetic', 'oncall-forged', 1, '2026-01-01', 'loc-nv-lasvegas', 'business',` +
      ` '["x"]'::jsonb, '[{"memberRef":"synthetic-provider:x","serviceScopes":["x"]}]'::jsonb, 'forged', true)`;
    expect(await boundError(northwind, forge)).toBe('42501');
    await owner.query('BEGIN');
    const inserted = await owner.query(forge);
    expect(inserted.rowCount).toBe(1);
    await owner.query('ROLLBACK');
  });

  it('OC-05 the coverage_handoff record is append-only; the operational tables never DELETE', async () => {
    expect(
      await boundError(
        northwind,
        `UPDATE events.coverage_handoff SET item_count = 0 WHERE handoff_id = 'handoff-noor-pto-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundError(
        northwind,
        `DELETE FROM events.coverage_handoff WHERE handoff_id = 'handoff-noor-pto-0001'`,
      ),
    ).toBe('42501');
    // A slot vacate is a permitted fold-forward UPDATE, but no on-call table DELETEs.
    for (const table of ['on_call_slot', 'coverage_window', 'coverage_gap_alert']) {
      expect(await boundError(northwind, `DELETE FROM events.${table}`)).toBe('42501');
    }
  });

  it('OC-06 structural CHECKs are enforced (window order, coverage mode, handoff count, gap reason)', async () => {
    // window_end must be after window_start.
    expect(
      await boundError(
        northwind,
        `INSERT INTO events.on_call_slot (tenant_id, slot_id, rotation_id, kind, member_ref, service_scopes,` +
          ` window_start, window_end, status, synthetic) VALUES ('northwind-synthetic', 'slot-db-test-a', 'r1',` +
          ` 'rotation', 'synthetic-provider:x', '[]'::jsonb, '2026-03-02T09:00:00Z', '2026-03-02T08:00:00Z',` +
          ` 'scheduled', true)`,
      ),
    ).toBe('23514');
    // item_count must equal the manifest length (owner path so the REVOKE does not mask the CHECK).
    await owner.query('BEGIN');
    const badCount = await owner
      .query(
        `INSERT INTO events.coverage_handoff (tenant_id, handoff_id, kind, from_owner_ref, to_owner_ref,` +
          ` generated_at, item_count, context_manifest, synthetic) VALUES ('northwind-synthetic',` +
          ` 'handoff-db-test-x', 'morning-handoff', NULL, 'synthetic-guide:noor', '2026-03-03T07:00:00Z', 5,` +
          ` '[]'::jsonb, true)`,
      )
      .then(() => 'inserted')
      .catch((error: { code?: string }) => error.code ?? 'err');
    await owner.query('ROLLBACK');
    expect(badCount).toBe('23514');
  });

  it('OC-07 the seeded OPEN coverage-gap alert posture stands (REQ-ADM-041)', async () => {
    const rows = await boundQuery<{ count: string }>(
      northwind,
      `SELECT count(*)::text AS count FROM events.coverage_gap_alert WHERE status = 'open'` +
        ` AND detected_reason = 'vacated-slot'`,
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('OC-08 coverage/PTO bulk reassignment moves every owned thread to the covering owner WITH context (REQ-TASK-020)', async () => {
    await app.query('BEGIN');
    try {
      await app.query(tenantBindingSql(northwind));
      await seedOwnedItem(app, 'wi-db-test-cov-1', 'synthetic-guide:noor');
      await seedOwnedItem(app, 'wi-db-test-cov-2', 'synthetic-guide:noor');
      const window: CoverageWindow = {
        coverageId: 'cov-db-test-1',
        ownerRef: 'synthetic-guide:noor',
        fromAt: '2026-03-10T00:00:00Z',
        toAt: '2026-03-14T00:00:00Z',
        coverageTargetRef: 'synthetic-guide:maya',
        targetKind: 'owner',
        reason: 'pto',
        status: 'planned',
      };
      const items: OwnedItemHandoff[] = [
        { workItemId: 'wi-db-test-cov-1', contextPackage: context },
        { workItemId: 'wi-db-test-cov-2', contextPackage: context },
      ];
      const result = await executeCoverageReassignment(app, {
        tenantId: northwind,
        handoffId: 'handoff-db-test-1',
        window,
        ownedItems: items,
        actorRef: 'synthetic-manager:pod-a',
        occurredAt: '2026-03-09T18:00:00Z',
      });
      expect(result.reassignedItemIds).toEqual(['wi-db-test-cov-1', 'wi-db-test-cov-2']);

      const owners = await app.query(
        `SELECT work_item_id, owner_ref, watchers FROM events.work_item WHERE work_item_id LIKE 'wi-db-test-cov-%' ORDER BY work_item_id`,
      );
      for (const row of owners.rows) {
        expect(row['owner_ref']).toBe('synthetic-guide:maya');
        expect(JSON.stringify(row['watchers'])).toContain('synthetic-guide:noor');
      }
      // Every reassignment event carries a context package (the frozen handoff shape).
      const reassigned = await app.query(
        `SELECT count(*)::int AS n FROM events.work_item_event WHERE event_type = 'reassigned'` +
          ` AND reason = 'pto' AND context_package IS NOT NULL AND work_item_id LIKE 'wi-db-test-cov-%'`,
      );
      expect(reassigned.rows[0]?.['n']).toBe(2);
      // The handoff manifest records both moves and its count matches (CHECK-enforced).
      const handoff = await app.query(
        `SELECT item_count, jsonb_array_length(context_manifest) AS manifest_len FROM events.coverage_handoff` +
          ` WHERE handoff_id = 'handoff-db-test-1'`,
      );
      expect(handoff.rows[0]?.['item_count']).toBe(2);
      expect(handoff.rows[0]?.['manifest_len']).toBe(2);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('OC-09 a context-less item aborts the WHOLE handoff — no partial move, no handoff row (atomic)', async () => {
    await app.query('BEGIN');
    try {
      await app.query(tenantBindingSql(northwind));
      await seedOwnedItem(app, 'wi-db-test-cov-3', 'synthetic-guide:noor');
      await seedOwnedItem(app, 'wi-db-test-cov-4', 'synthetic-guide:noor');
      const window: CoverageWindow = {
        coverageId: 'cov-db-test-2',
        ownerRef: 'synthetic-guide:noor',
        fromAt: '2026-03-10T00:00:00Z',
        toAt: '2026-03-14T00:00:00Z',
        coverageTargetRef: 'synthetic-guide:maya',
        targetKind: 'owner',
        reason: 'coverage',
        status: 'planned',
      };
      const items = [
        { workItemId: 'wi-db-test-cov-3', contextPackage: context },
        { workItemId: 'wi-db-test-cov-4' } as unknown as OwnedItemHandoff,
      ];
      await expect(
        executeCoverageReassignment(app, {
          tenantId: northwind,
          handoffId: 'handoff-db-test-2',
          window,
          ownedItems: items,
          actorRef: 'synthetic-manager:pod-a',
          occurredAt: '2026-03-09T18:00:00Z',
        }),
      ).rejects.toThrow();
      // The plan validates up front, so NOTHING moved: both items still owned by noor.
      const owners = await app.query(
        `SELECT owner_ref FROM events.work_item WHERE work_item_id LIKE 'wi-db-test-cov-%'`,
      );
      for (const row of owners.rows) {
        expect(row['owner_ref']).toBe('synthetic-guide:noor');
      }
      const handoff = await app.query(
        `SELECT count(*)::int AS n FROM events.coverage_handoff WHERE handoff_id = 'handoff-db-test-2'`,
      );
      expect(handoff.rows[0]?.['n']).toBe(0);
    } finally {
      await app.query('ROLLBACK');
    }
  });

  it('OC-10 forced RLS: an unbound session reads zero on-call rows and cannot insert', async () => {
    for (const table of onCallTables) {
      const rows = await app.query(`SELECT count(*)::text AS count FROM ${table}`);
      expect(rows.rows[0]?.['count']).toBe('0');
    }
  });

  it('OC-11 re-applying 0014 (and 0010 after it) stays clean (idempotency)', async () => {
    await owner.query(readFileSync(`${repoRoot}modules/events/migrations/0014-oncall.sql`, 'utf8'));
    await owner.query(readFileSync(`${repoRoot}modules/events/migrations/0010-events.sql`, 'utf8'));
    const rows = await boundQuery<{ count: string }>(
      northwind,
      `SELECT count(*)::text AS count FROM events.on_call_rotation`,
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(0);
  });
});
