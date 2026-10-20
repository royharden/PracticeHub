import { randomUUID } from 'node:crypto';

import { tenantBindingSql } from '@practicehub/platform-core';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLedgerDb, finalMigrations, type LedgerDb } from './db-test-harness.js';

const tenant = 'northwind-synthetic';
let db: LedgerDb | undefined;
let owner: Client;
let app: Client;

beforeAll(async () => {
  db = await createLedgerDb('final_dunning', finalMigrations);
  owner = db.owner;
  app = db.app;
  await db.migrate(['0069-dunning-deceased-stop.sql']);
});
afterAll(async () => {
  await db?.dispose();
});

async function asApp(tenantId: string, sql: string, params: readonly unknown[] = []) {
  await app.query('BEGIN');
  try {
    await app.query(tenantBindingSql(tenantId));
    const result = await app.query(sql, [...params]);
    await app.query('COMMIT');
    return result.rows as readonly Record<string, unknown>[];
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

describe('0069 deceased stop on an existing dunning account', () => {
  it('stops an active account in one call and refuses every later notice', async () => {
    const account = `acct-${randomUUID()}`;
    await asApp(
      tenant,
      `INSERT INTO payments_ledger.dunning_account
         (tenant_id,account_ref,deceased,dunning,synthetic)
       VALUES ($1,$2,false,'active',true)`,
      [tenant, account],
    );
    await expect(
      asApp(tenant, 'SELECT payments_ledger.assert_dunning_allowed($1,$2)', [tenant, account]),
    ).resolves.toBeDefined();

    await expect(
      asApp(
        tenant,
        `UPDATE payments_ledger.dunning_account SET dunning='stopped'
          WHERE tenant_id=$1 AND account_ref=$2`,
        [tenant, account],
      ),
    ).rejects.toMatchObject({ code: '42501' });

    await asApp(tenant, 'SELECT payments_ledger.record_deceased_stop($1,$2)', [tenant, account]);
    const [row] = await asApp(
      tenant,
      `SELECT deceased, dunning, stopped_reason FROM payments_ledger.dunning_account
        WHERE tenant_id=$1 AND account_ref=$2`,
      [tenant, account],
    );
    expect(row).toEqual({ deceased: true, dunning: 'stopped', stopped_reason: 'deceased' });

    await expect(
      asApp(tenant, 'SELECT payments_ledger.assert_dunning_allowed($1,$2)', [tenant, account]),
    ).rejects.toMatchObject({ code: '23514' });

    // Even the table owner, bound to the tenant so forced RLS cannot hide the row, cannot reverse it.
    await owner.query('BEGIN');
    try {
      await owner.query(tenantBindingSql(tenant));
      await expect(
        owner.query(
          `UPDATE payments_ledger.dunning_account SET deceased=false, dunning='active', stopped_reason=NULL
            WHERE tenant_id=$1 AND account_ref=$2`,
          [tenant, account],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('refuses a stop for another tenant and for an unknown account', async () => {
    await expect(
      asApp(tenant, 'SELECT payments_ledger.record_deceased_stop($1,$2)', [
        'riverbend-synthetic',
        'acct-any',
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asApp(tenant, 'SELECT payments_ledger.record_deceased_stop($1,$2)', [
        tenant,
        `acct-missing-${randomUUID()}`,
      ]),
    ).rejects.toMatchObject({ code: 'P0002' });
  });
});
