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
  markDeliveryFailed,
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
  'modules/events/migrations/0028-event-delivery-parks.sql',
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

async function eventTransaction<T>(body: () => Promise<T>): Promise<T> {
  await app.query('BEGIN');
  try {
    await bind(northwind);
    const result = await body();
    await app.query('COMMIT');
    return result;
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

async function deliveryState(eventId: string) {
  const result = await boundQuery<{
    status: string;
    attempts: number;
    park_count: number;
    due: string;
    inbox_count: number;
  }>(
    northwind,
    `SELECT status, attempts, park_count,
            to_char(next_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS due,
            (SELECT count(*)::int FROM events.inbox WHERE event_id = '${eventId}') AS inbox_count
       FROM events.outbox_delivery WHERE event_id = '${eventId}'`,
  );
  return req(result.rows[0]);
}

async function claimTestEvent(eventId: string, nowIso: string) {
  const claimed = await claimPendingDeliveries(app, { nowIso, limit: 50 });
  return req(claimed.find((entry) => entry.envelope.eventId === eventId));
}

async function parkTestEvent(eventId: string, nowIso: string) {
  return eventTransaction(async () => {
    const claimed = await claimTestEvent(eventId, nowIso);
    return deliverClaimedEvent(app, {
      claimed,
      consumer: 'park-repair-consumer',
      capabilityAllowed: false,
      seen: new Set(),
      retryPolicy: { maxAttempts: 3 },
      nowIso,
      sideEffect: witnessInsert,
    });
  });
}

async function failTestPublish(eventId: string, nowIso: string, maxAttempts: number) {
  await expect(
    eventTransaction(async () => {
      const claimed = await claimTestEvent(eventId, nowIso);
      await deliverClaimedEvent(app, {
        claimed,
        consumer: 'park-repair-consumer',
        capabilityAllowed: true,
        seen: new Set(),
        retryPolicy: { maxAttempts },
        nowIso,
        sideEffect: async (exec, event) => {
          await witnessInsert(exec, event);
          throw new Error('synthetic-publish-failure');
        },
      });
    }),
  ).rejects.toThrow('synthetic-publish-failure');
  // A real transaction rollback removes BOTH the inbox marker and the effect.
  expect(await witnessCount(eventId)).toBe(0);
  expect((await deliveryState(eventId)).inbox_count).toBe(0);
  return eventTransaction(async () => {
    // Reacquire exclusive row ownership and current state after the rollback.
    const claimed = await claimTestEvent(eventId, nowIso);
    return markDeliveryFailed(app, {
      eventId,
      delivery: claimed.delivery,
      retryPolicy: { maxAttempts },
      errorRef: 'synthetic:publish-failure',
    });
  });
}

async function withTestEvent(body: (eventId: string) => Promise<void>) {
  const eventId = nextTestId();
  try {
    await eventTransaction(() => runOutboxCommit(app, { envelope: testEnvelope(eventId) }));
    await body(eventId);
  } finally {
    await app.query('ROLLBACK');
    await cleanupOutbox(eventId);
    await app.query('DELETE FROM ev_witness WHERE event_id = $1', [eventId]);
  }
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

  it('EV-07b payload retention and producer uniqueness do not claim hash comparison', async () => {
    await withTestEvent(async (eventId) => {
      const original = testEnvelope(eventId);
      for (const payload of [original.payload, { probe: 'different-payload' }]) {
        await expect(
          eventTransaction(() =>
            runOutboxCommit(app, {
              envelope: testEnvelope(nextTestId(), {
                idempotencyKey: original.idempotencyKey,
                payload,
              }),
            }),
          ),
        ).rejects.toMatchObject({ code: '23505' });
        const persisted = await boundQuery<{ payload: unknown }>(
          northwind,
          `SELECT payload FROM events.outbox WHERE idempotency_key = '${original.idempotencyKey}'`,
        );
        expect(persisted.rows).toEqual([{ payload: original.payload }]);
      }
    });
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
    const parkedStatus = await boundQuery<{
      status: string;
      count: string;
      attempts: number;
      park_count: number;
    }>(
      northwind,
      `SELECT d.status, d.attempts, d.park_count,
              (SELECT count(*)::text FROM events.inbox WHERE event_id = '${parkedId}') AS count
         FROM events.outbox_delivery d WHERE d.event_id = '${parkedId}'`,
    );
    expect(parkedStatus.rows[0]?.status).toBe('pending');
    expect(parkedStatus.rows[0]?.count).toBe('0');
    expect(parkedStatus.rows[0]?.attempts).toBe(0);
    expect(parkedStatus.rows[0]?.park_count).toBe(1);

    await cleanupOutbox(eventId);
    await cleanupOutbox(parkedId);
  });

  it('EV-11 FWD-CAP-QUEUE: drainOnce re-checks the capability at drain — a below-floor grant parks', async () => {
    const eventId = nextTestId();
    const seedSnapshots = await owner.query<{ snapshot: Record<string, unknown> }>(
      `SELECT to_jsonb(d) AS snapshot FROM events.outbox_delivery d WHERE event_id = ANY($1::text[])`,
      [syntheticEventsSeedV1.records.map((record) => record.envelope.eventId)],
    );
    try {
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
      expect(parkedReport.outcomes.find((entry) => entry.eventId === eventId)?.action).toBe(
        'park-denied',
      );
      expect(await witnessCount(eventId)).toBe(0);
      const parkedState = await deliveryState(eventId);
      expect(parkedState.attempts).toBe(0);
      expect(parkedState.park_count).toBe(1);
      expect(Date.parse(parkedState.due) - Date.parse(futureNow)).toBe(1000);

      const earlyReport = await eventTransaction(() =>
        drainOnce(app, {
          registry: capabilityRegistryV1,
          grants: grantEventSpine('simulated'),
          consumer: {
            consumer: 'drain-consumer',
            capabilityId: 'platform.event-spine',
            sideEffect: witnessInsert,
          },
          retryPolicy: { maxAttempts: 5 },
          limit: 50,
          nowIso: futureNow,
        }),
      );
      expect(earlyReport.outcomes.some((entry) => entry.eventId === eventId)).toBe(false);
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
        nowIso: parkedState.due,
      });
      await app.query('COMMIT');
      expect(publishedReport.published).toBeGreaterThanOrEqual(1);
      expect(publishedReport.outcomes.find((entry) => entry.eventId === eventId)?.action).toBe(
        'publish',
      );
      expect(await witnessCount(eventId)).toBe(1);
    } finally {
      await app.query('ROLLBACK');
      // Restore exact seed projection values, including due time and park history.
      for (const { snapshot } of seedSnapshots.rows) {
        await owner.query(
          `UPDATE events.outbox_delivery d
              SET status = r.status, attempts = r.attempts, park_count = r.park_count,
                  next_attempt_at = r.next_attempt_at, published_at = r.published_at,
                  last_error = r.last_error
             FROM jsonb_populate_record(NULL::events.outbox_delivery, $1::jsonb) r
            WHERE d.tenant_id = r.tenant_id AND d.event_id = r.event_id`,
          [JSON.stringify(snapshot)],
        );
      }
      await owner.query(`DELETE FROM events.inbox WHERE consumer = 'drain-consumer'`);
      await cleanupOutbox(eventId);
    }
  });

  it.each([1, 3])(
    'EV-16 NR-043 eight parks preserve all %i genuine failure attempts',
    async (maxAttempts) => {
      await withTestEvent(async (eventId) => {
        let nowIso = futureNow;
        for (let park = 0; park < 8; park += 1) {
          expect(await parkTestEvent(eventId, nowIso)).toEqual({
            action: 'park-denied',
            effected: false,
          });
          const state = await deliveryState(eventId);
          expect(state).toMatchObject({
            status: 'pending',
            attempts: 0,
            park_count: park + 1,
            inbox_count: 0,
          });
          expect(await witnessCount(eventId)).toBe(0);
          expect(Date.parse(state.due) - Date.parse(nowIso)).toBe(2 ** park * 1000);
          const beforeDue = await eventTransaction(() =>
            claimPendingDeliveries(app, {
              nowIso: new Date(Date.parse(state.due) - 1).toISOString(),
              limit: 50,
            }),
          );
          expect(beforeDue.some((entry) => entry.envelope.eventId === eventId)).toBe(false);
          const atDue = await eventTransaction(() =>
            claimPendingDeliveries(app, { nowIso: state.due, limit: 50 }),
          );
          expect(atDue.some((entry) => entry.envelope.eventId === eventId)).toBe(true);
          nowIso = state.due;
        }
        for (let failure = 1; failure <= maxAttempts; failure += 1) {
          expect(await failTestPublish(eventId, nowIso, maxAttempts)).toBe(
            failure === maxAttempts ? 'dead-letter' : 'retry-later',
          );
          expect(await deliveryState(eventId)).toMatchObject({
            status: failure === maxAttempts ? 'dead' : 'failed',
            attempts: failure,
            park_count: 8,
            inbox_count: 0,
          });
        }
        const terminal = await eventTransaction(() =>
          deliverClaimedEvent(app, {
            claimed: {
              envelope: testEnvelope(eventId),
              delivery: { status: 'dead', attempts: maxAttempts },
            },
            consumer: 'park-repair-consumer',
            capabilityAllowed: false,
            seen: new Set(),
            retryPolicy: { maxAttempts },
            nowIso,
            sideEffect: witnessInsert,
          }),
        );
        expect(terminal).toEqual({ action: 'noop', effected: false });
        expect(await witnessCount(eventId)).toBe(0);
        expect((await deliveryState(eventId)).park_count).toBe(8);
      });
    },
  );

  it('EV-17 a failed delivery can park then recover exactly once without erasing its failure', async () => {
    await withTestEvent(async (eventId) => {
      expect(await failTestPublish(eventId, futureNow, 3)).toBe('retry-later');
      let nowIso = futureNow;
      for (let park = 0; park < 2; park += 1) {
        await parkTestEvent(eventId, nowIso);
        const state = await deliveryState(eventId);
        expect(state).toMatchObject({ status: 'failed', attempts: 1, park_count: park + 1 });
        nowIso = state.due;
      }
      const successfulClaim = await eventTransaction(async () => {
        const claimed = await claimTestEvent(eventId, nowIso);
        expect(
          await deliverClaimedEvent(app, {
            claimed,
            consumer: 'park-repair-consumer',
            capabilityAllowed: true,
            seen: new Set(),
            retryPolicy: { maxAttempts: 3 },
            nowIso,
            sideEffect: witnessInsert,
          }),
        ).toEqual({ action: 'publish', effected: true });
        return claimed;
      });
      expect(await deliveryState(eventId)).toMatchObject({
        status: 'published',
        attempts: 2,
        park_count: 2,
        inbox_count: 1,
      });
      // A stale redelivery without an inbox pre-read still loses the real INSERT gate.
      expect(
        await eventTransaction(() =>
          deliverClaimedEvent(app, {
            claimed: successfulClaim,
            consumer: 'park-repair-consumer',
            capabilityAllowed: true,
            seen: new Set(),
            retryPolicy: { maxAttempts: 3 },
            nowIso,
            sideEffect: witnessInsert,
          }),
        ),
      ).toEqual({ action: 'publish', effected: false });
      expect(await witnessCount(eventId)).toBe(1);
      expect(await deliveryState(eventId)).toMatchObject({
        status: 'published',
        attempts: 2,
        park_count: 2,
        inbox_count: 1,
      });
    });
  });

  it('EV-18 park backoff caps deterministically and the counter saturates without overflow', async () => {
    await withTestEvent(async (eventId) => {
      for (const [prior, expectedDelay, expectedCount] of [
        [0, 1, 1],
        [8, 256, 9],
        [9, 300, 10],
        [2147483647, 300, 2147483647],
      ] as const) {
        await owner.query(
          `UPDATE events.outbox_delivery SET park_count = $2, next_attempt_at = $3 WHERE event_id = $1`,
          [eventId, prior, futureNow],
        );
        await parkTestEvent(eventId, futureNow);
        const state = await deliveryState(eventId);
        expect(state.park_count).toBe(expectedCount);
        expect(state.attempts).toBe(0);
        expect(Date.parse(state.due) - Date.parse(futureNow)).toBe(expectedDelay * 1000);
      }
      expect(
        await boundQueryError(
          northwind,
          `UPDATE events.outbox_delivery SET park_count = -1 WHERE event_id = '${eventId}'`,
        ),
      ).toBe('23514');
      expect((await deliveryState(eventId)).park_count).toBe(2147483647);
    });
  });

  it('EV-19 parking rolls back completely and direct callers retain the database clock', async () => {
    await withTestEvent(async (eventId) => {
      const before = await deliveryState(eventId);
      await app.query('BEGIN');
      await bind(northwind);
      const claimed = await claimTestEvent(eventId, futureNow);
      await deliverClaimedEvent(app, {
        claimed,
        consumer: 'park-repair-consumer',
        capabilityAllowed: false,
        seen: new Set(),
        retryPolicy: { maxAttempts: 3 },
        sideEffect: witnessInsert,
      });
      const check = await app.query<{ exact_delay: boolean; park_count: number; attempts: number }>(
        `SELECT next_attempt_at = now() + interval '1 second' AS exact_delay, park_count, attempts
           FROM events.outbox_delivery WHERE event_id = $1`,
        [eventId],
      );
      expect(check.rows[0]).toEqual({ exact_delay: true, park_count: 1, attempts: 0 });
      await app.query('ROLLBACK');
      expect(await deliveryState(eventId)).toEqual(before);
      expect(await witnessCount(eventId)).toBe(0);
    });
  });

  it.each(['pending', 'failed'])(
    'EV-20 migration refuses ambiguous legacy %s attempts without backfill',
    async (status) => {
      await withTestEvent(async (eventId) => {
        const migration = readFileSync(
          `${repoRoot}modules/events/migrations/0028-event-delivery-parks.sql`,
          'utf8',
        );
        await owner.query('BEGIN');
        try {
          // Transactional DDL reconstructs the old shape; ROLLBACK restores every byte of state.
          await owner.query('ALTER TABLE events.outbox_delivery DROP COLUMN park_count');
          await owner.query(
            'UPDATE events.outbox_delivery SET status = $2, attempts = 2 WHERE event_id = $1',
            [eventId, status],
          );
          await owner.query('SAVEPOINT legacy_guard');
          await expect(owner.query(migration)).rejects.toThrow(
            'reviewed legacy attempt classification',
          );
          await owner.query('ROLLBACK TO SAVEPOINT legacy_guard');
          const columns = await owner.query(`SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'events' AND table_name = 'outbox_delivery' AND column_name = 'park_count'`);
          expect(columns.rows).toHaveLength(0);
          const legacy = await owner.query(
            'SELECT status, attempts FROM events.outbox_delivery WHERE event_id = $1',
            [eventId],
          );
          expect(legacy.rows[0]).toEqual({ status, attempts: 2 });
        } finally {
          await owner.query('ROLLBACK');
        }
        expect(await deliveryState(eventId)).toMatchObject({
          status: 'pending',
          attempts: 0,
          park_count: 0,
        });
      });
    },
  );

  it('EV-21 migration applies to the old clean shape and reapplication preserves new history', async () => {
    await withTestEvent(async (eventId) => {
      const migration = readFileSync(
        `${repoRoot}modules/events/migrations/0028-event-delivery-parks.sql`,
        'utf8',
      );
      const rollback = readFileSync(
        `${repoRoot}modules/events/migrations/0028-event-delivery-parks.rollback.sql`,
        'utf8',
      );
      await owner.query('BEGIN');
      try {
        await owner.query('ALTER TABLE events.outbox_delivery DROP COLUMN park_count');
        await owner.query(migration);
        const fresh = await owner.query(
          'SELECT park_count FROM events.outbox_delivery WHERE event_id = $1',
          [eventId],
        );
        expect(fresh.rows[0]).toEqual({ park_count: 0 });
        await owner.query(
          `UPDATE events.outbox_delivery SET status = 'failed', attempts = 1, park_count = 4 WHERE event_id = $1`,
          [eventId],
        );
        await owner.query(migration);
        const reapplied = await owner.query(
          'SELECT status, attempts, park_count FROM events.outbox_delivery WHERE event_id = $1',
          [eventId],
        );
        expect(reapplied.rows[0]).toEqual({ status: 'failed', attempts: 1, park_count: 4 });
        await owner.query('SAVEPOINT preserve_parks');
        await expect(owner.query(rollback)).rejects.toThrow('preserves nonzero park history');
        await owner.query('ROLLBACK TO SAVEPOINT preserve_parks');
        const preserved = await owner.query(
          'SELECT park_count FROM events.outbox_delivery WHERE event_id = $1',
          [eventId],
        );
        expect(preserved.rows[0]).toEqual({ park_count: 4 });
      } finally {
        await owner.query('ROLLBACK');
      }
    });
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
