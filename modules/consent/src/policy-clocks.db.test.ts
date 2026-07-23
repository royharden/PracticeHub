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

import { foldClocks, type ObligationClockEvent } from './clocks.js';
import { policyClockRlsSpecs } from './rls-specs.js';

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

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

/**
 * Run `sql` as the OWNER and return the rejection SQLSTATE. Used to probe the
 * counsel-registry CHECK constraints (obligation_clock_policy): the app role can
 * no longer INSERT there (review-016 F1 revoke → 42501 before any CHECK), so the
 * STRUCTURAL rule must be proven through a principal that CAN insert — the CHECK
 * applies to every role, the privilege revoke does not mask it.
 */
async function ownerQueryError(sql: string): Promise<string> {
  try {
    await owner.query(sql);
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
  throw new Error(`expected ${sql} to be rejected`);
}

/**
 * Run `sql` inside an OPEN transaction under a savepoint and assert it is
 * rejected with `code`, then recover the transaction (ROLLBACK TO SAVEPOINT) so
 * subsequent statements run. Lets a single rolled-back transaction chain a
 * committed-in-txn prerequisite row with several negatives — nothing is
 * persisted, so the shared stack the probes assert is never disturbed.
 */
async function expectSavepointError(sql: string, code: string): Promise<void> {
  await app.query('SAVEPOINT sp');
  let caught: string | undefined;
  try {
    await app.query(sql);
  } catch (error) {
    caught = (error as { code?: string }).code ?? String(error);
  }
  await app.query('ROLLBACK TO SAVEPOINT sp');
  expect(caught, sql).toBe(code);
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
    // review-016 F3: a trigger event carries the full rebuild metadata.
    trigger_ref: `'records-request:forge'`,
    escalate_at: `'2026-03-21T00:00:00Z'`,
    owner_role: `'compliance'`,
    governing_policy_ref: `'records-request-closure:floor:v1'`,
    synthetic: 'true',
    ...overrides,
  };
  const columns = Object.keys(fields).join(', ');
  const values = Object.values(fields).join(', ');
  return `INSERT INTO consent.obligation_clock_event (${columns}) VALUES (${values})`;
}

/** A valid disclosure consent-event INSERT (renewal-lineage negatives, F5). */
function forgedConsentEvent(id: string, overrides: Readonly<Record<string, string>> = {}): string {
  const fields: Record<string, string> = {
    tenant_id: `'northwind-synthetic'`,
    consent_event_id: `'${id}'`,
    person_ref: `'np-db-lineage'`,
    scope_type: `'disclosure'`,
    scope_key: `'disclosure|purpose=treatment|recipient=synthetic-recipient:db|record=general'`,
    purpose: `'treatment'`,
    recipient_ref: `'synthetic-recipient:db'`,
    record_type: `'general'`,
    action: `'grant'`,
    resulting_state: `'opted_in'`,
    effective_at: `'2026-01-15T00:00:00Z'`,
    source: `'paper_form'`,
    evidence_ref: `'synthetic-consent:db-lineage'`,
    jurisdiction: `'MN'`,
    policy_version: `'records-consent-v1'`,
    synthetic: 'true',
    ...overrides,
  };
  const columns = Object.keys(fields).join(', ');
  const values = Object.values(fields).join(', ');
  return `INSERT INTO consent.consent_event (${columns}) VALUES (${values})`;
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
    // Probed as OWNER: the app role's INSERT on the counsel registry is revoked
    // (review-016 F1), so the CHECK is proven through a principal that can insert.
    expect(
      await ownerQueryError(
        forgedPolicy({
          obligation_type: `'mhra-renewal'`,
          jurisdiction: `'MN'`,
          duration_days: '30',
        }),
      ),
    ).toBe('23514');
    // a duration-basis policy with no duration is unrepresentable.
    expect(await ownerQueryError(forgedPolicy({ duration_days: 'NULL' }))).toBe('23514');
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
    // review-016 F3: a trigger event lacking its rebuild metadata is
    // unrepresentable (the projection would not be replayable).
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('pdbf-0005', { trigger_ref: 'NULL' }),
      ),
    ).toBe('23514');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('pdbf-0006', { owner_role: 'NULL' }),
      ),
    ).toBe('23514');
    // review-016 F5: a rule-pack-review satisfy without STRUCTURED evidence (a
    // change-control ref + a truth-table receipt) is unrepresentable.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('pdbf-0007', {
          obligation_type: `'rule-pack-review'`,
          kind: `'satisfy'`,
          due_at: 'NULL',
          evidence_ref: `'ccr-statute-db'`,
        }),
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

  it('PC-11 the DB projection equals foldClocks(DB event log) field-for-field (review-016 F3)', async () => {
    // Read the append-only event log and rebuild the projection from it ALONE,
    // then compare field-for-field to the stored projection (no seeded rows in
    // the fold — the trigger events carry every rebuild field).
    const eventRows = (
      await boundQuery<Record<string, string | null>>(
        'northwind-synthetic',
        `SELECT tenant_id, clock_event_id, clock_id, obligation_type, kind, subject_ref,
                to_char(occurred_at AT TIME ZONE 'UTC', ${ISO}) AS occurred_at,
                to_char(due_at AT TIME ZONE 'UTC', ${ISO}) AS due_at,
                evidence_ref, evidence_hash, actor_ref, reason,
                trigger_ref, to_char(escalate_at AT TIME ZONE 'UTC', ${ISO}) AS escalate_at,
                owner_role, governing_policy_ref, change_control_ref, truth_table_receipt_ref
           FROM consent.obligation_clock_event
          ORDER BY clock_id, (kind <> 'trigger'), occurred_at, clock_event_id`,
      )
    ).rows;
    const events: ObligationClockEvent[] = eventRows.map((row) => ({
      tenantId: row['tenant_id'] as string,
      clockEventId: row['clock_event_id'] as string,
      clockId: row['clock_id'] as string,
      obligationType: row['obligation_type'] as ObligationClockEvent['obligationType'],
      kind: row['kind'] as ObligationClockEvent['kind'],
      subjectRef: row['subject_ref'] as string,
      occurredAt: row['occurred_at'] as string,
      ...(row['due_at'] !== null ? { dueAt: row['due_at'] as string } : {}),
      ...(row['evidence_ref'] !== null ? { evidenceRef: row['evidence_ref'] as string } : {}),
      ...(row['evidence_hash'] !== null ? { evidenceHash: row['evidence_hash'] as string } : {}),
      actorRef: row['actor_ref'] as string,
      ...(row['reason'] !== null ? { reason: row['reason'] as string } : {}),
      ...(row['trigger_ref'] !== null ? { triggerRef: row['trigger_ref'] as string } : {}),
      ...(row['escalate_at'] !== null ? { escalateAt: row['escalate_at'] as string } : {}),
      ...(row['owner_role'] !== null ? { ownerRole: row['owner_role'] as string } : {}),
      ...(row['governing_policy_ref'] !== null
        ? { governingPolicyRef: row['governing_policy_ref'] as string }
        : {}),
      ...(row['change_control_ref'] !== null
        ? { changeControlRef: row['change_control_ref'] as string }
        : {}),
      ...(row['truth_table_receipt_ref'] !== null
        ? { truthTableReceiptRef: row['truth_table_receipt_ref'] as string }
        : {}),
      synthetic: true,
    }));
    const folded = foldClocks(events);

    const projRows = (
      await boundQuery<Record<string, string | boolean | null>>(
        'northwind-synthetic',
        `SELECT clock_id, obligation_type, subject_ref, trigger_ref,
                to_char(triggered_at AT TIME ZONE 'UTC', ${ISO}) AS triggered_at,
                to_char(due_at AT TIME ZONE 'UTC', ${ISO}) AS due_at,
                to_char(escalate_at AT TIME ZONE 'UTC', ${ISO}) AS escalate_at,
                status, owner_role, closure_evidence_ref, expire_fired, last_event_id
           FROM consent.obligation_clock ORDER BY clock_id`,
      )
    ).rows;
    expect(projRows.length).toBeGreaterThan(0);
    for (const row of projRows) {
      const instance = folded.get(`northwind-synthetic|${row['clock_id'] as string}`);
      expect(instance, `clock ${row['clock_id']} must rebuild from the log`).toBeDefined();
      expect(instance?.obligationType).toBe(row['obligation_type']);
      expect(instance?.subjectRef).toBe(row['subject_ref']);
      expect(instance?.triggerRef).toBe(row['trigger_ref']);
      expect(instance?.triggeredAt).toBe(row['triggered_at']);
      expect(instance?.dueAt).toBe(row['due_at']);
      expect(instance?.escalateAt).toBe(row['escalate_at']);
      expect(instance?.status).toBe(row['status']);
      expect(instance?.ownerRole).toBe(row['owner_role']);
      expect(instance?.closureEvidenceRef ?? null).toBe(row['closure_evidence_ref']);
      expect(instance?.expireFired).toBe(row['expire_fired']);
      expect(instance?.lastEventId).toBe(row['last_event_id']);
    }
    // The seed exercises ALL FIVE event kinds so the fold is proven end-to-end.
    const kinds = new Set(events.map((event) => event.kind));
    for (const kind of ['trigger', 'escalate', 'satisfy', 'cancel', 'expire-fired'] as const) {
      expect(kinds.has(kind), `kind ${kind} must be seeded`).toBe(true);
    }
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

  it('PC-13 the counsel-owned registries are RUNTIME READ-ONLY for the app role (review-016 F1)', async () => {
    // A normal app principal (module_consent, inherited by practicehub_app)
    // cannot forge a highest-version platform-global clock policy that would
    // govern every tenant — INSERT is revoked, exactly like jurisdiction packs.
    expect(await boundQueryError('northwind-synthetic', forgedPolicy({ version: '999' }))).toBe(
      '42501',
    );
    // Nor forge a tenant policy document (a counsel-signed change-controlled
    // artifact); versions arrive as change-controlled seed data (owner).
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO consent.policy_document
           (tenant_id, document_type, jurisdiction, version, effective_on, status,
            change_control_ref, content_ref, content_hash, synthetic)
         VALUES ('northwind-synthetic', 'disclosure-authorization', 'MN', 999,
                 DATE '2027-01-01', 'draft', 'ccr-forge', 'policy-doc:forge',
                 '${'a'.repeat(64)}', true)`,
      ),
    ).toBe('42501');
  });

  it('PC-14 renewal lineage is structural on the consent ledger (review-016 F5 / REQ-ADM-031 AC-3)', async () => {
    // Everything runs in ONE rolled-back transaction so no consent rows persist.
    await app.query('BEGIN');
    try {
      await app.query(tenantBindingSql('northwind-synthetic'));
      // A prior disclosure grant to renew against (visible in-transaction).
      await app.query(forgedConsentEvent('nce-db-prior'));

      // Only a renew may supersede — a GRANT carrying lineage is unrepresentable
      // (the FK resolves to the real prior; the renew-only CHECK bites).
      await expectSavepointError(
        forgedConsentEvent('nce-db-grant-lineage', {
          action: `'grant'`,
          supersedes_consent_event_id: `'nce-db-prior'`,
        }),
        '23514',
      );
      // A disclosure RENEW MUST carry lineage — a bare renew is unrepresentable.
      await expectSavepointError(
        forgedConsentEvent('nce-db-bare-renew', { action: `'renew'` }),
        '23514',
      );
      // A renew whose predecessor does not exist fails the self-FK.
      await expectSavepointError(
        forgedConsentEvent('nce-db-fk', {
          action: `'renew'`,
          supersedes_consent_event_id: `'nce-db-missing'`,
        }),
        '23503',
      );
      // A well-formed renew WITH lineage to the real prior event is accepted.
      await app.query(
        forgedConsentEvent('nce-db-good-renew', {
          action: `'renew'`,
          supersedes_consent_event_id: `'nce-db-prior'`,
        }),
      );
    } finally {
      await app.query('ROLLBACK');
    }
  });
});
