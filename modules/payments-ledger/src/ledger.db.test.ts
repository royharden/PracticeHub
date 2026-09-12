import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  await owner.query(readFileSync(`${root}infra/postgres/init/001-bootstrap.sql`, 'utf8'));
  await owner.query(
    readFileSync(`${root}modules/platform-core/migrations/0001-tenancy.sql`, 'utf8'),
  );
  await owner.query(
    readFileSync(`${root}modules/payments-ledger/migrations/0019-cash-ledger.sql`, 'utf8'),
  );
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

async function commitBound(tenantId: string, sql: string): Promise<void> {
  await app.query('BEGIN');
  try {
    await app.query(tenantBindingSql(tenantId));
    await app.query(sql);
    await app.query('COMMIT');
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

describe('payments-ledger DB invariants', () => {
  it('rejects an unbalanced forged journal when deferred constraints are forced', async () => {
    await expect(
      bound(
        'northwind-synthetic',
        `INSERT INTO payments_ledger.journal
      (tenant_id,journal_id,correlation_id,idempotency_key,canonical_payload_hash,occurred_at,synthetic)
      VALUES ('northwind-synthetic','j-db-1','c-db-1','k-db-1','${'a'.repeat(64)}',now(),true);
      INSERT INTO payments_ledger.journal_line
      (tenant_id,journal_id,line_no,account_ref,side,amount_minor,currency,source_ref,synthetic)
      VALUES ('northwind-synthetic','j-db-1',1,'cash','debit',100,'USD','effect-1',true),
             ('northwind-synthetic','j-db-1',2,'liability','credit',99,'USD','effect-1',true);
      SET CONSTRAINTS ALL IMMEDIATE`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      bound(
        'northwind-synthetic',
        `INSERT INTO payments_ledger.journal_line
      (tenant_id,journal_id,line_no,account_ref,side,amount_minor,currency,source_ref,synthetic)
      VALUES ('northwind-synthetic','missing-journal',1,'cash','debit',1,'USD','s1',true)`,
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects a balanced aggregate that exceeds the exact-integer ceiling', async () => {
    await expect(
      bound(
        'northwind-synthetic',
        `INSERT INTO payments_ledger.journal
      (tenant_id,journal_id,correlation_id,idempotency_key,canonical_payload_hash,occurred_at,synthetic)
      VALUES ('northwind-synthetic','j-db-overflow','c-db-o','k-db-o','${'b'.repeat(64)}',now(),true);
      INSERT INTO payments_ledger.journal_line
      (tenant_id,journal_id,line_no,account_ref,side,amount_minor,currency,source_ref,synthetic)
      VALUES ('northwind-synthetic','j-db-overflow',1,'cash-a','debit',9007199254740991,'USD','effect-o',true),
             ('northwind-synthetic','j-db-overflow',2,'cash-b','debit',1,'USD','effect-o',true),
             ('northwind-synthetic','j-db-overflow',3,'liability-a','credit',9007199254740991,'USD','effect-o',true),
             ('northwind-synthetic','j-db-overflow',4,'liability-b','credit',1,'USD','effect-o',true);
      SET CONSTRAINTS ALL IMMEDIATE`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('accepts one exact reversal, rejects a second/reversal-of-reversal, and freezes posted lines', async () => {
    const suffix = randomUUID();
    const originalId = `j-db-valid-${suffix}`;
    const reversalId = `j-db-reverse-${suffix}`;
    await commitBound(
      'northwind-synthetic',
      `INSERT INTO payments_ledger.journal
      (tenant_id,journal_id,correlation_id,idempotency_key,canonical_payload_hash,occurred_at,synthetic)
      VALUES ('northwind-synthetic','${originalId}','c-db-v','k-db-v-${suffix}','${'c'.repeat(64)}',now(),true);
      INSERT INTO payments_ledger.journal
      (tenant_id,journal_id,correlation_id,idempotency_key,canonical_payload_hash,reversal_of_journal_id,occurred_at,synthetic)
      VALUES ('northwind-synthetic','${reversalId}','c-db-r','k-db-r-${suffix}','${'d'.repeat(64)}','${originalId}',now(),true);
      INSERT INTO payments_ledger.journal_line
      (tenant_id,journal_id,line_no,account_ref,side,amount_minor,currency,source_ref,synthetic)
      VALUES ('northwind-synthetic','${originalId}',1,'cash','debit',100,'USD','effect-v',true),
             ('northwind-synthetic','${originalId}',2,'liability','credit',100,'USD','effect-v',true),
             ('northwind-synthetic','${reversalId}',1,'cash','credit',100,'USD','effect-v',true),
             ('northwind-synthetic','${reversalId}',2,'liability','debit',100,'USD','effect-v',true);
      SET CONSTRAINTS ALL IMMEDIATE`,
    );
    await expect(
      bound(
        'northwind-synthetic',
        `INSERT INTO payments_ledger.journal_line
      (tenant_id,journal_id,line_no,account_ref,side,amount_minor,currency,source_ref,synthetic)
      VALUES ('northwind-synthetic','${originalId}',3,'cash','debit',1,'USD','late',true)`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      bound(
        'northwind-synthetic',
        `INSERT INTO payments_ledger.journal
      (tenant_id,journal_id,correlation_id,idempotency_key,canonical_payload_hash,reversal_of_journal_id,occurred_at,synthetic)
      VALUES ('northwind-synthetic','j-db-reverse-2-${suffix}','c','k-db-r2-${suffix}','${'e'.repeat(64)}','${originalId}',now(),true)`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      bound(
        'northwind-synthetic',
        `INSERT INTO payments_ledger.journal
      (tenant_id,journal_id,correlation_id,idempotency_key,canonical_payload_hash,reversal_of_journal_id,occurred_at,synthetic)
      VALUES ('northwind-synthetic','j-db-reverse-chain-${suffix}','c','k-db-rc-${suffix}','${'f'.repeat(64)}','${reversalId}',now(),true);
      INSERT INTO payments_ledger.journal_line
      (tenant_id,journal_id,line_no,account_ref,side,amount_minor,currency,source_ref,synthetic)
      VALUES ('northwind-synthetic','j-db-reverse-chain-${suffix}',1,'cash','debit',100,'USD','effect-v',true),
             ('northwind-synthetic','j-db-reverse-chain-${suffix}',2,'liability','credit',100,'USD','effect-v',true);
      SET CONSTRAINTS ALL IMMEDIATE`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('forces tenant RLS and append-only posture', async () => {
    expect(
      await bound(
        'riverbend-synthetic',
        `SELECT * FROM payments_ledger.journal WHERE tenant_id='northwind-synthetic'`,
      ),
    ).toHaveLength(0);
    await expect(
      bound(
        'northwind-synthetic',
        `DELETE FROM payments_ledger.journal WHERE tenant_id='northwind-synthetic'`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
