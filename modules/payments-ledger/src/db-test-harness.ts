import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';

const root = fileURLToPath(new URL('../../..', import.meta.url));
export const historicalMigrations = [
  '0019-cash-ledger.sql',
  '0021-ledger-v2.sql',
  '0022-statements.sql',
] as const;
export const suffixMigrations = [
  '0068-ledger-v2-governance.sql',
  '0069-dunning-deceased-stop.sql',
  '0070-oig-exception-report.sql',
  '0071-write-off-open-receivable.sql',
  '0072-ledger-rls-coverage.sql',
] as const;
export const finalMigrations = [...historicalMigrations, ...suffixMigrations];
export const readMigration = (name: string): string =>
  readFileSync(`${root}modules/payments-ledger/migrations/${name}`, 'utf8');

/** Per-file atomicity for this isolated proof fixture; the production journal is a separate gate. */
export async function atomicSql(client: Client, sql: string): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function tenantSql(
  client: Client,
  tenant: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<readonly Record<string, unknown>[]> {
  await client.query('BEGIN');
  try {
    await client.query(tenantBindingSql(tenant));
    const result = await client.query(sql, [...params]);
    await client.query('COMMIT');
    return result.rows as readonly Record<string, unknown>[];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/**
 * Explicit synthetic-only loopback grant, unique deterministic run/suite DB name.
 * CREATE DATABASE fails on collision: never adopt, reset or drop a pre-existing DB.
 * Requires the local synthetic owner to CREATE DATABASE and execute the canonical
 * tenancy/module role migrations (including ALTER ROLE practicehub_app password).
 * Those roles are cluster-wide; the operator must grant that effect separately.
 * All schema/data changes and rollback drills are confined to our newly created DB.
 */
export async function createLedgerDb(suite: string, migrations: readonly string[]) {
  const host = process.env['PRACTICEHUB_DB_HOST'];
  const port = Number(process.env['PRACTICEHUB_DB_PORT']);
  const run = process.env['PRACTICEHUB_LEDGER_DB_RUN'];
  if (
    process.env['PRACTICEHUB_LEDGER_DB_PROOF'] !== 'synthetic-isolated' ||
    !host ||
    !['127.0.0.1', '::1'].includes(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !run ||
    !/^[a-z0-9]{1,16}$/.test(run) ||
    !/^[a-z0-9_]{1,20}$/.test(suite)
  ) {
    throw new Error(
      'Ledger DB proof requires explicit synthetic-isolated grant, loopback host, port and alphanumeric run ID',
    );
  }
  const database = `ph_ledger_proof_${run}_${suite}`;
  const connection = { host, port, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 };
  const ownerLogin = { user: 'practicehub', password: 'practicehub_synthetic_local' };
  const admin = new Client({ ...connection, ...ownerLogin, database: 'postgres' });
  const owner = new Client({ ...connection, ...ownerLogin, database });
  const apps: Client[] = [];
  let created = false;
  let disposed = false;
  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    const closes = await Promise.allSettled([...apps.map((client) => client.end()), owner.end()]);
    for (const close of closes) if (close.status === 'rejected') errors.push(close.reason);
    try {
      // No IF EXISTS / FORCE: only our successful CREATE authorizes this exact DROP.
      if (created) await admin.query(`DROP DATABASE "${database}"`);
    } catch (error) {
      errors.push(
        new Error(`Owned synthetic database ${database} may remain; DROP failed`, { cause: error }),
      );
    }
    try {
      await admin.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0)
      throw new AggregateError(errors, `Ledger proof cleanup failed for ${database}`);
  }

  async function newApp(): Promise<Client> {
    const client = new Client({
      ...connection,
      database,
      user: 'practicehub_app',
      password: 'practicehub_app_synthetic_local',
    });
    apps.push(client);
    await client.connect();
    return client;
  }
  async function migrate(names: readonly string[]): Promise<void> {
    for (const name of names) await atomicSql(owner, readMigration(name));
  }
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    created = true;
    await owner.connect();
    for (const path of [
      'infra/postgres/init/001-bootstrap.sql',
      'modules/platform-core/migrations/0001-tenancy.sql',
    ]) {
      await atomicSql(owner, readFileSync(`${root}${path}`, 'utf8'));
    }
    for (const tenant of ['northwind-synthetic', 'riverbend-synthetic']) {
      await tenantSql(
        owner,
        tenant,
        `INSERT INTO platform_core.tenant (tenant_id,display_name,synthetic) VALUES ($1,$1,true)`,
        [tenant],
      );
    }
    await migrate(migrations);
    const roles = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname='practicehub_app'",
    );
    if (roles.rows.length !== 1 || roles.rows[0]?.rolsuper || roles.rows[0]?.rolbypassrls) {
      throw new Error('Synthetic app role must exist and enforce RLS');
    }
    const app = await newApp();
    return { database, owner, app, newApp, migrate, dispose };
  } catch (error) {
    try {
      await dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Ledger proof setup and cleanup failed for ${database}`,
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

export type LedgerDb = Awaited<ReturnType<typeof createLedgerDb>>;
