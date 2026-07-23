/**
 * DB-level WorkItem + SLA suite (WP-022 verification gate). Runs against the
 * local synthetic app-postgres (or CI service container) on 127.0.0.1:55432.
 * Proves, on the LIVE tasking tables:
 *  - cross-tenant negatives + forced RLS (unbound reads zero, cannot write);
 *  - the SLA policy registry is RUNTIME READ-ONLY for the app role (forge → 42501),
 *    while the owner can publish change-controlled versions;
 *  - the append-only work_item_event log (UPDATE/DELETE → 42501) and the
 *    projections fold-forward (no DELETE);
 *  - the structural CHECKs (has_sla↔policy, owner-xor-pool, acceptance-names-owner,
 *    reassign-carries-context, escalation-named, timer-started-has-due) and FKs;
 *  - the William standing posture + the unmatched first-touch posture at rest;
 *  - projection == fold (WI-10) and the single-owner claim race (WI-11, first wins);
 *  - the William scenario driven end-to-end through the STORE against Postgres.
 *
 * Every mutation is either a NEGATIVE (must fail) or is created under a
 * 'wi-db-test-%' id and removed by the owner before the suite ends, so the
 * seeded posture the local:test probes assert is never disturbed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { workItemsRlsSpecs } from './rls-specs.js';
import type { Queryable } from './store.js';
import {
  appendEvents,
  claimWorkItem,
  loadWorkItem,
  openWorkItem,
  reassignWorkItem,
  recordHoldingReply,
  WorkItemStoreError,
} from './workitem-store.js';
import type { ContextPackage, WorkItemOpen } from './workitem.js';

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
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/014-workitems-seed.sql',
];

const taskingTables = workItemsRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`);
const northwind = 'northwind-synthetic';
const context: ContextPackage = {
  timerState: [],
  transcriptRef: 'synthetic-transcript:db',
  priorOwnerNotesRef: 'synthetic-note:db',
};

function req<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) {
    throw new Error('expected a value to be present');
  }
  return value;
}

let owner: Client;
let app: Client;

async function bind(tenantId: string): Promise<void> {
  await app.query(tenantBindingSql(tenantId));
}

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

/** A valid work_item INSERT with overridable columns (for CHECK negatives). */
function forgedWorkItem(id: string, overrides: Readonly<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    tenant_id: `'northwind-synthetic'`,
    work_item_id: `'${id}'`,
    origin: `'thread'`,
    purpose: `'member-message'`,
    risk: `'routine'`,
    service_tier: `'concierge'`,
    sla_policy_id: `'sla-concierge'`,
    policy_version: '1',
    has_sla: 'true',
    status: `'unmatched'`,
    priority: `'normal'`,
    owner_ref: 'NULL',
    pool_id: 'NULL',
    opened_at: `'2026-03-10T08:00:00Z'`,
    last_event_seq: '0',
    synthetic: 'true',
  };
  const merged = { ...fields, ...overrides };
  return `INSERT INTO events.work_item (${Object.keys(merged).join(', ')}) VALUES (${Object.values(merged).join(', ')})`;
}

/** A work_item_event INSERT against the seeded (existing) unmatched item — FK satisfied, so a CHECK fires alone. */
function forgedEvent(overrides: Readonly<Record<string, string>>): string {
  const fields: Record<string, string> = {
    tenant_id: `'northwind-synthetic'`,
    work_item_id: `'wi-thread-unmatched-0002'`,
    event_seq: '900',
    event_type: `'queued'`,
    occurred_at: `'2026-03-10T08:00:00Z'`,
    synthetic: 'true',
    ...overrides,
  };
  return `INSERT INTO events.work_item_event (${Object.keys(fields).join(', ')}) VALUES (${Object.values(fields).join(', ')})`;
}

async function cleanupTestItems(): Promise<void> {
  await owner.query(`DELETE FROM events.sla_timer WHERE work_item_id LIKE 'wi-db-test-%'`);
  await owner.query(`DELETE FROM events.work_item_event WHERE work_item_id LIKE 'wi-db-test-%'`);
  await owner.query(`DELETE FROM events.work_item WHERE work_item_id LIKE 'wi-db-test-%'`);
}

beforeAll(async () => {
  owner = new Client(ownerConfig);
  await owner.connect();
  for (const file of provisioningFiles) {
    await owner.query(readFileSync(`${repoRoot}${file}`, 'utf8'));
  }
  await cleanupTestItems();
  app = new Client(appConfig);
  await app.connect();
});

afterEach(async () => {
  await app?.query('ROLLBACK').catch(() => undefined);
});

afterAll(async () => {
  await cleanupTestItems();
  await app?.end();
  await owner?.end();
});

describe('workitems DB suite (WP-022)', () => {
  it('WI-01 positive control: a Northwind-bound session reads its tasking rows', async () => {
    for (const table of taskingTables) {
      const rows = await boundQuery<{ count: string }>(
        northwind,
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(Number(rows[0]?.count), `${table} should show rows`).toBeGreaterThan(0);
    }
  });

  it('WI-02 cross-tenant reads come back empty in both directions', async () => {
    const fromN = await boundQuery<{ count: string }>(
      northwind,
      `SELECT count(*)::text AS count FROM events.work_item WHERE tenant_id = 'riverbend-synthetic'`,
    );
    expect(fromN[0]?.count).toBe('0');
    const fromR = await boundQuery<{ count: string }>(
      'riverbend-synthetic',
      `SELECT count(*)::text AS count FROM events.work_item WHERE tenant_id = 'northwind-synthetic'`,
    );
    expect(fromR[0]?.count).toBe('0');
  });

  it('WI-03 a Northwind-bound INSERT carrying the Riverbend tenant is rejected by policy', async () => {
    expect(
      await boundError(
        northwind,
        forgedWorkItem('wi-db-test-x', { tenant_id: `'riverbend-synthetic'` }),
      ),
    ).toBe('42501');
  });

  it('WI-04 the work_item_event log is append-only (UPDATE/DELETE rejected)', async () => {
    expect(
      await boundError(
        northwind,
        `UPDATE events.work_item_event SET reason = 'manual' WHERE work_item_id = 'wi-thread-william-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundError(
        northwind,
        `DELETE FROM events.work_item_event WHERE work_item_id = 'wi-thread-william-0001'`,
      ),
    ).toBe('42501');
    // The projections fold forward — never DELETE.
    expect(
      await boundError(
        northwind,
        `DELETE FROM events.work_item WHERE work_item_id = 'wi-thread-william-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundError(
        northwind,
        `DELETE FROM events.sla_timer WHERE work_item_id = 'wi-thread-william-0001'`,
      ),
    ).toBe('42501');
  });

  it('WI-05 the SLA policy registry is runtime read-only for the app role (forge → 42501); the owner can publish', async () => {
    const forge =
      `INSERT INTO events.sla_policy (tenant_id, policy_id, version, effective_on, member_tier, hours_mode,` +
      ` first_response_target_minutes, next_response_target_minutes, resolution_target_minutes, escalation_chain,` +
      ` quiet_hours_exempt, change_control_ref, synthetic) VALUES ('northwind-synthetic', 'sla-forged', 1, '2026-01-01',` +
      ` 'concierge', 'after_hours', 5, 5, 30, '[]'::jsonb, true, 'forged', true)`;
    expect(await boundError(northwind, forge)).toBe('42501');
    // The owner (change-control seed path) can insert, then rolls back — the
    // REVOKE is a privilege boundary, not a broken table.
    await owner.query('BEGIN');
    const inserted = await owner.query(forge);
    expect(inserted.rowCount).toBe(1);
    await owner.query('ROLLBACK');
  });

  it('WI-06 structural CHECKs are enforced (has_sla, owner-xor-pool, acceptance, reassign-context, escalation, timer-due)', async () => {
    // has_sla=true but no policy attached.
    expect(
      await boundError(
        northwind,
        forgedWorkItem('wi-db-test-a', { sla_policy_id: 'NULL', policy_version: 'NULL' }),
      ),
    ).toBe('23514');
    // owner and pool both set (single-owner: an owned item is never pooled). Needs first_owned_at too.
    expect(
      await boundError(
        northwind,
        forgedWorkItem('wi-db-test-b', {
          owner_ref: `'synthetic-guide:x'`,
          pool_id: `'synthetic-pool:y'`,
          first_owned_at: `'2026-03-10T08:00:00Z'`,
          status: `'open'`,
        }),
      ),
    ).toBe('23514');
    // Acceptance event without a new owner.
    expect(
      await boundError(
        northwind,
        forgedEvent({ event_type: `'claimed'`, context_package: `'{}'::jsonb` }),
      ),
    ).toBe('23514');
    // A claim/reassignment without a context package.
    expect(
      await boundError(
        northwind,
        forgedEvent({ event_type: `'reassigned'`, to_owner_ref: `'synthetic-guide:z'` }),
      ),
    ).toBe('23514');
    // An escalation without step/action/target.
    expect(await boundError(northwind, forgedEvent({ event_type: `'escalated'` }))).toBe('23514');
    // A timer_started without a due instant.
    expect(
      await boundError(
        northwind,
        forgedEvent({ event_type: `'timer_started'`, timer_type: `'first_response'` }),
      ),
    ).toBe('23514');
  });

  it('WI-07 event + timer FKs require an existing same-tenant work item', async () => {
    expect(
      await boundError(
        northwind,
        `INSERT INTO events.work_item_event (tenant_id, work_item_id, event_seq, event_type, occurred_at, synthetic)
         VALUES ('northwind-synthetic', 'wi-db-test-ghost', 1, 'opened', '2026-03-10T08:00:00Z', true)`,
      ),
    ).toBe('23503');
    expect(
      await boundError(
        northwind,
        `INSERT INTO events.sla_timer (tenant_id, work_item_id, timer_type, started_at, due_at, state, last_event_seq, synthetic)
         VALUES ('northwind-synthetic', 'wi-db-test-ghost', 'first_response', '2026-03-10T08:00:00Z', '2026-03-10T09:00:00Z', 'running', 1, true)`,
      ),
    ).toBe('23503');
  });

  it('WI-08 the William standing posture holds at rest (single owner, prior owner watcher, timers paused/running)', async () => {
    const rows = await boundQuery<{
      owner_ref: string;
      priority: string;
      escalated: boolean;
      has_william: boolean;
      next_state: string;
      res_state: string;
    }>(
      northwind,
      `SELECT w.owner_ref, w.priority, w.escalated,
              (w.watchers ? 'synthetic-guide:william') AS has_william,
              (SELECT state FROM events.sla_timer WHERE work_item_id = 'wi-thread-william-0001' AND timer_type = 'next_response') AS next_state,
              (SELECT state FROM events.sla_timer WHERE work_item_id = 'wi-thread-william-0001' AND timer_type = 'resolution') AS res_state
         FROM events.work_item w WHERE w.work_item_id = 'wi-thread-william-0001'`,
    );
    expect(rows[0]).toMatchObject({
      owner_ref: 'synthetic-guide:maya',
      priority: 'high',
      escalated: true,
      has_william: true,
      next_state: 'paused',
      res_state: 'running',
    });
  });

  it('WI-09 the unmatched first-touch posture holds (unowned, first_response running)', async () => {
    const rows = await boundQuery<{
      owner_ref: string | null;
      status: string;
      timer_state: string;
    }>(
      northwind,
      `SELECT w.owner_ref, w.status,
              (SELECT state FROM events.sla_timer WHERE work_item_id = 'wi-thread-unmatched-0002' AND timer_type = 'first_response') AS timer_state
         FROM events.work_item w WHERE w.work_item_id = 'wi-thread-unmatched-0002'`,
    );
    expect(rows[0]?.owner_ref).toBeNull();
    expect(rows[0]?.status).toBe('unmatched');
    expect(rows[0]?.timer_state).toBe('running');
  });

  it('WI-10 projection == fold: every seeded work_item matches its folded event log', async () => {
    await app.query('BEGIN');
    await bind(northwind);
    const idRows = await app.query(`SELECT work_item_id FROM events.work_item`);
    for (const row of idRows.rows) {
      const id = String((row as { work_item_id: string }).work_item_id);
      const projection = await app.query(
        `SELECT owner_ref, status, priority, escalated, last_event_seq FROM events.work_item WHERE work_item_id = $1`,
        [id],
      );
      const folded = req(await loadWorkItem(app as Queryable, id));
      const p = projection.rows[0] as {
        owner_ref: string | null;
        status: string;
        priority: string;
        escalated: boolean;
        last_event_seq: number;
      };
      expect({
        owner: p.owner_ref,
        status: p.status,
        priority: p.priority,
        escalated: p.escalated,
        seq: Number(p.last_event_seq),
      }).toEqual({
        owner: folded.ownerRef,
        status: folded.status,
        priority: folded.priority,
        escalated: folded.escalated,
        seq: folded.lastEventSeq,
      });
    }
    await app.query('COMMIT');
  });

  it('WI-11 single-owner claim race: the first claim wins; the second is refused (no split ownership)', async () => {
    const open: WorkItemOpen = {
      workItemId: 'wi-db-test-claim',
      origin: 'thread',
      subjectRef: 'thread:db-claim',
      purpose: 'member-message',
      risk: 'routine',
      serviceTier: 'concierge',
      slaPolicyId: 'sla-concierge',
      policyVersion: 1,
      responseDueAt: '2026-03-10T09:00:00Z',
      poolId: 'synthetic-pool:front-desk',
      openedAt: '2026-03-10T08:00:00Z',
    };
    await app.query('BEGIN');
    await bind(northwind);
    await openWorkItem(app as Queryable, {
      tenantId: northwind,
      open,
      actorRef: 'synthetic-system:router',
      firstResponseDueAt: '2026-03-10T09:00:00Z',
    });
    await app.query('COMMIT');

    await app.query('BEGIN');
    await bind(northwind);
    const claimed = await claimWorkItem(app as Queryable, {
      tenantId: northwind,
      workItemId: 'wi-db-test-claim',
      toOwnerRef: 'synthetic-guide:maya',
      actorRef: 'synthetic-guide:maya',
      occurredAt: '2026-03-10T08:05:00Z',
      contextPackage: context,
    });
    await app.query('COMMIT');
    expect(claimed.ownerRef).toBe('synthetic-guide:maya');

    await app.query('BEGIN');
    await bind(northwind);
    await expect(
      claimWorkItem(app as Queryable, {
        tenantId: northwind,
        workItemId: 'wi-db-test-claim',
        toOwnerRef: 'synthetic-guide:noor',
        actorRef: 'synthetic-guide:noor',
        occurredAt: '2026-03-10T08:06:00Z',
        contextPackage: context,
      }),
    ).rejects.toBeInstanceOf(WorkItemStoreError);
    await app.query('ROLLBACK');

    await cleanupTestItems();
  });

  it('WI-12 every seeded tasking row carries the synthetic watermark', async () => {
    for (const table of taskingTables) {
      const result = await owner.query(
        `SELECT count(*)::text AS count FROM ${table} WHERE synthetic IS DISTINCT FROM true`,
      );
      expect(result.rows[0], `${table} must be fully watermarked`).toMatchObject({ count: '0' });
    }
  });

  it('WI-13 idempotency: 0012 re-applies, 0001 re-applies after it, append-only posture holds', async () => {
    await owner.query(
      readFileSync(`${repoRoot}modules/events/migrations/0012-workitems.sql`, 'utf8'),
    );
    await owner.query(
      readFileSync(`${repoRoot}modules/platform-core/migrations/0001-tenancy.sql`, 'utf8'),
    );
    expect(
      await boundError(
        northwind,
        `UPDATE events.work_item_event SET reason = 'manual' WHERE work_item_id = 'wi-thread-william-0001'`,
      ),
    ).toBe('42501');
  });

  it('WI-14 forced RLS is live; an unbound session reads zero rows and cannot write', async () => {
    const unprotected = await owner.query(
      `SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'events' AND c.relkind = 'r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`,
    );
    expect(unprotected.rows[0]).toMatchObject({ count: '0' });
    for (const table of taskingTables) {
      const result = await app.query(`SELECT count(*)::text AS count FROM ${table}`);
      expect(result.rows[0], `${table} must be empty without a binding`).toMatchObject({
        count: '0',
      });
    }
  });

  it('WI-15 the William scenario driven end-to-end through the store folds to the live posture', async () => {
    const open: WorkItemOpen = {
      workItemId: 'wi-db-test-william',
      origin: 'thread',
      subjectRef: 'thread:db-william',
      purpose: 'member-message',
      risk: 'routine',
      serviceTier: 'concierge',
      slaPolicyId: 'sla-concierge',
      policyVersion: 1,
      responseDueAt: '2026-03-10T09:00:00Z',
      poolId: null,
      openedAt: '2026-03-10T08:00:00Z',
    };
    await app.query('BEGIN');
    await bind(northwind);
    // Open the owned thread, start its next_response timer, assign William, breach,
    // and hard-escalate at 5h — then a teammate's holding reply pauses the timer,
    // and the thread is reassigned with a context package.
    await openWorkItem(app as Queryable, {
      tenantId: northwind,
      open,
      actorRef: 'synthetic-system:router',
    });
    await appendEvents(app as Queryable, northwind, open.workItemId, [
      {
        workItemId: open.workItemId,
        eventSeq: 3,
        eventType: 'timer_started',
        occurredAt: '2026-03-10T08:00:00Z',
        timerType: 'next_response',
        dueAt: '2026-03-10T09:00:00Z',
      },
      {
        workItemId: open.workItemId,
        eventSeq: 4,
        eventType: 'assigned',
        occurredAt: '2026-03-10T08:02:00Z',
        toOwnerRef: 'synthetic-guide:william',
        reason: 'assignment',
      },
      {
        workItemId: open.workItemId,
        eventSeq: 5,
        eventType: 'timer_breached',
        occurredAt: '2026-03-10T09:00:00Z',
        timerType: 'next_response',
      },
      {
        workItemId: open.workItemId,
        eventSeq: 6,
        eventType: 'escalated',
        occurredAt: '2026-03-10T13:00:00Z',
        escalationStep: 3,
        escalationAction: 'mark_priority_high',
        escalationTarget: 'synthetic-escalation-queue:pod-a',
      },
      {
        workItemId: open.workItemId,
        eventSeq: 7,
        eventType: 'watcher_added',
        occurredAt: '2026-03-10T09:00:00Z',
        watcherRef: 'synthetic-supervisor:pod-a',
      },
    ]);
    const item = await recordHoldingReply(app as Queryable, {
      tenantId: northwind,
      workItemId: open.workItemId,
      actorRef: 'synthetic-guide:maya',
      occurredAt: '2026-03-10T13:10:00Z',
      resolutionDueAt: '2026-03-10T17:10:00Z',
    });
    // The holding reply did NOT change the owner (REQ-TASK-029 E2).
    expect(item.ownerRef).toBe('synthetic-guide:william');
    const reassigned = await reassignWorkItem(app as Queryable, {
      tenantId: northwind,
      workItemId: open.workItemId,
      toOwnerRef: 'synthetic-guide:maya',
      actorRef: 'synthetic-supervisor:pod-a',
      occurredAt: '2026-03-10T13:15:00Z',
      reason: 'escalation',
      contextPackage: context,
    });
    await app.query('COMMIT');

    expect(reassigned.ownerRef).toBe('synthetic-guide:maya');
    expect(reassigned.watchers).toContain('synthetic-guide:william');
    expect(reassigned.escalated).toBe(true);
    // Re-fold from the live log to confirm projection == fold for the driven item.
    await app.query('BEGIN');
    await bind(northwind);
    const refolded = req(await loadWorkItem(app as Queryable, open.workItemId));
    const nextTimer = await app.query(
      `SELECT state FROM events.sla_timer WHERE work_item_id = $1 AND timer_type = 'next_response'`,
      [open.workItemId],
    );
    await app.query('COMMIT');
    expect(refolded.ownerRef).toBe('synthetic-guide:maya');
    expect((nextTimer.rows[0] as { state: string }).state).toBe('paused');

    await cleanupTestItems();
  });
});
