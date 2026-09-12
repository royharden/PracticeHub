import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openBreachCase, recordAffectedScope, type BreachCaseEvent } from './breach-case.js';
import { appendBreachEvents, createBreachCase, loadBreachCase } from './breach-case-store.js';
import { breachCaseRlsSpecs } from './rls-specs.js';

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
const migration = `${repoRoot}modules/breach-case/migrations/0030-breach-case.sql`;
const rollback = `${repoRoot}modules/breach-case/migrations/0030-breach-case.rollback.sql`;
const seed = `${repoRoot}infra/postgres/seed/029-breach-case-seed.sql`;
const northwind = 'northwind-synthetic';

let owner: Client;
let app: Client;

async function bound<T extends Record<string, unknown>>(
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

async function rejected(sql: string): Promise<string> {
  try {
    await bound(northwind, sql);
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  throw new Error('expected database operation to be rejected');
}

async function withFreshTransaction<T>(operation: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(appConfig);
  await client.connect();
  await client.query('BEGIN');
  try {
    await client.query(tenantBindingSql(northwind));
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  owner = new Client(ownerConfig);
  await owner.connect();
  for (const file of [
    'infra/postgres/init/001-bootstrap.sql',
    'modules/platform-core/migrations/0001-tenancy.sql',
    'infra/postgres/init/002-seed.sql',
    'infra/postgres/seed/003-tenancy-seed.sql',
  ]) {
    await owner.query(readFileSync(`${repoRoot}${file}`, 'utf8'));
  }
  await owner.query(readFileSync(migration, 'utf8'));
  await owner.query(readFileSync(seed, 'utf8'));
  app = new Client(appConfig);
  await app.connect();
}, 60000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
});

describe('breach-case live RLS, append-only posture, and reconstruction', () => {
  it('BC-DB-01 fails closed unbound and filters both tenant directions', async () => {
    const unbound = await app.query('SELECT count(*)::int AS n FROM breach_case.breach_case');
    expect((unbound.rows[0] as { n: number }).n).toBe(0);
    const northwindRows = await bound<{ tenant_id: string }>(
      northwind,
      'SELECT tenant_id FROM breach_case.breach_case',
    );
    expect(northwindRows).toEqual([{ tenant_id: northwind }]);
    const riverbendRows = await bound<{ tenant_id: string }>(
      'riverbend-synthetic',
      'SELECT tenant_id FROM breach_case.breach_case',
    );
    expect(riverbendRows).toEqual([{ tenant_id: 'riverbend-synthetic' }]);
  });

  it('BC-DB-02 rejects cross-tenant writes and append-only mutations', async () => {
    expect(
      await rejected(
        "DELETE FROM breach_case.breach_case_event WHERE tenant_id='northwind-synthetic'",
      ),
    ).toBe('42501');
    expect(
      await rejected("UPDATE breach_case.notification_evidence SET transport_state='failed'"),
    ).toBe('42501');
    expect(
      await rejected("UPDATE breach_case.genetic_targeted_review SET disposition='appropriate'"),
    ).toBe('42501');
    expect(
      await rejected(
        "INSERT INTO breach_case.effect_fence (tenant_id,event_key,case_id,intent_hash,created_at,synthetic) VALUES ('riverbend-synthetic','forged-event','synthetic-breach-assessing',repeat('a',64),now(),true)",
      ),
    ).toBe('42501');
  });

  it('BC-DB-03 exposes a positive synthetic row through every guarded table', async () => {
    for (const spec of breachCaseRlsSpecs) {
      const result = await bound<{ n: number }>(
        northwind,
        `SELECT count(*)::int AS n FROM ${spec.schema}.${spec.table}`,
      );
      expect(result[0]?.n, spec.table).toBeGreaterThan(0);
    }
  });

  it('BC-DB-04 reconstructs the seeded projection exactly from immutable payloads', async () => {
    const loaded = await withFreshTransaction((client) =>
      loadBreachCase(client, northwind, 'synthetic-breach-reportable'),
    );
    expect(loaded).toMatchObject({
      status: 'closed',
      lastEventSeq: 15,
      retentionEvidenceRef: 'retention:synthetic-breach-case',
    });
    expect(loaded?.notices[0]).toMatchObject({
      state: 'delivered',
      terminalEvidenceRef: 'receipt:synthetic-delivered-1',
    });
    expect(loaded?.geneticReviews[0]).toMatchObject({
      risk: 'critical',
      reviewerRef: 'person:synthetic-reviewer',
    });
  });

  it('BC-DB-05 caller rollback leaves neither projection nor event/fence residue', async () => {
    const aggregate = openBreachCase({
      tenantId: northwind,
      caseId: 'rollback-case',
      sourceKind: 'manual',
      sourceRef: 'incident:rollback-case',
      incidentAt: '2026-03-08T10:00:00Z',
      discoveryAt: '2026-03-08T10:01:00Z',
      ownerRef: 'compliance:officer',
      actorRef: 'system:test',
      eventKey: 'rollback-open',
    });
    const client = new Client(appConfig);
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(tenantBindingSql(northwind));
      await createBreachCase(client, aggregate);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
    const rows = await bound<{ n: number }>(
      northwind,
      "SELECT count(*)::int AS n FROM breach_case.breach_case WHERE case_id='rollback-case'",
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('BC-DB-06 serializes a two-client append race and replays the winning key idempotently', async () => {
    const initial = openBreachCase({
      tenantId: northwind,
      caseId: 'race-case',
      sourceKind: 'manual',
      sourceRef: 'incident:race-case',
      incidentAt: '2026-03-08T11:00:00Z',
      discoveryAt: '2026-03-08T11:01:00Z',
      ownerRef: 'compliance:officer',
      actorRef: 'system:test',
      eventKey: 'race-open',
    });
    await withFreshTransaction((client) => createBreachCase(client, initial));
    const changed = recordAffectedScope(initial, {
      subjectRefs: [],
      queryEvidenceRef: 'audit-query:race',
      windowStart: '2026-03-08T10:00:00Z',
      windowEnd: '2026-03-08T11:01:00Z',
      complete: true,
      limitationRef: null,
      recordedAt: '2026-03-08T11:02:00Z',
      actorRef: 'system:test',
      eventKey: 'race-scope',
    });
    const requested = changed.events.slice(initial.lastEventSeq) as readonly BreachCaseEvent[];
    const [left, right] = await Promise.all([
      withFreshTransaction((client) =>
        appendBreachEvents(client, northwind, initial.caseId, requested),
      ),
      withFreshTransaction((client) =>
        appendBreachEvents(client, northwind, initial.caseId, requested),
      ),
    ]);
    expect(left.lastEventSeq).toBe(2);
    expect(right.lastEventSeq).toBe(2);
    const fences = await bound<{ n: number }>(
      northwind,
      "SELECT count(*)::int AS n FROM breach_case.effect_fence WHERE event_key='race-scope'",
    );
    expect(fences[0]?.n).toBe(1);
  });

  it('BC-DB-06B replays identical intake across fresh clients and rejects changed intent', async () => {
    const initial = openBreachCase({
      tenantId: northwind,
      caseId: 'intake-replay-case',
      sourceKind: 'manual',
      sourceRef: 'incident:intake-replay',
      incidentAt: '2026-03-08T12:00:00Z',
      discoveryAt: '2026-03-08T12:01:00Z',
      ownerRef: 'compliance:officer',
      actorRef: 'system:test',
      eventKey: 'intake-replay-open',
    });
    const first = await withFreshTransaction((client) => createBreachCase(client, initial));
    const replay = await withFreshTransaction((client) => createBreachCase(client, initial));
    expect(replay.events).toEqual(first.events);
    const changed = openBreachCase({
      tenantId: northwind,
      caseId: 'intake-replay-case',
      sourceKind: 'manual',
      sourceRef: 'incident:intake-replay-changed',
      incidentAt: '2026-03-08T12:00:00Z',
      discoveryAt: '2026-03-08T12:01:00Z',
      ownerRef: 'compliance:other-officer',
      actorRef: 'system:test',
      eventKey: 'intake-replay-open',
    });
    await expect(
      withFreshTransaction((client) => createBreachCase(client, changed)),
    ).rejects.toThrow(/changed intent/);
  });

  it('BC-DB-07 rejects structural ambiguity in scope and notice terminal evidence', async () => {
    expect(
      await rejected(
        "INSERT INTO breach_case.affected_scope_version (tenant_id,case_id,version,event_seq,event_type,content_hash,query_evidence_ref,window_start,window_end,complete,limitation_ref,recorded_at,synthetic) VALUES ('northwind-synthetic','synthetic-breach-reportable',99,2,'scope-versioned',repeat('a',64),'audit-query:x',now(),now(),false,NULL,now(),true)",
      ),
    ).toBe('23514');
    expect(
      await rejected(
        "INSERT INTO breach_case.notification_evidence (tenant_id,case_id,notice_id,event_seq,event_type,duty_id,audience,payload_ref,prepared_by,prepared_at,approved_by,approved_at,effect_key,transport_state,terminal_evidence_ref,synthetic) VALUES ('northwind-synthetic','synthetic-breach-reportable','bad-notice',99,'notice-recorded','synthetic-floor-duty','individual','payload:x','person:x',now(),'person:y',now(),'effect:x','accepted','receipt:not-terminal',true)",
      ),
    ).toBe('23514');
    expect(
      await rejected(
        "INSERT INTO breach_case.effect_fence (tenant_id,event_key,case_id,intent_hash,created_at,synthetic) VALUES ('northwind-synthetic','not-synthetic','synthetic-breach-reportable',repeat('b',64),now(),false)",
      ),
    ).toBe('23514');
    expect(
      await rejected(
        "UPDATE breach_case.breach_case SET current_scope_version=999 WHERE case_id='synthetic-breach-reportable'",
      ),
    ).toBe('23503');
    expect(
      await rejected(
        "INSERT INTO breach_case.breach_case_event (tenant_id,case_id,event_seq,event_key,event_type,occurred_at,actor_ref,payload,payload_hash,synthetic) VALUES ('northwind-synthetic','synthetic-breach-reportable',99,'bad-payload','case-reopened',now(),'person:x','{\"tenantId\":\"riverbend-synthetic\",\"synthetic\":true}'::jsonb,repeat('c',64),true)",
      ),
    ).toBe('23514');
    expect(
      await rejected(
        "INSERT INTO breach_case.breach_case_event (tenant_id,case_id,event_seq,event_key,event_type,occurred_at,actor_ref,payload,payload_hash,synthetic) VALUES ('northwind-synthetic','synthetic-breach-reportable',99,'missing-payload-tuple','case-reopened',now(),'person:x','{\"synthetic\":true}'::jsonb,repeat('d',64),true)",
      ),
    ).toBe('23514');
    expect(
      await rejected(
        "INSERT INTO breach_case.notification_evidence (tenant_id,case_id,notice_id,event_seq,event_type,duty_id,audience,payload_ref,prepared_by,prepared_at,approved_by,approved_at,effect_intent_key,effect_key,transport_state,terminal_evidence_ref,synthetic) VALUES ('northwind-synthetic','synthetic-breach-reportable','orphan-notice',999,'notice-recorded','synthetic-floor-duty','individual','payload:orphan','person:author',now(),NULL,NULL,NULL,NULL,'prepared',NULL,true)",
      ),
    ).toBe('23503');
  });

  it('BC-DB-08 proves forward/rollback/forward and seed re-apply', async () => {
    await app.end();
    await owner.query(readFileSync(rollback, 'utf8'));
    await owner.query(readFileSync(migration, 'utf8'));
    await owner.query(readFileSync(seed, 'utf8'));
    await owner.query(readFileSync(migration, 'utf8'));
    app = new Client(appConfig);
    await app.connect();
    const rows = await bound<{ n: number }>(
      northwind,
      'SELECT count(*)::int AS n FROM breach_case.breach_case',
    );
    expect(rows[0]?.n).toBe(1);
  });
});
