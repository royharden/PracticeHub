import { createHash } from 'node:crypto';

import { tenantBindingSql } from '@practicehub/platform-core';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  atomicSql,
  createLedgerDb,
  finalMigrations,
  historicalMigrations,
  readMigration,
  suffixMigrations,
  tenantSql,
  type LedgerDb,
} from './db-test-harness.js';
import { paymentsLedgerSchemaRlsSpecs } from './rls-specs.js';

// Immutable pre-NR184 failure control, embedded to avoid private bundle dependencies.
const original0071 =
  "-- 0071: WP-057 hardening H-21 (review D46-WP-056-a2-review-2, note on write-off.ts:336).\n-- UNAPPLIED. Apply after 0068 with the other payments-ledger migrations.\n--\n-- A governed write-off may not take its receivable below zero: for the write-off's\n-- (tenant_id, target_ref, currency), accounts-receivable debits minus credits in\n-- payments_ledger.journal_line must stay >= 0. Two approvals with different\n-- write_off_ids therefore cannot write off the same receivable twice.\n--\n-- The check is a DEFERRABLE INITIALLY DEFERRED constraint trigger, so it runs at\n-- commit, after the write-off journal's lines and the write_off row are both in\n-- place, whichever order the transaction inserts them in. It creates no table and\n-- touches no RLS section. Pre-0071 rows are not rechecked.\n--\n-- Nothing is issued-statement related here: payments_ledger.statement already has\n-- PRIMARY KEY (tenant_id, statement_id) (0022), which is the durable record NR-141\n-- needs; the TS registry mirrors it.\n\nCREATE OR REPLACE FUNCTION payments_ledger.assert_write_off_within_receivable()\nRETURNS trigger\nLANGUAGE plpgsql\nAS $$\nDECLARE\n  open_minor numeric;\nBEGIN\n  SELECT coalesce(sum(CASE WHEN side = 'debit' THEN amount_minor ELSE -amount_minor END), 0)\n    INTO open_minor\n    FROM payments_ledger.journal_line\n   WHERE tenant_id = NEW.tenant_id\n     AND account_ref = 'accounts-receivable'\n     AND source_ref = NEW.target_ref\n     AND currency = NEW.currency;\n  IF open_minor < 0 THEN\n    RAISE EXCEPTION 'write-off % takes receivable % below zero', NEW.write_off_id, NEW.target_ref\n      USING ERRCODE = '23514';\n  END IF;\n  RETURN NULL;\nEND\n$$;\n\nDROP TRIGGER IF EXISTS write_off_within_receivable ON payments_ledger.write_off;\nCREATE CONSTRAINT TRIGGER write_off_within_receivable\n  AFTER INSERT ON payments_ledger.write_off\n  DEFERRABLE INITIALLY DEFERRED\n  FOR EACH ROW EXECUTE FUNCTION payments_ledger.assert_write_off_within_receivable();\n";
const original0071Sha256 = '40d2da075b086f5ef3aa588611bd2ca6690542488bd7d07b6f0d5061c9f3639b';

const tenant = 'northwind-synthetic';
const otherTenant = 'riverbend-synthetic';
const hash = (id: string): string => createHash('sha256').update(id).digest('hex');
let db: LedgerDb;
beforeAll(async () => {
  db = await createLedgerDb('migration', finalMigrations);
});
afterAll(async () => {
  await db?.dispose();
});

// Fixed synthetic inputs: every scenario has a distinct target/approval and no clock dependency.
function journal(
  id: string,
  target: string,
  amount: number,
  options: {
    tenant?: string;
    currency?: string;
    writeOff?: boolean;
  } = {},
): string {
  const t = options.tenant ?? tenant;
  const currency = options.currency ?? 'USD';
  const approval = options.writeOff ? `'${hash(id)}'` : 'NULL';
  return `INSERT INTO payments_ledger.journal
    (tenant_id,journal_id,correlation_id,idempotency_key,canonical_payload_hash,occurred_at,synthetic,write_off_approval_hash)
    VALUES ('${t}','${id}','${id}','${id}','${hash(id)}','2026-01-01T00:00:00Z',true,${approval});
    INSERT INTO payments_ledger.journal_line
    (tenant_id,journal_id,line_no,account_ref,side,amount_minor,currency,source_ref,synthetic) VALUES
    ('${t}','${id}',1,'${options.writeOff ? 'write-off-expense' : 'accounts-receivable'}','debit',${String(amount)},'${currency}','${target}',true),
    ('${t}','${id}',2,'${options.writeOff ? 'accounts-receivable' : 'revenue'}','credit',${String(amount)},'${currency}','${target}',true);`;
}
function writeOff(
  id: string,
  target: string,
  amount: number,
  options: {
    tenant?: string;
    currency?: string;
  } = {},
): string {
  const t = options.tenant ?? tenant;
  return (
    journal(id, target, amount, { ...options, writeOff: true }) +
    `INSERT INTO payments_ledger.write_off
     (tenant_id,write_off_id,journal_id,reason,role,amount_minor,currency,synthetic,target_ref,approval_hash,approver_actor_id,requester_actor_id)
     VALUES ('${t}','${id}','${id}','small-balance','billing-supervisor',${String(amount)},'${options.currency ?? 'USD'}',true,
     '${target}','${hash(id)}','synthetic-approver','synthetic-requester');`
  );
}
function report(
  id: string,
  options: {
    tenant?: string;
    kind?: string;
    charges?: string;
    rails?: string;
    synthetic?: boolean;
  } = {},
): string {
  return `INSERT INTO payments_ledger.oig_exception_report
    (tenant_id,report_id,finding_key,kind,patient_ref,service_ref,service_date,charge_ids,rails,generated_at,synthetic)
    VALUES ('${options.tenant ?? tenant}','${id}','finding','${options.kind ?? 'double-bill-cross-rail'}',
    'synthetic-patient','synthetic-service','2026-01-01',${options.charges ?? "ARRAY['charge-a','charge-b']"},
    ${options.rails ?? "ARRAY['cash','insurance']"},'2026-01-01T00:00:00Z',${String(options.synthetic ?? true)});`;
}
async function balance(client: Client, target: string): Promise<number> {
  const [row] = await tenantSql(
    client,
    tenant,
    `SELECT coalesce(sum(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END),0)::text AS amount
     FROM payments_ledger.journal_line WHERE account_ref='accounts-receivable' AND source_ref=$1 AND currency='USD'`,
    [target],
  );
  return Number(row?.['amount']);
}
async function tables(owner: Client) {
  return (
    await owner.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='payments_ledger' AND c.relkind='r' ORDER BY c.relname`)
  ).rows;
}
async function schemaFingerprint(owner: Client) {
  // Include business columns, constraints, triggers, function bodies, policies and app grants.
  const queries = [
    `SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns
      WHERE table_schema='payments_ledger' ORDER BY table_name,ordinal_position`,
    `SELECT c.relname, x.conname, x.convalidated, pg_get_constraintdef(x.oid) AS definition
      FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='payments_ledger' ORDER BY c.relname,x.conname`,
    `SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='payments_ledger' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
    `SELECT p.proname,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='payments_ledger' ORDER BY p.proname`,
    `SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='payments_ledger' ORDER BY tablename,policyname`,
    `SELECT table_name,grantee,privilege_type FROM information_schema.table_privileges WHERE table_schema='payments_ledger' ORDER BY table_name,grantee,privilege_type`,
    `SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='payments_ledger' ORDER BY tablename,indexname`,
  ];
  const result: unknown[] = [await tables(owner)];
  for (const sql of queries) result.push((await owner.query(sql)).rows);
  return result;
}
async function checkpointDefect(
  sql: string,
  message: RegExp,
  migration = '0072-ledger-rls-coverage.sql',
) {
  await db.owner.query('BEGIN');
  try {
    await db.owner.query(sql);
    await expect(db.owner.query(readMigration(migration))).rejects.toMatchObject({
      code: 'P0001',
      message,
    });
  } finally {
    await db.owner.query('ROLLBACK');
  }
}

/** Capture outcomes and economic state before any safety assertion, including on old SQL. */
async function concurrentWriteOffs(
  targetDb: LedgerDb,
  target: string,
  end: 'commit' | 'rollback' | 'failure' = 'commit',
) {
  await tenantSql(targetDb.app, tenant, journal(`fund-${target}`, target, 100));
  const a = await targetDb.newApp();
  const b = await targetDb.newApp();
  try {
    for (const [client, id] of [
      [a, `${target}-a`],
      [b, `${target}-b`],
    ] as const) {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      await client.query(tenantBindingSql(tenant));
      await client.query(writeOff(id, target, 70));
    }
    const aPid = (await a.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    const bPid = (await b.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    await a.query('SET CONSTRAINTS ALL IMMEDIATE');
    let settled = false;
    const check = b.query('SET CONSTRAINTS ALL IMMEDIATE').then(
      () => {
        settled = true;
        return { ok: true as const };
      },
      (error: unknown) => {
        settled = true;
        return { ok: false as const, error };
      },
    );
    let blockedOnA = false;
    const deadline = Date.now() + 5_000;
    while (!settled && !blockedOnA && Date.now() < deadline) {
      const rows = await targetDb.owner.query<{ blockers: number[] }>(
        'SELECT pg_blocking_pids($1) AS blockers',
        [bPid],
      );
      blockedOnA = rows.rows[0]?.blockers.includes(aPid ?? -1) ?? false;
    }
    if (!settled && !blockedOnA)
      throw new Error('No settled check or observed blocker; timeout is not safety evidence');
    if (end === 'failure') {
      await expect(a.query('SELECT 1/0')).rejects.toMatchObject({ code: '22012' });
    }
    await a.query(end === 'commit' ? 'COMMIT' : 'ROLLBACK');
    const committed = [end === 'commit'];
    const result = await check;
    let rejection: unknown;
    if (!result.ok) {
      rejection = result.error;
      await b.query('ROLLBACK');
      committed.push(false);
    } else {
      try {
        await b.query('COMMIT');
        committed.push(true);
      } catch (error) {
        rejection = error;
        await b.query('ROLLBACK');
        committed.push(false);
      }
    }
    const amount = await balance(targetDb.app, target);
    const committedIds = await tenantSql(
      targetDb.app,
      tenant,
      'SELECT write_off_id FROM payments_ledger.write_off WHERE target_ref=$1 ORDER BY write_off_id',
      [target],
    );
    // Error.message is non-enumerable: explicitly retain it in the JSON witness.
    const error = rejection as { code?: string; message?: string } | undefined;
    return {
      blockedOnA,
      committed,
      balance: amount,
      committedIds,
      rejection: error ? { code: error.code, message: error.message } : null,
    };
  } finally {
    await a.query('ROLLBACK');
    await b.query('ROLLBACK');
  }
}

describe('0070 OIG durable tenant and append-only report', () => {
  it('persists valid same/cross-rail reports and refuses duplicate finding identity', async () => {
    await tenantSql(db.app, tenant, report('cross'));
    await tenantSql(
      db.app,
      tenant,
      report('same', { kind: 'double-bill-same-rail', rails: "ARRAY['cash']" }),
    );
    expect(
      await tenantSql(
        db.app,
        tenant,
        "SELECT report_id FROM payments_ledger.oig_exception_report WHERE report_id IN ('cross','same') ORDER BY report_id",
      ),
    ).toEqual([{ report_id: 'cross' }, { report_id: 'same' }]);
    await expect(tenantSql(db.app, tenant, report('cross'))).rejects.toMatchObject({
      code: '23505',
    });
  });
  it.each([
    { kind: 'invalid' },
    { charges: "ARRAY['one']" },
    { rails: 'ARRAY[]::text[]' },
    { rails: "ARRAY['unknown','cash']" },
    { kind: 'double-bill-same-rail' },
    { rails: "ARRAY['cash']" },
    { synthetic: false },
  ])('rejects invalid report shape %j with a CHECK diagnostic', async (options) => {
    await expect(tenantSql(db.app, tenant, report('bad', options))).rejects.toMatchObject({
      code: '23514',
    });
  });
  it('hides populated foreign-tenant rows and refuses forged inserts and mutations', async () => {
    await tenantSql(db.app, tenant, report('tenant-probe'));
    expect(
      await tenantSql(
        db.app,
        tenant,
        "SELECT report_id FROM payments_ledger.oig_exception_report WHERE report_id='tenant-probe'",
      ),
    ).toEqual([{ report_id: 'tenant-probe' }]);
    expect(
      await tenantSql(
        db.app,
        otherTenant,
        "SELECT * FROM payments_ledger.oig_exception_report WHERE report_id='tenant-probe'",
      ),
    ).toEqual([]);
    expect(
      (
        await db.app.query(
          "SELECT * FROM payments_ledger.oig_exception_report WHERE report_id='tenant-probe'",
        )
      ).rows,
    ).toEqual([]);
    await expect(tenantSql(db.app, otherTenant, report('forged'))).rejects.toMatchObject({
      code: '42501',
    });
    for (const sql of [
      "UPDATE payments_ledger.oig_exception_report SET patient_ref='changed' WHERE report_id='tenant-probe'",
      "DELETE FROM payments_ledger.oig_exception_report WHERE report_id='tenant-probe'",
    ])
      await expect(tenantSql(db.app, tenant, sql)).rejects.toMatchObject({ code: '42501' });
  });
});

describe('0071 target-specific open receivable at commit', () => {
  it('commits a funded write-off and rejects cumulative overdraft without leaving rows', async () => {
    await tenantSql(db.app, tenant, journal('fund-cumulative', 'cumulative', 100));
    await tenantSql(db.app, tenant, writeOff('first-cumulative', 'cumulative', 70));
    expect(await balance(db.app, 'cumulative')).toBe(30);
    await expect(
      tenantSql(db.app, tenant, writeOff('second-cumulative', 'cumulative', 31)),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('below zero') });
    expect(await balance(db.app, 'cumulative')).toBe(30);
    expect(
      await tenantSql(
        db.app,
        tenant,
        "SELECT * FROM payments_ledger.write_off WHERE write_off_id='second-cumulative'",
      ),
    ).toEqual([]);
    await tenantSql(db.app, tenant, writeOff('last-cumulative', 'cumulative', 30));
    expect(await balance(db.app, 'cumulative')).toBe(0);
  });
  it.each(['unfunded', 'wrong-target', 'wrong-currency', 'wrong-tenant'])(
    'rejects %s funding at deferred COMMIT',
    async (scenario) => {
      if (scenario !== 'unfunded') {
        const t = scenario === 'wrong-tenant' ? otherTenant : tenant;
        await tenantSql(
          db.app,
          t,
          journal(
            `fund-${scenario}`,
            scenario === 'wrong-target' ? 'another-target' : scenario,
            100,
            { tenant: t, currency: scenario === 'wrong-currency' ? 'EUR' : 'USD' },
          ),
        );
      }
      await db.app.query('BEGIN');
      try {
        await db.app.query(tenantBindingSql(tenant));
        // INSERT succeeds; the intended failure must occur at COMMIT, not an unrelated FK/grant.
        await db.app.query(writeOff(`write-${scenario}`, scenario, 1));
        await expect(db.app.query('COMMIT')).rejects.toMatchObject({
          code: '23514',
          message: expect.stringContaining('below zero'),
        });
      } finally {
        await db.app.query('ROLLBACK');
      }
    },
  );
  it('refuses a distinct journal reusing an already consumed approval', async () => {
    await tenantSql(db.app, tenant, journal('fund-once', 'once', 100));
    await tenantSql(db.app, tenant, writeOff('once-a', 'once', 10));
    const reused = writeOff('once-b', 'once', 10).replaceAll(hash('once-b'), hash('once-a'));
    await expect(tenantSql(db.app, tenant, reused)).rejects.toMatchObject({
      code: '23505',
      constraint: 'write_off_one_use_per_approval',
    });
    expect(await balance(db.app, 'once')).toBe(90);
  });
  it('prevents two concurrent separate approvals from overdrawing the same funded target', async () => {
    const witness = await concurrentWriteOffs(db, 'race');
    expect(witness, JSON.stringify(witness)).toMatchObject({
      blockedOnA: true,
      committed: [true, false],
      balance: 30,
      committedIds: [{ write_off_id: 'race-a' }],
      rejection: { code: '23514', message: 'write-off race-b takes receivable race below zero' },
    });
  });
  it('reproduces both commits with the immutable original 0071 failure control', async () => {
    expect(hash(original0071)).toBe(original0071Sha256);
    const original = await createLedgerDb('original0071', finalMigrations);
    try {
      await atomicSql(original.owner, original0071);
      const witness = await concurrentWriteOffs(original, 'old-race');
      expect(witness, JSON.stringify(witness)).toMatchObject({
        blockedOnA: false,
        committed: [true, true],
        balance: -40,
        committedIds: [{ write_off_id: 'old-race-a' }, { write_off_id: 'old-race-b' }],
      });
    } finally {
      await original.dispose();
    }
  });
  it.each(['READ UNCOMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'])(
    'refuses unsupported %s with the precise isolation diagnostic',
    async (mode) => {
      const id = mode.toLowerCase().replaceAll(' ', '-');
      await tenantSql(db.app, tenant, journal(`fund-${id}`, id, 100));
      await db.app.query(`BEGIN ISOLATION LEVEL ${mode}`);
      try {
        await db.app.query(tenantBindingSql(tenant));
        await db.app.query(writeOff(`write-${id}`, id, 10));
        await expect(db.app.query('COMMIT')).rejects.toMatchObject({
          code: '23514',
          message: 'governed write-off insertion requires READ COMMITTED isolation',
        });
      } finally {
        await db.app.query('ROLLBACK');
      }
      expect(await balance(db.app, id)).toBe(100);
    },
  );
  it.each(['rollback', 'failure'] as const)(
    'releases the transaction lock after %s',
    async (end) => {
      const witness = await concurrentWriteOffs(db, `release-${end}`, end);
      expect(witness, JSON.stringify(witness)).toMatchObject({
        blockedOnA: true,
        committed: [false, true],
        balance: 30,
        committedIds: [{ write_off_id: `release-${end}-b` }],
      });
    },
  );
  it.each(['target', 'currency'] as const)(
    'allows independent %s while the first check is uncommitted',
    async (dimension) => {
      const target = `independent-${dimension}`;
      const other = dimension === 'target' ? `${target}-other` : target;
      const currency = dimension === 'currency' ? 'EUR' : 'USD';
      await tenantSql(
        db.app,
        tenant,
        journal(`${target}-fund`, target, 100) +
          journal(`${target}-fund-other`, other, 100, { currency }),
      );
      const a = await db.newApp();
      const b = await db.newApp();
      try {
        await a.query('BEGIN');
        await a.query(tenantBindingSql(tenant));
        await a.query(writeOff(`${target}-a`, target, 70));
        await a.query('SET CONSTRAINTS ALL IMMEDIATE');
        // A remains open; B must complete, not time out waiting on an unrelated key.
        await tenantSql(b, tenant, writeOff(`${target}-b`, other, 70, { currency }));
        await a.query('COMMIT');
        expect(await balance(db.app, target)).toBe(30);
        const rows = await tenantSql(
          db.app,
          tenant,
          "SELECT sum(CASE WHEN side='debit' THEN amount_minor ELSE -amount_minor END)::text AS amount FROM payments_ledger.journal_line WHERE account_ref='accounts-receivable' AND source_ref=$1 AND currency=$2",
          [other, currency],
        );
        expect(rows).toEqual([{ amount: '30' }]);
      } finally {
        await a.query('ROLLBACK');
        await b.query('ROLLBACK');
      }
    },
  );
  it('reuses its transaction lock across forced deferred checks', async () => {
    await tenantSql(db.app, tenant, journal('reuse-fund', 'reuse', 100));
    await db.app.query('BEGIN');
    try {
      await db.app.query(tenantBindingSql(tenant));
      await db.app.query(writeOff('reuse-a', 'reuse', 30));
      await db.app.query('SET CONSTRAINTS ALL IMMEDIATE');
      // The first check keeps its transaction lock. Defer checks while building
      // the next balanced journal, then force them again in this transaction.
      await db.app.query('SET CONSTRAINTS ALL DEFERRED');
      await db.app.query(writeOff('reuse-b', 'reuse', 40));
      await db.app.query('SET CONSTRAINTS ALL IMMEDIATE');
      await db.app.query('COMMIT');
    } finally {
      await db.app.query('ROLLBACK');
    }
    expect(await balance(db.app, 'reuse')).toBe(30);
  });
});

describe('0072 fresh schema, strict defects and repeat', () => {
  it('requires all nine ordinary tables with enabled and forced RLS', async () => {
    expect(await tables(db.owner)).toEqual(
      paymentsLedgerSchemaRlsSpecs
        .map((spec) => ({
          relname: spec.table,
          relrowsecurity: true,
          relforcerowsecurity: true,
        }))
        .sort((a, b) => a.relname.localeCompare(b.relname)),
    );
  });
  it.each([
    ['CREATE TABLE payments_ledger.undeclared (id text)', /rls coverage failure.*undeclared/],
    [
      'CREATE TABLE payments_ledger.undeclared (id text); ALTER TABLE payments_ledger.undeclared ENABLE ROW LEVEL SECURITY; ALTER TABLE payments_ledger.undeclared FORCE ROW LEVEL SECURITY',
      /rls coverage failure.*undeclared/,
    ],
    [
      'ALTER TABLE payments_ledger.journal NO FORCE ROW LEVEL SECURITY',
      /rls coverage failure.*journal/,
    ],
    [
      'ALTER TABLE payments_ledger.journal DISABLE ROW LEVEL SECURITY',
      /rls coverage failure.*journal/,
    ],
    [
      'ALTER TABLE payments_ledger.oig_exception_report RENAME TO missing_report',
      /ledger-0072 prerequisite.*oig_exception_report/,
    ],
  ])('rejects controlled isolated schema defect: %s', async (sql, message) => {
    await checkpointDefect(sql, message);
    await checkpointDefect(sql, message, '0072-ledger-rls-coverage.rollback.sql');
  });
  it('does not pass an empty schema', async () => {
    const empty = await createLedgerDb('empty', []);
    try {
      await expect(empty.migrate(['0072-ledger-rls-coverage.sql'])).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('prerequisite missing ordinary tables'),
      });
      expect(await tables(empty.owner)).toEqual([]);
    } finally {
      await empty.dispose();
    }
  });
  it('repeats checkpoint and validating rollback without changing schema or report rows', async () => {
    const before = await schemaFingerprint(db.owner);
    const rows = await tenantSql(
      db.app,
      tenant,
      'SELECT * FROM payments_ledger.oig_exception_report ORDER BY report_id,finding_key',
    );
    await db.migrate([
      '0072-ledger-rls-coverage.sql',
      '0072-ledger-rls-coverage.sql',
      '0072-ledger-rls-coverage.rollback.sql',
    ]);
    expect(await schemaFingerprint(db.owner)).toEqual(before);
    expect(
      await tenantSql(
        db.app,
        tenant,
        'SELECT * FROM payments_ledger.oig_exception_report ORDER BY report_id,finding_key',
      ),
    ).toEqual(rows);
  });
});

describe('prior-schema upgrade and suffix recovery on separate synthetic targets', () => {
  it('preserves original records, legacy NOT VALID treatment and final schema through upgrade/repeat', async () => {
    const old = await createLedgerDb('upgrade', historicalMigrations);
    try {
      await tenantSql(
        old.app,
        tenant,
        `INSERT INTO payments_ledger.journal
        (tenant_id,journal_id,correlation_id,idempotency_key,canonical_payload_hash,occurred_at,synthetic)
        VALUES ('${tenant}','legacy','legacy','legacy','${hash('legacy')}','2026-01-01T00:00:00Z',true);
        INSERT INTO payments_ledger.journal_line
        (tenant_id,journal_id,line_no,account_ref,side,amount_minor,currency,source_ref,synthetic) VALUES
        ('${tenant}','legacy',1,'write-off-expense','debit',10,'USD','legacy-target',true),
        ('${tenant}','legacy',2,'accounts-receivable','credit',10,'USD','legacy-target',true);
        INSERT INTO payments_ledger.write_off (tenant_id,write_off_id,journal_id,reason,role,amount_minor,currency,synthetic)
        VALUES ('${tenant}','legacy','legacy','small-balance','billing-supervisor',10,'USD',true);
        INSERT INTO payments_ledger.payout_drift_work_item
        (tenant_id,payout_ref,currency,ledger_minor,payout_minor,drift_minor,synthetic)
        VALUES ('${tenant}','legacy-payout','USD',100,99,-1,true);
        INSERT INTO payments_ledger.dunning_account (tenant_id,account_ref,deceased,dunning,synthetic)
        VALUES ('${tenant}','legacy-account',false,'active',true);`,
      );
      const original = await tenantSql(
        old.app,
        tenant,
        'SELECT tenant_id,write_off_id,journal_id,reason,role,amount_minor,currency,synthetic FROM payments_ledger.write_off',
      );
      await old.migrate(suffixMigrations);
      expect(
        await tenantSql(
          old.app,
          tenant,
          'SELECT tenant_id,write_off_id,journal_id,reason,role,amount_minor,currency,synthetic FROM payments_ledger.write_off',
        ),
      ).toEqual(original);
      expect(
        await tenantSql(
          old.app,
          tenant,
          'SELECT target_ref,approval_hash,approver_actor_id,requester_actor_id FROM payments_ledger.write_off',
        ),
      ).toEqual([
        {
          target_ref: null,
          approval_hash: null,
          approver_actor_id: null,
          requester_actor_id: null,
        },
      ]);
      expect(
        (
          await old.owner.query(
            "SELECT convalidated FROM pg_constraint WHERE conname='write_off_governed' AND conrelid='payments_ledger.write_off'::regclass",
          )
        ).rows,
      ).toEqual([{ convalidated: false }]);
      const drift = await tenantSql(
        old.app,
        tenant,
        'SELECT * FROM payments_ledger.payout_drift_work_item',
      );
      expect(drift).toHaveLength(1);
      expect(drift[0]?.['reconciliation_id']).toBeTruthy();
      await tenantSql(
        old.app,
        tenant,
        `SELECT payments_ledger.record_deceased_stop('${tenant}','legacy-account')`,
      );
      await old.migrate(suffixMigrations);
      expect(
        await tenantSql(old.app, tenant, 'SELECT * FROM payments_ledger.payout_drift_work_item'),
      ).toEqual(drift);
      expect(
        await tenantSql(
          old.app,
          tenant,
          "SELECT deceased,dunning,stopped_reason FROM payments_ledger.dunning_account WHERE account_ref='legacy-account'",
        ),
      ).toEqual([{ deceased: true, dunning: 'stopped', stopped_reason: 'deceased' }]);
      expect(await schemaFingerprint(old.owner)).toEqual(await schemaFingerprint(db.owner));
      await expect(
        tenantSql(old.app, tenant, writeOff('upgraded-unfunded', 'upgraded-unfunded', 1)),
      ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('below zero') });
    } finally {
      await old.dispose();
    }
  });
  it('rolls back suffix atomically, preserves exported synthetic OIG rows and reapplies all defenses', async () => {
    const recovery = await createLedgerDb('recovery', finalMigrations);
    try {
      await tenantSql(recovery.app, tenant, report('preserved'));
      await tenantSql(
        recovery.app,
        tenant,
        journal('recovery-fund', 'recovery-target', 100) +
          writeOff('recovery-write', 'recovery-target', 10),
      );
      await tenantSql(
        recovery.app,
        tenant,
        `INSERT INTO payments_ledger.dunning_account (tenant_id,account_ref,deceased,dunning,synthetic)
        VALUES ('${tenant}','stopped',false,'active',true); SELECT payments_ledger.record_deceased_stop('${tenant}','stopped');`,
      );
      const schema = await schemaFingerprint(recovery.owner);
      const [exported] = await tenantSql(
        recovery.app,
        tenant,
        "SELECT to_jsonb(r)::text AS payload FROM payments_ledger.oig_exception_report r WHERE report_id='preserved'",
      );
      expect(exported?.['payload']).toEqual(expect.any(String));
      // 0070 rollback deliberately drops only this owned synthetic report table.
      for (const name of [...suffixMigrations].reverse())
        await recovery.migrate([name.replace('.sql', '.rollback.sql')]);
      expect(
        await tenantSql(
          recovery.app,
          tenant,
          'SELECT deceased,dunning,stopped_reason FROM payments_ledger.dunning_account',
        ),
      ).toEqual([{ deceased: true, dunning: 'stopped', stopped_reason: 'deceased' }]);
      expect(
        (
          await recovery.owner.query(
            "SELECT to_regclass('payments_ledger.oig_exception_report') AS report",
          )
        ).rows,
      ).toEqual([{ report: null }]);
      await expect(recovery.migrate(['0072-ledger-rls-coverage.sql'])).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('oig_exception_report'),
      });
      await recovery.migrate(suffixMigrations);
      await tenantSql(
        recovery.app,
        tenant,
        `INSERT INTO payments_ledger.oig_exception_report
        SELECT * FROM jsonb_populate_record(NULL::payments_ledger.oig_exception_report,$1::jsonb)`,
        [exported?.['payload']],
      );
      expect(
        await tenantSql(
          recovery.app,
          tenant,
          "SELECT to_jsonb(r)::text AS payload FROM payments_ledger.oig_exception_report r WHERE report_id='preserved'",
        ),
      ).toEqual([exported]);
      expect(await balance(recovery.app, 'recovery-target')).toBe(90);
      expect(await schemaFingerprint(recovery.owner)).toEqual(schema);
      await expect(
        tenantSql(recovery.app, tenant, writeOff('recovery-overdraw', 'recovery-target', 91)),
      ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('below zero') });
      await expect(
        tenantSql(
          recovery.app,
          tenant,
          `SELECT payments_ledger.assert_dunning_allowed('${tenant}','stopped')`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await recovery.dispose();
    }
  });
  it('refuses lossy 0068 rollback atomically when a payout has multiple drift runs', async () => {
    const recovery = await createLedgerDb('refusal', finalMigrations);
    try {
      await tenantSql(
        recovery.app,
        tenant,
        `INSERT INTO payments_ledger.payout_drift_work_item
        (tenant_id,payout_ref,currency,ledger_minor,payout_minor,drift_minor,synthetic,reconciliation_id) VALUES
        ('${tenant}','same-payout','USD',100,99,-1,true,'run-a'),('${tenant}','same-payout','USD',100,98,-2,true,'run-b');`,
      );
      const before = await schemaFingerprint(recovery.owner);
      const rows = await tenantSql(
        recovery.app,
        tenant,
        'SELECT * FROM payments_ledger.payout_drift_work_item ORDER BY reconciliation_id',
      );
      await expect(
        atomicSql(
          recovery.owner,
          readMigration('0071-write-off-open-receivable.rollback.sql') +
            readMigration('0068-ledger-v2-governance.rollback.sql'),
        ),
      ).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('more than one drift item'),
      });
      expect(await schemaFingerprint(recovery.owner)).toEqual(before);
      expect(
        await tenantSql(
          recovery.app,
          tenant,
          'SELECT * FROM payments_ledger.payout_drift_work_item ORDER BY reconciliation_id',
        ),
      ).toEqual(rows);
    } finally {
      await recovery.dispose();
    }
  });
});
