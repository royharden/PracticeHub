import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { APP_ROLE_WRITE_PATH } from './app-role-write-path.js';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const config = {
  host: process.env['PRACTICEHUB_DB_HOST'] ?? '127.0.0.1',
  port: Number(process.env['PRACTICEHUB_DB_PORT'] ?? '55432'),
  database: 'practicehub',
};
const ownerConfig = {
  ...config,
  user: 'practicehub',
  password: 'practicehub_synthetic_local',
};
const appConfig = {
  ...config,
  user: 'practicehub_app',
  password: 'practicehub_app_synthetic_local',
};

let owner: Client;
let app: Client;

async function migrate(): Promise<void> {
  await owner.query(readFileSync(`${repoRoot}infra/postgres/init/001-bootstrap.sql`, 'utf8'));
  await owner.query(
    readFileSync(`${repoRoot}modules/platform-core/migrations/0001-tenancy.sql`, 'utf8'),
  );
  await owner.query(
    readFileSync(`${repoRoot}infra/postgres/migrations/0032-scheduling.sql`, 'utf8'),
  );
  await owner.query(readFileSync(`${repoRoot}infra/postgres/seed/003-tenancy-seed.sql`, 'utf8'));
  await owner.query(readFileSync(`${repoRoot}infra/postgres/seed/031-scheduling-seed.sql`, 'utf8'));
  const inc2 = readFileSync(
    `${repoRoot}infra/postgres/migrations/0034-scheduling-inc2.sql`,
    'utf8',
  );
  await owner.query(inc2);
  await owner.query(inc2);
}

describe('WP-040 increment 2 app-role write path', () => {
  beforeAll(async () => {
    owner = new Client(ownerConfig);
    await owner.connect();
    await migrate();
    app = new Client(appConfig);
    await app.connect();
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    await owner?.end();
  });

  it('lets module_scheduling lock reservation subjects after the 0034 UPDATE grant', async () => {
    expect(APP_ROLE_WRITE_PATH.role).toBe('module_scheduling');
    await app.query('BEGIN');
    try {
      await app.query(tenantBindingSql('northwind-synthetic'));
      await app.query(`SET LOCAL ROLE ${APP_ROLE_WRITE_PATH.role}`);
      const result = await app.query('SELECT sched.lock_reservation_subjects($1, $2::jsonb)', [
        'northwind-synthetic',
        JSON.stringify([{ kind: 'provider', id: 'provider-synthetic-1' }]),
      ]);
      expect(result.rowCount).toBe(1);
    } finally {
      await app.query('ROLLBACK');
    }
  });
});
