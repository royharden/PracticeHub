/**
 * DB-level authn suite (WP-014 verification gate surface). Cross-tenant
 * negatives on the five authn tables, the structural staff-MFA CHECK, the
 * expiring/attempt-bounded challenge constraints, the release-carries-evidence
 * and forensic-signals lockdown constraints, watermark, and the
 * cross-migration idempotency proof (0005 then 0004 re-applied with the
 * schema-wide coverage guard). Requires the app-postgres from compose.yaml
 * (or the CI service container) on 127.0.0.1:55432.
 *
 * The suite provisions its own schema state as the database owner —
 * idempotent by construction, so re-running against the live local stack is
 * itself the migration idempotency proof.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { authnRlsSpecs } from './rls-specs.js';

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
  'modules/identity/migrations/0004-identity.sql',
  'modules/identity/migrations/0005-authn.sql',
  'infra/postgres/init/002-seed.sql',
  'infra/postgres/seed/003-tenancy-seed.sql',
  'infra/postgres/seed/006-identity-seed.sql',
  'infra/postgres/seed/007-authn-seed.sql',
];

const authnTables = authnRlsSpecs.map((spec) => `${spec.schema}.${spec.table}`);

let owner: Client;
let app: Client;

async function boundQuery<T extends Record<string, unknown>>(
  tenantId: string,
  sql: string,
): Promise<{ rows: T[]; rowCount: number }> {
  await app.query('BEGIN');
  try {
    await app.query(tenantBindingSql(tenantId));
    const result = await app.query(sql);
    await app.query('COMMIT');
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

async function ownerQueryError(sql: string): Promise<string> {
  try {
    await owner.query(sql);
  } catch (error) {
    await owner.query('ROLLBACK').catch(() => undefined);
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

describe('authn schema DB suite (WP-014)', () => {
  it('A-01 positive control: a Northwind-bound session reads Northwind rows in every authn table', async () => {
    for (const table of authnTables) {
      const { rows } = await boundQuery<{ count: string }>(
        'northwind-synthetic',
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(Number(rows[0]?.count), `${table} should show Northwind rows`).toBeGreaterThan(0);
    }
  });

  it('A-02 cross-tenant negative: a Northwind-bound session reads zero Riverbend lockdowns', async () => {
    const { rows } = await boundQuery<{ count: string }>(
      'northwind-synthetic',
      "SELECT count(*)::text AS count FROM identity.account_lockdown WHERE tenant_id = 'riverbend-synthetic'",
    );
    expect(rows[0]?.count).toBe('0');
    const riverbendView = await boundQuery<{ count: string }>(
      'riverbend-synthetic',
      'SELECT count(*)::text AS count FROM identity.auth_session',
    );
    expect(riverbendView.rows[0]?.count, 'Riverbend sees none of Northwind sessions').toBe('0');
  });

  it('A-03 unbound session: zero rows in every authn table (fail-closed binding)', async () => {
    for (const table of authnTables) {
      await app.query('BEGIN');
      const result = await app.query(`SELECT count(*)::text AS count FROM ${table}`);
      await app.query('COMMIT');
      expect((result.rows[0] as { count: string }).count, `${table} unbound`).toBe('0');
    }
  });

  it('A-04 staff MFA is structural: a staff session below aal2 is refused (23514)', async () => {
    expect(
      await ownerQueryError(
        'INSERT INTO identity.auth_session (tenant_id, session_id, person_id, principal, staff_account_id, device_id, assurance, status, created_at, last_activity_at, synthetic) ' +
          "VALUES ('northwind-synthetic', 'nsn-probe-aal1', 'np-morgan-lee', 'staff', 'nsa-morgan-lee', 'nde-morgan-workstation', 'aal1', 'active', now(), now(), true)",
      ),
    ).toBe('23514');
  });

  it('A-05 a staff session must name its staff account (23514)', async () => {
    expect(
      await ownerQueryError(
        'INSERT INTO identity.auth_session (tenant_id, session_id, person_id, principal, device_id, assurance, status, created_at, last_activity_at, synthetic) ' +
          "VALUES ('northwind-synthetic', 'nsn-probe-noacct', 'np-morgan-lee', 'staff', 'nde-morgan-workstation', 'aal2', 'active', now(), now(), true)",
      ),
    ).toBe('23514');
  });

  it('A-06 a non-expiring challenge is unrepresentable (23514)', async () => {
    expect(
      await ownerQueryError(
        'INSERT INTO identity.auth_challenge (tenant_id, challenge_id, person_id, endpoint_id, purpose, method, issued_at, expires_at, attempt_count, max_attempts, synthetic) ' +
          "VALUES ('northwind-synthetic', 'nch-probe-noexp', 'np-alex-rivera', 'nce-alex-portal-email', 'portal-login', 'otp', now(), now(), 0, 3, true)",
      ),
    ).toBe('23514');
  });

  it('A-07 challenge attempts are bounded (23514)', async () => {
    expect(
      await ownerQueryError(
        'INSERT INTO identity.auth_challenge (tenant_id, challenge_id, person_id, endpoint_id, purpose, method, issued_at, expires_at, attempt_count, max_attempts, synthetic) ' +
          "VALUES ('northwind-synthetic', 'nch-probe-over', 'np-alex-rivera', 'nce-alex-portal-email', 'portal-login', 'otp', now(), now() + interval '10 minutes', 4, 3, true)",
      ),
    ).toBe('23514');
  });

  it('A-08 a released lockdown must carry evidence and attribution (23514)', async () => {
    expect(
      await ownerQueryError(
        'INSERT INTO identity.account_lockdown (tenant_id, lockdown_id, person_id, trigger_kind, signals, high_risk_frozen, status, release_requirement, synthetic) ' +
          "VALUES ('northwind-synthetic', 'nld-probe-noev', 'np-alex-rivera', 'ato-suspicion', '[{\"kind\": \"credential-stuffing\"}]'::jsonb, true, 'released', 'step-up', true)",
      ),
    ).toBe('23514');
  });

  it('A-09 a lockdown without its forensic signals is unrepresentable (23514)', async () => {
    expect(
      await ownerQueryError(
        'INSERT INTO identity.account_lockdown (tenant_id, lockdown_id, person_id, trigger_kind, signals, high_risk_frozen, status, release_requirement, synthetic) ' +
          "VALUES ('northwind-synthetic', 'nld-probe-nosig', 'np-alex-rivera', 'ato-suspicion', '[]'::jsonb, true, 'active', 'step-up', true)",
      ),
    ).toBe('23514');
  });

  it('A-10 revocations carry reasons: device and session (23514)', async () => {
    expect(
      await ownerQueryError(
        'INSERT INTO identity.auth_device (tenant_id, device_id, person_id, label, status, first_seen_at, synthetic) ' +
          "VALUES ('northwind-synthetic', 'nde-probe-norsn', 'np-morgan-lee', 'probe', 'revoked', now(), true)",
      ),
    ).toBe('23514');
    expect(
      await ownerQueryError(
        'INSERT INTO identity.auth_session (tenant_id, session_id, person_id, principal, device_id, assurance, status, created_at, last_activity_at, synthetic) ' +
          "VALUES ('northwind-synthetic', 'nsn-probe-norsn', 'np-alex-rivera', 'portal', 'nde-alex-phone', 'aal1', 'revoked', now(), now(), true)",
      ),
    ).toBe('23514');
  });

  it('A-11 composite same-tenant FKs: a cross-tenant person reference is refused (23503)', async () => {
    expect(
      await ownerQueryError(
        'INSERT INTO identity.auth_device (tenant_id, device_id, person_id, label, status, first_seen_at, synthetic) ' +
          "VALUES ('riverbend-synthetic', 'rde-probe-xt', 'np-alex-rivera', 'probe', 'active', now(), true)",
      ),
    ).toBe('23503');
  });

  it('A-12 credential secret references stay opaque (23514)', async () => {
    expect(
      await ownerQueryError(
        'INSERT INTO identity.auth_credential (tenant_id, credential_id, person_id, audience, kind, status, secret_ref, enrolled_by, evidence_ref, synthetic) ' +
          "VALUES ('northwind-synthetic', 'ncr-probe-email', 'np-morgan-lee', 'staff', 'password', 'active', 'someone@somewhere.invalid', 'synthetic-it-admin-001', 'synthetic-evidence', true)",
      ),
    ).toBe('23514');
  });

  it('A-13 watermark: every authn row is synthetic', async () => {
    for (const table of authnTables) {
      const result = await owner.query(
        `SELECT count(*)::text AS count FROM ${table} WHERE synthetic IS DISTINCT FROM true`,
      );
      expect((result.rows[0] as { count: string }).count, table).toBe('0');
    }
  });

  it('A-14 cross-migration idempotency: 0005 re-applies, then 0004 re-applies after it (schema-wide guard)', async () => {
    await owner.query(
      readFileSync(`${repoRoot}modules/identity/migrations/0005-authn.sql`, 'utf8'),
    );
    await owner.query(
      readFileSync(`${repoRoot}modules/identity/migrations/0004-identity.sql`, 'utf8'),
    );
    const result = await owner.query(
      'SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
        "WHERE n.nspname = 'identity' AND c.relkind = 'r' AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)",
    );
    expect((result.rows[0] as { count: string }).count).toBe('0');
  });
});
