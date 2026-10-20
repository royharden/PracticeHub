import { randomUUID } from 'node:crypto';

import { tenantBindingSql } from '@practicehub/platform-core';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createLedgerDb, finalMigrations, type LedgerDb } from './db-test-harness.js';

const tenant = 'northwind-synthetic';
const hash = (char: string): string => char.repeat(64);
let db: LedgerDb | undefined;
let app: Client;

beforeAll(async () => {
  db = await createLedgerDb('final_v2', finalMigrations);
  app = db.app;
  await db.migrate(['0068-ledger-v2-governance.sql']);
});
afterAll(async () => {
  await db?.dispose();
});

/** Run in a tenant-bound transaction, force deferred checks, then roll back. */
async function bound(sql: string): Promise<void> {
  await app.query('BEGIN');
  try {
    await app.query(tenantBindingSql(tenant));
    await app.query(sql);
    await app.query('SET CONSTRAINTS ALL IMMEDIATE');
    await app.query('ROLLBACK');
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

async function commitBound(sql: string): Promise<void> {
  await app.query('BEGIN');
  try {
    await app.query(tenantBindingSql(tenant));
    await app.query(sql);
    await app.query('COMMIT');
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
}

interface JournalSpec {
  readonly id: string;
  readonly rail?: string;
  readonly payoutRef?: string | null;
  readonly reversalOf?: string | null;
  readonly approvalHash?: string | null;
  readonly lines: readonly (readonly [string, 'debit' | 'credit', number, string])[];
}

function journalSql(spec: JournalSpec): string {
  const text = (value: string | null | undefined): string =>
    value === null || value === undefined ? 'NULL' : `'${value}'`;
  const lines = spec.lines
    .map(
      ([account, side, amount, source], index) =>
        `('${tenant}','${spec.id}',${String(index + 1)},'${account}','${side}',${String(amount)},'USD','${source}',true)`,
    )
    .join(',');
  return `INSERT INTO payments_ledger.journal
      (tenant_id,journal_id,correlation_id,idempotency_key,canonical_payload_hash,rail,payout_ref,
       reversal_of_journal_id,write_off_approval_hash,occurred_at,synthetic)
    VALUES ('${tenant}','${spec.id}','c-${spec.id}','k-${spec.id}','${hash('a')}',${text(spec.rail ?? 'cash')},
       ${text(spec.payoutRef)},${text(spec.reversalOf)},${text(spec.approvalHash)},now(),true);
    INSERT INTO payments_ledger.journal_line
      (tenant_id,journal_id,line_no,account_ref,side,amount_minor,currency,source_ref,synthetic)
    VALUES ${lines};`;
}

interface WriteOffSpec {
  readonly id: string;
  readonly journalId: string;
  readonly reason: string;
  readonly role: string;
  readonly amount: number;
  readonly targetRef: string;
  readonly approvalHash: string;
  readonly approver: string;
  readonly requester: string;
}

function writeOffSql(spec: WriteOffSpec): string {
  return `INSERT INTO payments_ledger.write_off
      (tenant_id,write_off_id,journal_id,reason,role,amount_minor,currency,synthetic,
       target_ref,approval_hash,approver_actor_id,requester_actor_id)
    VALUES ('${tenant}','${spec.id}','${spec.journalId}','${spec.reason}','${spec.role}',
       ${String(spec.amount)},'USD',true,'${spec.targetRef}','${spec.approvalHash}',
       '${spec.approver}','${spec.requester}');`;
}

function writeOffJournal(id: string, amount: number, target: string, approvalHash: string): string {
  return journalSql({
    id,
    approvalHash,
    lines: [
      ['write-off-expense', 'debit', amount, target],
      ['accounts-receivable', 'credit', amount, target],
    ],
  });
}

function funding(id: string, target: string, amount = 2000): string {
  return journalSql({
    id: `fund-${id}`,
    lines: [
      ['accounts-receivable', 'debit', amount, target],
      ['revenue', 'credit', amount, target],
    ],
  });
}

interface GuardDiagnostic {
  code: string;
  constraint?: string;
  message?: string;
}
/** The identical strict matcher must reject the single-guard mutant's outcome. */
async function strictGuardProbe(
  sql: string,
  diagnostic: GuardDiagnostic,
  mutation: string,
): Promise<void> {
  await expect(bound(sql)).rejects.toMatchObject(diagnostic);
  if (!db) throw new Error('Missing isolated fixture');
  const owner = db.owner;
  let outcome: unknown = { success: true };
  await owner.query('BEGIN');
  try {
    // Owner DDL and probe share a connection: no invisible uncommitted DDL or cross-client lock.
    await owner.query(mutation);
    await owner.query('SET LOCAL ROLE practicehub_app');
    await owner.query(tenantBindingSql(tenant));
    try {
      await owner.query(sql);
      await owner.query('SET CONSTRAINTS ALL IMMEDIATE');
    } catch (error) {
      outcome = error;
    }
  } finally {
    await owner.query('ROLLBACK');
  }
  // A different defense may still reject (notably missing approval); it must not masquerade as this guard.
  expect(outcome).not.toMatchObject(diagnostic);
  if (outcome instanceof Error) {
    expect(outcome.message).not.toContain('below zero');
    expect(outcome).toMatchObject({
      code: '23514',
      message: expect.stringMatching(/^write-off .* does not match journal /),
    });
  }
  // Rollback restored the guard, checked with the same funded probe.
  await expect(bound(sql)).rejects.toMatchObject(diagnostic);
}

describe('0021 ledger v2 constraints (first observation)', () => {
  it('rejects an under-tier write_off row', async () => {
    const id = randomUUID();
    // PostgreSQL names this table-level multi-column CHECK write_off_check.
    const constraint = await db?.owner.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='payments_ledger.write_off'::regclass AND conname='write_off_check'",
    );
    expect(constraint?.rows).toHaveLength(1);
    expect(constraint?.rows[0]?.definition).toContain('charity');
    expect(constraint?.rows[0]?.definition).toContain('rcm-lead');
    await strictGuardProbe(
      funding(id, `ar-${id}`) +
        writeOffJournal(`j-${id}`, 500, `ar-${id}`, hash('b')) +
        writeOffSql({
          id: `wo-${id}`,
          journalId: `j-${id}`,
          reason: 'charity',
          role: 'billing-supervisor',
          amount: 500,
          targetRef: `ar-${id}`,
          approvalHash: hash('b'),
          approver: 'synthetic-supervisor-1',
          requester: 'synthetic-clerk-1',
        }),
      { code: '23514', constraint: 'write_off_check' },
      'ALTER TABLE payments_ledger.write_off DROP CONSTRAINT write_off_check',
    );
  });

  it('rejects payout_ref on a non-cash rail', async () => {
    const id = randomUUID();
    await expect(
      bound(
        journalSql({
          id: `j-${id}`,
          rail: 'membership',
          payoutRef: 'po-1',
          lines: [
            ['cash', 'debit', 10, 's'],
            ['revenue', 'credit', 10, 's'],
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('0068 reversal keeps rail and payout_ref', () => {
  it('rejects a reversal on another rail or payout and accepts the exact one', async () => {
    const id = randomUUID();
    const original = journalSql({
      id: `j-${id}`,
      rail: 'cash',
      payoutRef: 'po-1',
      lines: [
        ['cash', 'debit', 10, 's'],
        ['revenue', 'credit', 10, 's'],
      ],
    });
    await commitBound(original);
    const reversal = (rail: string, payoutRef: string | null) =>
      journalSql({
        id: `r-${id}-${rail}-${String(payoutRef)}`,
        rail,
        payoutRef,
        reversalOf: `j-${id}`,
        lines: [
          ['cash', 'credit', 10, 's'],
          ['revenue', 'debit', 10, 's'],
        ],
      });
    await expect(bound(reversal('membership', null))).rejects.toMatchObject({ code: '23514' });
    await expect(bound(reversal('cash', 'po-2'))).rejects.toMatchObject({ code: '23514' });
    await expect(bound(reversal('cash', null))).rejects.toMatchObject({ code: '23514' });
    await expect(bound(reversal('cash', 'po-1'))).resolves.toBeUndefined();
  });
});

describe('0068 write-off governance', () => {
  const approved = (id: string, overrides: Partial<WriteOffSpec> = {}): WriteOffSpec => ({
    id: `wo-${id}`,
    journalId: `j-${id}`,
    reason: 'small-balance',
    role: 'billing-supervisor',
    amount: 900,
    targetRef: `ar-${id}`,
    approvalHash: hash('c'),
    approver: 'synthetic-supervisor-1',
    requester: 'synthetic-clerk-1',
    ...overrides,
  });

  it('accepts a governed write-off that matches its journal', async () => {
    const id = randomUUID();
    await expect(
      bound(
        journalSql({
          id: `opening-${id}`,
          lines: [
            ['accounts-receivable', 'debit', 900, `ar-${id}`],
            ['revenue', 'credit', 900, `ar-${id}`],
          ],
        }) +
          writeOffJournal(`j-${id}`, 900, `ar-${id}`, hash('c')) +
          writeOffSql(approved(id)),
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects reuse of one approval hash', async () => {
    const id = randomUUID();
    const second = `${id}-2`;
    await expect(
      bound(
        funding(id, `ar-${id}`) +
          writeOffJournal(`j-${id}`, 900, `ar-${id}`, hash('d')) +
          writeOffSql(approved(id, { approvalHash: hash('d') })) +
          writeOffJournal(`j-${second}`, 900, `ar-${id}`, hash('d')) +
          writeOffSql(approved(second, { approvalHash: hash('d'), targetRef: `ar-${id}` })),
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'write_off_one_use_per_approval' });
  });

  it('rejects self-approval and a row missing its approval', async () => {
    const id = randomUUID();
    const diagnostic = { code: '23514', constraint: 'write_off_governed' };
    const mutation = 'ALTER TABLE payments_ledger.write_off DROP CONSTRAINT write_off_governed';
    await strictGuardProbe(
      funding(id, `ar-${id}`) +
        writeOffJournal(`j-${id}`, 900, `ar-${id}`, hash('e')) +
        writeOffSql(approved(id, { approvalHash: hash('e'), approver: 'synthetic-clerk-1' })),
      diagnostic,
      mutation,
    );
    const other = randomUUID();
    await strictGuardProbe(
      funding(other, `ar-${other}`) +
        writeOffJournal(`j-${other}`, 900, `ar-${other}`, hash('f')) +
        `INSERT INTO payments_ledger.write_off
        (tenant_id,write_off_id,journal_id,reason,role,amount_minor,currency,synthetic,target_ref,approver_actor_id,requester_actor_id)
        VALUES ('${tenant}','wo-${other}','j-${other}','small-balance','billing-supervisor',900,'USD',true,'ar-${other}','synthetic-supervisor-1','synthetic-clerk-1');`,
      diagnostic,
      mutation,
    );
  });

  it('rejects a write-off whose journal carries another approval, amount or receivable', async () => {
    for (const [journalHash, amount, target] of [
      [hash('1'), 900, 'ar-x'],
      [hash('2'), 800, 'ar-x'],
      [hash('2'), 900, 'ar-y'],
    ] as const) {
      const id = randomUUID();
      await strictGuardProbe(
        funding(`${id}-intended`, 'ar-x') +
          funding(`${id}-journal`, 'ar-y') +
          writeOffJournal(`j-${id}`, amount, target, journalHash) +
          writeOffSql(approved(id, { approvalHash: hash('2'), targetRef: 'ar-x' })),
        { code: '23514', message: `write-off wo-${id} does not match journal j-${id}` },
        'DROP TRIGGER write_off_matches_journal ON payments_ledger.write_off',
      );
    }
  });
});

describe('0068 payout drift work items', () => {
  it('opens one item per drifting reconciliation run and refuses a duplicate run id', async () => {
    const id = randomUUID();
    const item = (runId: string) =>
      `INSERT INTO payments_ledger.payout_drift_work_item
         (tenant_id,payout_ref,currency,ledger_minor,payout_minor,drift_minor,synthetic,reconciliation_id)
       VALUES ('${tenant}','po-${id}','USD',2500,2499,-1,true,'${runId}');`;
    await expect(bound(item('run-1') + item('run-2'))).resolves.toBeUndefined();
    await expect(bound(item('run-1') + item('run-1'))).rejects.toMatchObject({ code: '23505' });
  });
});
