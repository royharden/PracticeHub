import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const config = {
  host: process.env['PRACTICEHUB_DB_HOST'] ?? '127.0.0.1',
  port: Number(process.env['PRACTICEHUB_DB_PORT'] ?? '55432'),
  database: 'practicehub',
};
let owner: Client;
let app: Client;
beforeAll(async () => {
  owner = new Client({ ...config, user: 'practicehub', password: 'practicehub_synthetic_local' });
  app = new Client({
    ...config,
    user: 'practicehub_app',
    password: 'practicehub_app_synthetic_local',
  });
  await owner.connect();
  for (const file of [
    'infra/postgres/init/001-bootstrap.sql',
    'modules/platform-core/migrations/0001-tenancy.sql',
    'modules/payments-ledger/migrations/0019-cash-ledger.sql',
    'modules/membership-entitlements/migrations/0020-entitlement-ledger.sql',
  ]) {
    await owner.query(readFileSync(`${root}${file}`, 'utf8'));
  }
  await app.connect();
});
afterAll(async () => {
  await app?.end();
  await owner?.end();
});

async function bound(tenantId: string, sql: string): Promise<readonly Record<string, unknown>[]> {
  await app.query('BEGIN');
  try {
    await app.query(tenantBindingSql(tenantId));
    const result = await app.query(sql);
    await app.query('ROLLBACK');
    return result.rows;
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

describe('entitlement DB invariants', () => {
  it('requires reversal lineage and preserves append-only tenant isolation', async () => {
    await expect(
      bound(
        'northwind-synthetic',
        `INSERT INTO membership_entitlements.entitlement_event
      (tenant_id,entitlement_event_id,event_type,member_ref,component_ref,entitlement_kind,authority_journal_id,idempotency_key,occurred_at,synthetic)
      VALUES ('northwind-synthetic','bad-authority','granted','m1','c1','once','missing-journal','bad-authority-key',now(),true)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      bound(
        'northwind-synthetic',
        `INSERT INTO payments_ledger.journal
      (tenant_id,journal_id,correlation_id,idempotency_key,canonical_payload_hash,occurred_at,synthetic)
      VALUES ('northwind-synthetic','j1','c1','jk1','${'a'.repeat(64)}',now(),true);
      INSERT INTO payments_ledger.journal_line
      (tenant_id,journal_id,line_no,account_ref,side,amount_minor,currency,source_ref,synthetic)
      VALUES ('northwind-synthetic','j1',1,'cash','debit',1,'USD','e1',true),
             ('northwind-synthetic','j1',2,'liability','credit',1,'USD','e1',true);
      SET CONSTRAINTS ALL IMMEDIATE;
      INSERT INTO membership_entitlements.entitlement_event
      (tenant_id,entitlement_event_id,event_type,member_ref,component_ref,entitlement_kind,authority_journal_id,idempotency_key,occurred_at,synthetic)
      VALUES ('northwind-synthetic','bad-r','reversed','m1','c1','once','j1','k1',now(),true)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      await bound(
        'riverbend-synthetic',
        `SELECT * FROM membership_entitlements.entitlement_event WHERE tenant_id='northwind-synthetic'`,
      ),
    ).toHaveLength(0);
    await expect(
      bound(
        'northwind-synthetic',
        `UPDATE membership_entitlements.entitlement_event SET entitlement_kind='x'`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects a reversal whose member/component authority tuple differs from its grant', async () => {
    await expect(
      bound(
        'northwind-synthetic',
        `INSERT INTO payments_ledger.journal
      (tenant_id,journal_id,correlation_id,idempotency_key,canonical_payload_hash,occurred_at,synthetic)
      VALUES ('northwind-synthetic','j-exact','c-exact','jk-exact','${'b'.repeat(64)}',now(),true);
      INSERT INTO payments_ledger.journal_line
      (tenant_id,journal_id,line_no,account_ref,side,amount_minor,currency,source_ref,synthetic)
      VALUES ('northwind-synthetic','j-exact',1,'cash','debit',1,'USD','e-exact',true),
             ('northwind-synthetic','j-exact',2,'liability','credit',1,'USD','e-exact',true);
      SET CONSTRAINTS ALL IMMEDIATE;
      INSERT INTO membership_entitlements.entitlement_event
      (tenant_id,entitlement_event_id,event_type,member_ref,component_ref,entitlement_kind,authority_journal_id,idempotency_key,occurred_at,synthetic)
      VALUES ('northwind-synthetic','grant-exact','granted','m1','c1','once','j-exact','grant-exact-key',now(),true);
      INSERT INTO membership_entitlements.entitlement_event
      (tenant_id,entitlement_event_id,event_type,member_ref,component_ref,entitlement_kind,authority_journal_id,idempotency_key,reversal_of_event_id,occurred_at,synthetic)
      VALUES ('northwind-synthetic','reverse-bad','reversed','other','c1','once','jr1','reverse-bad-key','grant-exact',now(),true)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts exact ledger-backed lineage then rejects a second entitlement reversal', async () => {
    await expect(
      bound(
        'northwind-synthetic',
        `INSERT INTO payments_ledger.journal
      (tenant_id,journal_id,correlation_id,idempotency_key,canonical_payload_hash,reversal_of_journal_id,occurred_at,synthetic)
      VALUES ('northwind-synthetic','j-auth','c-auth','jk-auth','${'c'.repeat(64)}',NULL,now(),true),
             ('northwind-synthetic','jr-auth','c-auth','jkr-auth','${'d'.repeat(64)}','j-auth',now(),true);
      INSERT INTO payments_ledger.journal_line
      (tenant_id,journal_id,line_no,account_ref,side,amount_minor,currency,source_ref,synthetic)
      VALUES ('northwind-synthetic','j-auth',1,'cash','debit',1,'USD','e-auth',true),
             ('northwind-synthetic','j-auth',2,'liability','credit',1,'USD','e-auth',true),
             ('northwind-synthetic','jr-auth',1,'cash','credit',1,'USD','e-auth',true),
             ('northwind-synthetic','jr-auth',2,'liability','debit',1,'USD','e-auth',true);
      SET CONSTRAINTS ALL IMMEDIATE;
      INSERT INTO membership_entitlements.entitlement_event
      (tenant_id,entitlement_event_id,event_type,member_ref,component_ref,entitlement_kind,authority_journal_id,idempotency_key,occurred_at,synthetic)
      VALUES ('northwind-synthetic','g-auth','granted','m1','c1','once','j-auth','gk-auth',now(),true);
      INSERT INTO membership_entitlements.entitlement_event
      (tenant_id,entitlement_event_id,event_type,member_ref,component_ref,entitlement_kind,authority_journal_id,idempotency_key,reversal_of_event_id,occurred_at,synthetic)
      VALUES ('northwind-synthetic','r-auth','reversed','m1','c1','once','jr-auth','rk-auth','g-auth',now(),true);
      INSERT INTO membership_entitlements.entitlement_event
      (tenant_id,entitlement_event_id,event_type,member_ref,component_ref,entitlement_kind,authority_journal_id,idempotency_key,reversal_of_event_id,occurred_at,synthetic)
      VALUES ('northwind-synthetic','r-auth-2','reversed','m1','c1','once','jr-auth','rk-auth-2','g-auth',now(),true)`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
