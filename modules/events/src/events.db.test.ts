/**
 * DB-level event-spine suite (WP-021 verification gate). Runs against the local
 * synthetic app-postgres (or the CI service container) on 127.0.0.1:55432.
 * Proves, on the LIVE spine:
 *  - cross-tenant negatives + forced RLS (unbound session reads zero, cannot write);
 *  - the append-only postures (outbox + inbox never edited/deleted; the delivery
 *    projection never deleted) and the structural CHECKs / FKs / idempotency key;
 *  - EV-08 SAME-COMMIT (FWD-AUD-021-OUTBOX / R6-REQ-001 wiring): a command's
 *    outbox enqueue AND its audit emit land in one transaction, or neither does;
 *  - EV-09 EXACTLY-ONCE across a crash between the effect and the mark: the inbox
 *    dedup makes the replay skip the side effect and reconcile the delivery;
 *  - EV-10 inbox dedup + park-denied; EV-11 FWD-CAP-QUEUE (the drain re-invokes
 *    requireCapability at checkpoint drain and parks a below-floor grant).
 *
 * Every mutation is either a NEGATIVE (must fail) or is cleaned up by the owner
 * connection before the test ends, so the seeded posture the local:test probes
 * assert is never disturbed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  capabilityRegistryV1,
  tenantBindingSql,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import {
  buildEventEnvelope,
  createUlidFactory,
  type EventEnvelopeInput,
} from '@practicehub/platform';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  claimPendingDeliveries,
  deliverClaimedEvent,
  runOutboxCommit,
  type Queryable,
} from './store.js';
import { drainOnce } from './drain.js';
import { eventsRlsSpecs } from './rls-specs.js';
import { syntheticEventsSeedV1 } from './seed-data.js';

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
  'modules/audit-evidence/migrations/0007-audit.sql',
  'modules/events/migrations/0010-events.sql',
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/012-events-seed.sql',
];

const eventsTables = eventsRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`);
const northwind = 'northwind-synthetic';
const futureNow = '2030-01-01T00:00:00Z';

/** Assert a value is present (the strict lint forbids non-null assertions). */
function req<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('expected a value to be present');
  }
  return value;
}

// Fresh, valid ULIDs for the mutation tests (deterministic; distinct from the
// seed, whose clock base is 2026-03).
let testClock = Date.parse('2026-04-01T00:00:00Z');
const testFactory = createUlidFactory({
  now: () => testClock,
  randomBytes: () => Uint8Array.from({ length: 16 }, (_unused, index) => (index * 11 + 5) & 0xff),
});
function nextTestId(): string {
  const id = testFactory();
  testClock += 1000;
  return id;
}

function testEnvelope(eventId: string, overrides: Partial<EventEnvelopeInput<unknown>> = {}) {
  return buildEventEnvelope({
    eventId,
    tenantId: northwind,
    type: 'test.event-enqueued',
    aggregate: { type: 'test-aggregate', id: 'agg-0001', version: 1 },
    occurredAt: '2026-04-01T00:00:00Z',
    recordedAt: '2026-04-01T00:00:00Z',
    source: { module: 'events', actorRef: 'synthetic-staff:db' },
    idempotencyKey: `test:${eventId.toLowerCase()}`,
    dataClassification: 'demographic',
    payload: { probe: 'exactly-once' },
    synthetic: true,
    ...overrides,
  });
}

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

function forgedOutbox(eventId: string, overrides: Readonly<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    tenant_id: `'northwind-synthetic'`,
    event_id: `'${eventId}'`,
    type: `'test.forged'`,
    aggregate_type: `'test'`,
    aggregate_id: `'agg-forge'`,
    aggregate_version: '0',
    occurred_at: `'2026-04-05T00:00:00Z'`,
    source_module: `'events'`,
    idempotency_key: `'test:forge:${eventId.toLowerCase()}'`,
    data_classification: `'demographic'`,
    payload: `'{}'::jsonb`,
    synthetic: 'true',
    ...overrides,
  };
  const columns = Object.keys(fields).join(', ');
  const values = Object.values(fields).join(', ');
  return `INSERT INTO events.outbox (${columns}) VALUES (${values})`;
}

function grantEventSpine(state: CapabilityGrant['state']): CapabilityGrant[] {
  return [
    {
      capabilityId: 'platform.event-spine',
      tenantId: northwind,
      scope: {},
      state,
      sinceEventId: 'synthetic-cap-evt-0015',
      evidenceRefs: ['synthetic-gate:wp-021-event-spine-scaffold'],
      rollbackRef: 'registry-event-replay',
      synthetic: true,
    },
  ];
}

async function bind(tenantId: string): Promise<void> {
  await app.query(tenantBindingSql(tenantId));
}

async function cleanupOutbox(eventId: string): Promise<void> {
  await owner.query(`DELETE FROM events.inbox WHERE event_id = $1`, [eventId]);
  await owner.query(`DELETE FROM events.outbox_delivery WHERE event_id = $1`, [eventId]);
  await owner.query(`DELETE FROM events.outbox WHERE event_id = $1`, [eventId]);
}

const witnessInsert = async (exec: Queryable, event: { eventId: string }): Promise<void> => {
  await exec.query(`INSERT INTO ev_witness (event_id) VALUES ($1)`, [event.eventId]);
};

async function witnessCount(eventId: string): Promise<number> {
  const result = await app.query(
    `SELECT count(*)::int AS count FROM ev_witness WHERE event_id = $1`,
    [eventId],
  );
  return Number((result.rows[0] as { count: number }).count);
}

beforeAll(async () => {
  owner = new Client(ownerConfig);
  await owner.connect();
  for (const file of provisioningFiles) {
    await owner.query(readFileSync(`${repoRoot}${file}`, 'utf8'));
  }
  // Purge any residue from a crashed earlier run (every test event carries a
  // 'test:%' idempotency key; the seed never does), so the seeded-posture
  // assertions never see leftover rows on the shared compose database.
  await owner.query(
    `DELETE FROM events.inbox WHERE event_id IN
       (SELECT event_id FROM events.outbox WHERE idempotency_key LIKE 'test:%')`,
  );
  await owner.query(
    `DELETE FROM events.outbox_delivery WHERE event_id IN
       (SELECT event_id FROM events.outbox WHERE idempotency_key LIKE 'test:%')`,
  );
  await owner.query(`DELETE FROM events.outbox WHERE idempotency_key LIKE 'test:%'`);
  await owner.query(`DELETE FROM audit_evidence.audit_event WHERE audit_id = 'ev-sc-audit-0001'`);
  // Re-applying 012 above (a provisioning file) reset the seeded delivery
  // statuses via its upsert; drop any inbox rows a crashed drain left behind
  // (only the two seeded consumers are legitimate) so each run starts from the
  // exact seeded posture.
  await owner.query(
    `DELETE FROM events.inbox WHERE consumer NOT IN ('thread-projector', 'audit-mirror')`,
  );
  app = new Client(appConfig);
  await app.connect();
  await app.query(`CREATE TEMP TABLE ev_witness (event_id text NOT NULL)`);
});

// A test that manages its own BEGIN and throws mid-transaction would leave the
// app connection in an aborted state and cascade into later tests; clear any
// dangling transaction between tests.
afterEach(async () => {
  await app?.query('ROLLBACK').catch(() => undefined);
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
});

describe('events DB suite (WP-021)', () => {
  it('EV-01 positive control: a Northwind-bound session reads its spine rows', async () => {
    for (const table of eventsTables) {
      const { rows } = await boundQuery<{ count: string }>(
        northwind,
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(Number(rows[0]?.count), `${table} should show rows`).toBeGreaterThan(0);
    }
  });

  it('EV-02 cross-tenant reads come back empty in both directions', async () => {
    const fromNorthwind = await boundQuery<{ count: string }>(
      northwind,
      `SELECT count(*)::text AS count FROM events.outbox WHERE tenant_id = 'riverbend-synthetic'`,
    );
    expect(fromNorthwind.rows[0]?.count).toBe('0');
    const fromRiverbend = await boundQuery<{ count: string }>(
      'riverbend-synthetic',
      `SELECT count(*)::text AS count FROM events.outbox_delivery WHERE tenant_id = 'northwind-synthetic'`,
    );
    expect(fromRiverbend.rows[0]?.count).toBe('0');
  });

  it('EV-03 a Northwind-bound INSERT carrying the Riverbend tenant is rejected by policy', async () => {
    expect(
      await boundQueryError(
        northwind,
        forgedOutbox(nextTestId(), { tenant_id: `'riverbend-synthetic'` }),
      ),
    ).toBe('42501');
  });

  it('EV-04 the outbox and inbox are append-only; the delivery projection never deletes', async () => {
    const seeded = req(syntheticEventsSeedV1.records[0]).envelope.eventId;
    expect(
      await boundQueryError(
        northwind,
        `UPDATE events.outbox SET type = 'test.rewritten' WHERE event_id = '${seeded}'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(northwind, `DELETE FROM events.outbox WHERE event_id = '${seeded}'`),
    ).toBe('42501');
    expect(
      await boundQueryError(
        northwind,
        `DELETE FROM events.outbox_delivery WHERE event_id = '${seeded}'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        northwind,
        `UPDATE events.inbox SET outcome = 'skipped' WHERE event_id = '${seeded}'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(northwind, `DELETE FROM events.inbox WHERE event_id = '${seeded}'`),
    ).toBe('42501');
  });

  it('EV-05 structural CHECKs are enforced (ULID, enums, published_at coupling, classification)', async () => {
    expect(await boundQueryError(northwind, forgedOutbox('not-a-ulid'))).toBe('23514');
    expect(
      await boundQueryError(
        northwind,
        forgedOutbox(nextTestId(), { data_classification: `'cosmic'` }),
      ),
    ).toBe('23514');
    // Delivery: a published status without published_at (and vice versa) is unrepresentable.
    const seeded = req(syntheticEventsSeedV1.records[1]).envelope.eventId; // the seeded PENDING event
    expect(
      await boundQueryError(
        northwind,
        `INSERT INTO events.outbox_delivery (tenant_id, event_id, status, attempts, published_at, synthetic)
         VALUES ('northwind-synthetic', '${seeded}', 'published', 1, NULL, true)`,
      ),
    ).toBe('23514');
    expect(
      await boundQueryError(
        northwind,
        `INSERT INTO events.inbox (tenant_id, consumer, event_id, outcome, synthetic)
         VALUES ('northwind-synthetic', 'thread-projector', '${seeded}', 'maybe', true)`,
      ),
    ).toBe('23514');
  });

  it('EV-06 the delivery and inbox FKs require an existing same-tenant outbox event', async () => {
    expect(
      await boundQueryError(
        northwind,
        `INSERT INTO events.outbox_delivery (tenant_id, event_id, status, attempts, synthetic)
         VALUES ('northwind-synthetic', '${nextTestId()}', 'pending', 0, true)`,
      ),
    ).toBe('23503');
    expect(
      await boundQueryError(
        northwind,
        `INSERT INTO events.inbox (tenant_id, consumer, event_id, synthetic)
         VALUES ('northwind-synthetic', 'thread-projector', '${nextTestId()}', true)`,
      ),
    ).toBe('23503');
  });

  it('EV-07 a duplicate producer idempotency key per tenant is unrepresentable', async () => {
    const seededKey = req(syntheticEventsSeedV1.records[0]).envelope.idempotencyKey;
    expect(
      await boundQueryError(
        northwind,
        forgedOutbox(nextTestId(), { idempotency_key: `'${seededKey}'` }),
      ),
    ).toBe('23505');
  });

  it('EV-08 SAME-COMMIT: the outbox enqueue and its audit emit persist together or not at all', async () => {
    const eventId = nextTestId();
    const envelope = testEnvelope(eventId);
    const auditInput = {
      auditId: 'ev-sc-audit-0001',
      tenantId: northwind,
      stream: 'access' as const,
      action: 'event-enqueue',
      actorRef: 'synthetic-staff:db-sc',
      occurredAt: '2026-04-01T09:00:00Z',
      subjectRef: 'np-db-sc',
      decision: 'allow' as const,
      reason: 'operations' as const,
      synthetic: true as const,
    };
    const countBoth = async (): Promise<string> => {
      const { rows } = await boundQuery<{ count: string }>(
        northwind,
        `SELECT ((SELECT count(*) FROM events.outbox WHERE event_id = '${eventId}')
               + (SELECT count(*) FROM audit_evidence.audit_event WHERE audit_id = 'ev-sc-audit-0001'))::text AS count`,
      );
      return rows[0]?.count ?? '?';
    };

    // Crash direction: the transaction dies after the same-commit writes — NEITHER persists.
    await app.query('BEGIN');
    await bind(northwind);
    await runOutboxCommit(app, { envelope, auditInput });
    await app.query('ROLLBACK');
    expect(await countBoth()).toBe('0');

    // Commit direction: the outbox event, its delivery, AND the audit record land atomically.
    await app.query('BEGIN');
    await bind(northwind);
    await runOutboxCommit(app, { envelope, auditInput });
    await app.query('COMMIT');
    expect(await countBoth()).toBe('2');
    const delivery = await boundQuery<{ count: string }>(
      northwind,
      `SELECT count(*)::text AS count FROM events.outbox_delivery WHERE event_id = '${eventId}' AND status = 'pending'`,
    );
    expect(delivery.rows[0]?.count).toBe('1');

    await owner.query(`DELETE FROM audit_evidence.audit_event WHERE audit_id = 'ev-sc-audit-0001'`);
    await cleanupOutbox(eventId);
    expect(await countBoth()).toBe('0');
  });

  it('EV-09 EXACTLY-ONCE: a crash between the effect and the mark never double-processes', async () => {
    const eventId = nextTestId();
    // Enqueue the event (outbox + pending delivery), committed.
    await app.query('BEGIN');
    await bind(northwind);
    await runOutboxCommit(app, { envelope: testEnvelope(eventId) });
    await app.query('COMMIT');

    // Attempt A crashes AFTER the inbox record and the side effect commit but
    // BEFORE the delivery is marked published (the effect landed once; the
    // delivery is still pending). Simulated by committing only those two writes.
    await app.query('BEGIN');
    await bind(northwind);
    await app.query(
      `INSERT INTO events.inbox (tenant_id, consumer, event_id, synthetic)
       VALUES ('northwind-synthetic', 'exactly-once-consumer', $1, true)
       ON CONFLICT DO NOTHING`,
      [eventId],
    );
    await witnessInsert(app, { eventId });
    await app.query('COMMIT');
    expect(await witnessCount(eventId)).toBe(1);

    // Attempt B (replay): the delivery is still pending, so it re-claims — but
    // the inbox already has the event, so deliverClaimedEvent SKIPS the side
    // effect and reconciles the delivery to published.
    await app.query('BEGIN');
    await bind(northwind);
    const claimed = await claimPendingDeliveries(app, { nowIso: futureNow, limit: 50 });
    const target = claimed.find((entry) => entry.envelope.eventId === eventId);
    expect(target, 'the replay re-claims the still-pending delivery').toBeDefined();
    const outcome = await deliverClaimedEvent(app, {
      claimed: req(target),
      consumer: 'exactly-once-consumer',
      capabilityAllowed: true,
      seen: new Set([`exactly-once-consumer|${eventId}`]),
      retryPolicy: { maxAttempts: 5 },
      sideEffect: witnessInsert,
    });
    await app.query('COMMIT');
    expect(outcome.action).toBe('skip-duplicate');
    expect(outcome.effected).toBe(false);
    // The effect ran EXACTLY ONCE despite the crash + replay.
    expect(await witnessCount(eventId)).toBe(1);
    const status = await boundQuery<{ status: string }>(
      northwind,
      `SELECT status FROM events.outbox_delivery WHERE event_id = '${eventId}'`,
    );
    expect(status.rows[0]?.status).toBe('published');

    await cleanupOutbox(eventId);
  });

  it('EV-10 first sighting publishes once; a capability denied at drain parks with no effect', async () => {
    const eventId = nextTestId();
    await app.query('BEGIN');
    await bind(northwind);
    await runOutboxCommit(app, { envelope: testEnvelope(eventId) });
    // First sighting: the inbox INSERT wins, the side effect runs once, the
    // delivery is marked published — all in this transaction.
    const claimed = await claimPendingDeliveries(app, { nowIso: futureNow, limit: 50 });
    const target = req(claimed.find((entry) => entry.envelope.eventId === eventId));
    const first = await deliverClaimedEvent(app, {
      claimed: target,
      consumer: 'first-sighting-consumer',
      capabilityAllowed: true,
      seen: new Set(),
      retryPolicy: { maxAttempts: 5 },
      sideEffect: witnessInsert,
    });
    await app.query('COMMIT');
    expect(first.action).toBe('publish');
    expect(first.effected).toBe(true);
    expect(await witnessCount(eventId)).toBe(1);

    // A denied-at-drain delivery on a fresh event parks: no inbox row, no effect.
    const parkedId = nextTestId();
    await app.query('BEGIN');
    await bind(northwind);
    await runOutboxCommit(app, { envelope: testEnvelope(parkedId) });
    const parkedClaim = await claimPendingDeliveries(app, { nowIso: futureNow, limit: 50 });
    const parkedTarget = req(parkedClaim.find((entry) => entry.envelope.eventId === parkedId));
    const parked = await deliverClaimedEvent(app, {
      claimed: parkedTarget,
      consumer: 'denied-consumer',
      capabilityAllowed: false,
      seen: new Set(),
      retryPolicy: { maxAttempts: 5 },
      sideEffect: witnessInsert,
    });
    await app.query('COMMIT');
    expect(parked.action).toBe('park-denied');
    expect(await witnessCount(parkedId)).toBe(0);
    const parkedStatus = await boundQuery<{ status: string; count: string }>(
      northwind,
      `SELECT d.status,
              (SELECT count(*)::text FROM events.inbox WHERE event_id = '${parkedId}') AS count
         FROM events.outbox_delivery d WHERE d.event_id = '${parkedId}'`,
    );
    expect(parkedStatus.rows[0]?.status).toBe('pending');
    expect(parkedStatus.rows[0]?.count).toBe('0');

    await cleanupOutbox(eventId);
    await cleanupOutbox(parkedId);
  });

  it('EV-11 FWD-CAP-QUEUE: drainOnce re-checks the capability at drain — a below-floor grant parks', async () => {
    const eventId = nextTestId();
    await app.query('BEGIN');
    await bind(northwind);
    await runOutboxCommit(app, { envelope: testEnvelope(eventId) });
    await app.query('COMMIT');

    // Grant sits at scaffolded — below the simulated floor — so the drain check
    // denies and the event parks (no side effect), even though it is due.
    await app.query('BEGIN');
    await bind(northwind);
    const parkedReport = await drainOnce(app, {
      registry: capabilityRegistryV1,
      grants: grantEventSpine('scaffolded'),
      consumer: {
        consumer: 'drain-consumer',
        capabilityId: 'platform.event-spine',
        minimumState: 'simulated',
        sideEffect: witnessInsert,
      },
      retryPolicy: { maxAttempts: 5 },
      limit: 50,
      nowIso: futureNow,
    });
    await app.query('COMMIT');
    expect(parkedReport.parked).toBeGreaterThanOrEqual(1);
    expect(await witnessCount(eventId)).toBe(0);

    // Raise the grant to simulated — the same event now publishes exactly once.
    await app.query('BEGIN');
    await bind(northwind);
    const publishedReport = await drainOnce(app, {
      registry: capabilityRegistryV1,
      grants: grantEventSpine('simulated'),
      consumer: {
        consumer: 'drain-consumer',
        capabilityId: 'platform.event-spine',
        minimumState: 'simulated',
        sideEffect: witnessInsert,
      },
      retryPolicy: { maxAttempts: 5 },
      limit: 50,
      nowIso: futureNow,
    });
    await app.query('COMMIT');
    expect(publishedReport.published).toBeGreaterThanOrEqual(1);
    expect(await witnessCount(eventId)).toBe(1);

    // drainOnce also drained the seeded pending event (it was due too); restore
    // it and drop the drain-consumer inbox rows so the seeded posture is intact.
    const seededPending = req(syntheticEventsSeedV1.records[1]).envelope.eventId;
    await owner.query(
      `UPDATE events.outbox_delivery
          SET status = 'pending', published_at = NULL, attempts = 0, last_error = NULL
        WHERE event_id = $1`,
      [seededPending],
    );
    await owner.query(`DELETE FROM events.inbox WHERE consumer = 'drain-consumer'`);
    await cleanupOutbox(eventId);
  });

  it('EV-12 every seeded spine row carries the synthetic watermark', async () => {
    for (const table of eventsTables) {
      const result = await owner.query(
        `SELECT count(*)::text AS count FROM ${table} WHERE synthetic IS DISTINCT FROM true`,
      );
      expect(result.rows[0]?.count, `${table} must be fully watermarked`).toBe('0');
    }
  });

  it('EV-13 idempotency across modules: 0010 re-applies, 0001 re-applies after it, postures hold', async () => {
    await owner.query(readFileSync(`${repoRoot}modules/events/migrations/0010-events.sql`, 'utf8'));
    await owner.query(
      readFileSync(`${repoRoot}modules/platform-core/migrations/0001-tenancy.sql`, 'utf8'),
    );
    const seeded = req(syntheticEventsSeedV1.records[0]).envelope.eventId;
    expect(
      await boundQueryError(
        northwind,
        `UPDATE events.outbox SET type = 'test.reopened' WHERE event_id = '${seeded}'`,
      ),
    ).toBe('42501');
  });

  it('EV-14 forced RLS is live; an unbound session reads zero rows and cannot write', async () => {
    const unprotected = await owner.query(
      `SELECT count(*)::text AS count FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'events' AND c.relkind = 'r'
         AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`,
    );
    expect(unprotected.rows[0]?.count).toBe('0');
    for (const table of eventsTables) {
      const result = await app.query(`SELECT count(*)::text AS count FROM ${table}`);
      expect(result.rows[0]?.count, `${table} must be empty without a binding`).toBe('0');
    }
    await expect(app.query(forgedOutbox(nextTestId()))).rejects.toMatchObject({ code: '42501' });
  });

  it('EV-15 the seeded delivery projection covers every outbox event; the posture holds at rest', async () => {
    const posture = await boundQuery<{
      outbox: string;
      published: string;
      pending: string;
      inbox: string;
      orphans: string;
    }>(
      northwind,
      `SELECT (SELECT count(*) FROM events.outbox)::text AS outbox,
              (SELECT count(*) FROM events.outbox_delivery WHERE status = 'published')::text AS published,
              (SELECT count(*) FROM events.outbox_delivery WHERE status = 'pending')::text AS pending,
              (SELECT count(*) FROM events.inbox)::text AS inbox,
              (SELECT count(*) FROM events.outbox o
                 WHERE NOT EXISTS (SELECT FROM events.outbox_delivery d
                                    WHERE d.tenant_id = o.tenant_id AND d.event_id = o.event_id))::text AS orphans`,
    );
    expect(posture.rows[0]).toEqual({
      outbox: '3',
      published: '2',
      pending: '1',
      inbox: '2',
      orphans: '0',
    });
  });
});
