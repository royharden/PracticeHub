/**
 * DB-level consent suite (WP-018 verification gate). Cross-tenant negatives,
 * the append-only event log (R6-REQ-071: no app role edits or deletes it), the
 * structural scope/action/CHD/genetic/disclosure CHECKs, the projection FK, and
 * the live projection posture. Requires the app-postgres from compose.yaml (or
 * the CI service container) on 127.0.0.1:55432.
 *
 * Every INSERT is a NEGATIVE (must fail); positive controls read the SEEDED
 * rows, so the state the local:test probes assert is never disturbed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { consentRlsSpecs } from './rls-specs.js';

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
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/011-consent-seed.sql',
];

const consentTables = consentRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`);

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
    consent_event_id: `'${id}'`,
    person_ref: `'np-db-forge'`,
    scope_type: `'communication'`,
    scope_key: `'communication|channel=sms|purpose=treatment'`,
    channel: `'sms'`,
    purpose: `'treatment'`,
    action: `'grant'`,
    resulting_state: `'opted_in'`,
    effective_at: `'2026-03-17T00:00:00Z'`,
    source: `'portal_form'`,
    jurisdiction: `'NV'`,
    policy_version: `'consent-v1'`,
    synthetic: 'true',
    ...overrides,
  };
  const columns = Object.keys(fields).join(', ');
  const values = Object.values(fields).join(', ');
  return `INSERT INTO consent.consent_event (${columns}) VALUES (${values})`;
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

describe('consent DB suite (WP-018)', () => {
  it('CN-01 positive control: a Northwind-bound session reads its consent rows', async () => {
    for (const table of consentTables) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(Number(rows[0]?.count), `${table} should show rows`).toBeGreaterThan(0);
    }
  });

  it('CN-02 cross-tenant reads come back empty in both directions', async () => {
    const fromNorthwind = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      `SELECT count(*)::text AS count FROM consent.consent_event WHERE tenant_id = 'riverbend-synthetic'`,
    );
    expect(fromNorthwind.rows[0]?.count).toBe('0');
    const fromRiverbend = await boundQuery<{ count: string }>(
      'riverbend-synthetic',
      `SELECT count(*)::text AS count FROM consent.consent_state WHERE person_ref = 'np-sam-porter'`,
    );
    expect(fromRiverbend.rows[0]?.count).toBe('0');
  });

  it('CN-03 a Northwind-bound INSERT carrying the Riverbend tenant is rejected by policy', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('cdbf-0001', { tenant_id: `'riverbend-synthetic'` }),
      ),
    ).toBe('42501');
  });

  it('CN-04 the event log is append-only; the projection folds forward and never deletes', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE consent.consent_event SET resulting_state = 'opted_out' WHERE consent_event_id = 'nce-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM consent.consent_event WHERE consent_event_id = 'nce-0001'`,
      ),
    ).toBe('42501');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `DELETE FROM consent.consent_state WHERE person_ref = 'np-sam-porter'`,
      ),
    ).toBe('42501');
  });

  it('CN-05 the structural scope/action/consent CHECKs are enforced', async () => {
    // Communication scope carrying a recipient (cross-axis) is unrepresentable.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('cdbf-0002', { recipient_ref: `'synthetic-recipient:x'` }),
      ),
    ).toBe('23514');
    // Action paired to the wrong resulting state.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('cdbf-0003', { resulting_state: `'opted_out'` }),
      ),
    ).toBe('23514');
    // Marketing grant without an affirmative evidenced source (R6-SR-020).
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('cdbf-0004', {
          scope_key: `'communication|channel=sms|purpose=marketing'`,
          purpose: `'marketing'`,
          source: `'api_import'`,
        }),
      ),
    ).toBe('23514');
    // Genetic grant without written authorization (R6-SR-031).
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('cdbf-0005', {
          scope_type: `'disclosure'`,
          scope_key: `'disclosure|purpose=treatment|recipient=synthetic-recipient:lab|record=genetic'`,
          channel: 'NULL',
          recipient_ref: `'synthetic-recipient:lab'`,
          record_type: `'genetic'`,
        }),
      ),
    ).toBe('23514');
    // Disclosure grant without written consent (R6-SR-040).
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('cdbf-0006', {
          scope_type: `'disclosure'`,
          scope_key: `'disclosure|purpose=treatment|recipient=synthetic-recipient:r|record=general'`,
          channel: 'NULL',
          recipient_ref: `'synthetic-recipient:r'`,
          record_type: `'general'`,
        }),
      ),
    ).toBe('23514');
    // Bad enum values and an expiry before the effective date.
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('cdbf-0007', { channel: `'pager'` }),
      ),
    ).toBe('23514');
    expect(
      await boundQueryError(
        'northwind-synthetic',
        forgedEvent('cdbf-0008', {
          effective_at: `'2026-03-17T00:00:00Z'`,
          expires_at: `'2025-01-01T00:00:00Z'`,
        }),
      ),
    ).toBe('23514');
  });

  it('CN-06 the projection FK requires an existing same-tenant event', async () => {
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `INSERT INTO consent.consent_state
           (tenant_id, person_ref, scope_key, scope_type, channel, purpose,
            current_state, effective_at, last_event_id, quiet_hours_tz, jurisdiction, synthetic)
         VALUES ('northwind-synthetic', 'np-db-forge', 'communication|channel=sms|purpose=treatment',
                 'communication', 'sms', 'treatment', 'opted_in', '2026-03-17T00:00:00Z',
                 'nce-missing', 'UTC', 'NV', true)`,
      ),
    ).toBe('23503');
  });

  it('CN-07 every seeded consent row carries the synthetic watermark', async () => {
    for (const table of consentTables) {
      const result = await owner.query(
        `SELECT count(*)::text AS count FROM ${table} WHERE synthetic IS DISTINCT FROM true`,
      );
      expect(result.rows[0]?.count, `${table} must be fully watermarked`).toBe('0');
    }
  });

  it('CN-08 idempotency across modules: 0009 re-applies, 0001 re-applies after it, postures hold', async () => {
    await owner.query(
      readFileSync(`${repoRoot}modules/consent/migrations/0009-consent.sql`, 'utf8'),
    );
    await owner.query(
      readFileSync(`${repoRoot}modules/platform-core/migrations/0001-tenancy.sql`, 'utf8'),
    );
    expect(
      await boundQueryError(
        'northwind-synthetic',
        `UPDATE consent.consent_event SET resulting_state = 'blocked' WHERE consent_event_id = 'nce-0001'`,
      ),
    ).toBe('42501');
  });

  it('CN-09 forced RLS is live; an unbound session reads zero rows and cannot write', async () => {
    const unprotected = await owner.query(
      `SELECT count(*)::text AS count FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'consent' AND c.relkind = 'r'
         AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`,
    );
    expect(unprotected.rows[0]?.count).toBe('0');
    for (const table of consentTables) {
      const result = await app.query(`SELECT count(*)::text AS count FROM ${table}`);
      expect(result.rows[0]?.count, `${table} must be empty without a binding`).toBe('0');
    }
    await expect(app.query(forgedEvent('cdbf-unbound'))).rejects.toMatchObject({ code: '42501' });
  });

  it('CN-10 the STOP standing proof holds at rest: sms/marketing opted_out, sms/treatment opted_in', async () => {
    const { rows } = await boundQuery<{ purpose: string; current_state: string }>(
      'northwind-synthetic',
      `SELECT purpose, current_state FROM consent.consent_state
        WHERE person_ref = 'np-sam-porter' AND channel = 'sms' ORDER BY purpose`,
    );
    expect(rows).toEqual([
      { purpose: 'marketing', current_state: 'opted_out' },
      { purpose: 'treatment', current_state: 'opted_in' },
    ]);
  });
});
