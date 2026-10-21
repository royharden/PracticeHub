import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  admitTestClusters,
  bindTestDatabase,
  buildMigrationScript,
  discoverMigrations,
  Migration,
  observeMigrationClient,
  runMigrations,
  testDatabaseArguments,
  validateTestTarget,
} from './migrations.js';
import type { BoundCluster, BoundDatabase, ExecutionResult } from './migrations.js';

// Deliberately throws instead of skipping when no target grant is supplied.
const bindingPath = process.env['PH_MIGRATION_TEST_BINDING'];
const bindingHash = process.env['PH_MIGRATION_TEST_BINDING_SHA256'];
if (!bindingPath || resolve(bindingPath) !== bindingPath || !bindingHash)
  throw new Error('A pinned PH_MIGRATION_TEST_BINDING and SHA256 target/heavy grant are required');
const bindingBytes = readFileSync(bindingPath);
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
if (hash(bindingBytes) !== bindingHash) throw new Error('DB target binding digest differs');
const target = validateTestTarget(JSON.parse(bindingBytes.toString()));
const root = resolve('../..');
const forward = discoverMigrations(root);
const head = discoverMigrations(target.headRoot);
const pinnedBytes = readFileSync(join(target.headRoot, 'manifest.json'));
if (hash(pinnedBytes) !== target.headManifestSha256)
  throw new Error('HEAD manifest digest differs');
const pinned = JSON.parse(pinnedBytes.toString()) as {
  commit: string;
  files: { path: string; sha256: string; bytes: number }[];
};
if (
  pinned.commit !== '5a9be52224c93efd95175c3ec5a4ddc0c75ad948' ||
  head.length !== 42 ||
  JSON.stringify(pinned.files) !==
    JSON.stringify(head.map((m) => ({ path: m.path, sha256: m.sha256, bytes: m.size })))
)
  throw new Error('Expected complete pinned 42-file HEAD source');
for (const [i, m] of head.entries())
  if (forward[i]?.path !== m.path || forward[i]?.sha256 !== m.sha256)
    throw new Error(`HEAD is not immutable forward prefix: ${m.path}`);
const initPaths = ['infra/postgres/init/001-bootstrap.sql', 'infra/postgres/init/002-seed.sql'];
const initHashes = [
  '07b4e0ae1167512c15f5c6828357b84a480de9e305ca4eb3dfe58e52e56010e4',
  'e624f0b28ed46fc3337c6c15db8f2f014e98e7e2350bc6640259d5a14e087b0d',
];
const init = initPaths.map((path, i) => {
  const bytes = readFileSync(join(root, path));
  if (hash(bytes) !== initHashes[i]) throw new Error('Bootstrap source differs');
  return bytes;
});
const args = testDatabaseArguments;
// Assigned once by beforeAll; routing thereafter lives in each frozen database reference.
let admitted: ReturnType<typeof admitTestClusters> | undefined;
const execute = (db: BoundDatabase, sql: Buffer | string, timeout = 110000): ExecutionResult => {
  const result = spawnSync('docker', args(db), {
    input: sql,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.error?.message ?? result.stderr ?? '',
  };
};
const query = (db: BoundDatabase, sql: string): string => {
  const r = execute(db, sql, 5000);
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const migrate = (db: BoundDatabase, files: readonly Migration[]) =>
  runMigrations(files, (sql) => execute(db, sql));
const sample = (ordinal: string, sql: string) =>
  new Migration(`modules/example/migrations/${ordinal}-fixture.sql`, Buffer.from(sql));
const first = sample(
  '0001',
  'CREATE TABLE public.synthetic_effect (id integer PRIMARY KEY, synthetic boolean NOT NULL CHECK(synthetic)); INSERT INTO public.synthetic_effect VALUES(1,true);',
);
function database(suffix: string, cluster?: BoundCluster): BoundDatabase {
  if (!admitted) throw new Error('Both synthetic clusters must be admitted before CREATE DATABASE');
  const db = admitted.database(suffix, cluster);
  // CREATE refuses collisions. No cleanup/reset/drop; granted targets remain for inspection.
  query(bindTestDatabase(db, 'postgres'), `CREATE DATABASE "${db.databaseName}";`);
  const r = execute(db, Buffer.concat(init));
  if (r.status !== 0) throw new Error(r.stderr);
  return db;
}
const journal = (db: BoundDatabase) =>
  query(
    db,
    "SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY position),'[]'::jsonb) FROM local_migrations.applied a;",
  );
const inventory = (db: BoundDatabase) =>
  query(
    db,
    `SELECT jsonb_build_object(
'columns',(SELECT jsonb_agg(jsonb_build_array(table_schema,table_name,column_name,data_type,is_nullable,column_default) ORDER BY table_schema,table_name,ordinal_position) FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema','local_migrations')),
'constraints',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,pg_get_constraintdef(k.oid)) ORDER BY n.nspname,c.relname,k.conname) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','local_migrations')),
'indexes',(SELECT jsonb_agg(indexdef ORDER BY schemaname,tablename,indexname) FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog','local_migrations')),
'security',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname NOT IN ('pg_catalog','information_schema','local_migrations')),
'functions',(SELECT jsonb_agg(pg_get_functiondef(p.oid) ORDER BY n.nspname,p.proname,p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')),
'policies',(SELECT jsonb_agg(to_jsonb(p) ORDER BY schemaname,tablename,policyname) FROM pg_policies p)
);`,
  );

// The grant must authorize termination of only this suite's tagged, captured backend.
function client(db: BoundDatabase, script: Buffer) {
  const tag = `ph_d65_${randomUUID()}`;
  const child = spawn('docker', args(db, tag), { stdio: ['pipe', 'pipe', 'pipe'] });
  const lifecycle = observeMigrationClient(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdin.on('error', (error) => {
    stderr += error.message;
  });
  child.stdin.end(script);
  let identity: { pid: number; started: string } | undefined;
  const identify = (): boolean => {
    const rows = JSON.parse(
      query(
        db,
        `SELECT coalesce(jsonb_agg(jsonb_build_object('pid',pid,'started',backend_start::text)),'[]') FROM pg_stat_activity WHERE datname=current_database() AND application_name='${tag}' AND usename='practicehub';`,
      ),
    ) as { pid: number; started: string }[];
    if (rows.length > 1) throw new Error('Ambiguous owned backend identity');
    const found = rows[0];
    if (found) {
      if (identity && JSON.stringify(identity) !== JSON.stringify(found))
        throw new Error('Owned backend identity changed');
      identity = found;
    }
    return found !== undefined;
  };
  const predicate = (): string => {
    if (!identity || !Number.isSafeInteger(identity.pid) || !/^[0-9 .:+-]+$/.test(identity.started))
      throw new Error('No validated owned backend identity');
    return `pid=${identity.pid} AND backend_start='${identity.started}'::timestamptz AND datname=current_database() AND application_name='${tag}' AND usename='practicehub'`;
  };
  const backend = {
    released: async (): Promise<boolean> => {
      if (identify()) return false;
      if (!identity) {
        // Absence before observing the session is not proof that a live client cannot connect.
        if (child.exitCode === null && child.signalCode === null) return false;
        return true;
      }
      return (
        query(
          db,
          `SELECT NOT EXISTS(SELECT FROM pg_stat_activity WHERE pid=${identity.pid} AND backend_start='${identity.started}'::timestamptz AND datname=current_database()) AND NOT EXISTS(SELECT FROM pg_locks WHERE pid=${identity.pid} AND locktype='advisory' AND classid=724106 AND objid=1);`,
        ) === 't'
      );
    },
    terminate: async (): Promise<void> => {
      if (!identify()) {
        if (!identity) throw new Error('Owned backend never identified; release unresolved');
        return;
      }
      const result = query(
        db,
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE ${predicate()};`,
      );
      if (result !== 't') throw new Error('Owned backend termination not acknowledged');
    },
  };
  return {
    lifecycle,
    backend,
    output: () => ({ stdout, stderr }),
    async held(): Promise<void> {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (
          identify() &&
          query(
            db,
            `SELECT EXISTS(SELECT FROM pg_locks WHERE pid=${identity?.pid} AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND locktype='advisory' AND classid=724106 AND objid=1 AND granted) AND EXISTS(SELECT FROM pg_stat_activity WHERE ${predicate()} AND state='active' AND wait_event='PgSleep');`,
          ) === 't'
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('Owned backend did not acquire the migration lock');
    },
    async release(): Promise<void> {
      await lifecycle.release(backend, 7000);
      console.log(
        JSON.stringify({
          clientPid: lifecycle.ownedPid,
          database: db,
          tag,
          backend: identity,
          released: true,
          stdout,
          stderr,
        }),
      );
    },
  };
}

const financialRows = (db: BoundDatabase): string =>
  query(
    db,
    `SELECT jsonb_build_object(
'journals',(SELECT jsonb_agg(to_jsonb(j) ORDER BY tenant_id,journal_id) FROM (SELECT tenant_id,journal_id,correlation_id,idempotency_key,canonical_payload_hash,processor_effect_ref,external_receipt_ref,reversal_of_journal_id,posting_xid,occurred_at,synthetic,rail,payout_ref FROM payments_ledger.journal) j),
'lines',(SELECT jsonb_agg(to_jsonb(l) ORDER BY tenant_id,journal_id,line_no) FROM payments_ledger.journal_line l));`,
  );

beforeAll(() => {
  admitted = admitTestClusters(target, (admin) => {
    const result = spawnSync('docker', ['inspect', '--format', '{{.Id}}', admin.containerId], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error('Container inspection failed');
    const observed = JSON.parse(
      query(
        admin,
        "SELECT jsonb_build_object('clusterSystemIdentifier',system_identifier::text,'moduleLabsAbsent',NOT EXISTS(SELECT FROM pg_roles WHERE rolname='module_labs')) FROM pg_control_system();",
      ),
    ) as { clusterSystemIdentifier: string; moduleLabsAbsent: boolean };
    return { containerId: result.stdout.trim(), ...observed };
  });
});
describe('real journal database protocol (requires separate synthetic target grant)', () => {
  it('executes complete HEAD then forward suffix, matches fresh-full, preserves sentinel, and replays with zero effects', () => {
    if (!admitted) throw new Error('Missing cluster admission');
    const upgrade = database('upgrade');
    const fresh = database('fresh', admitted.fresh);
    expect(migrate(upgrade, head)).toMatchObject({ applied: 42, skipped: 0, total: 42 });
    const prefix = journal(upgrade);
    // Minimal real financial fixture at the historical schema. Labs/inventory owner
    // nonempty-data proof bindings are PENDING; this suite does not claim those domains.
    query(
      upgrade,
      `BEGIN;
INSERT INTO platform_core.tenant(tenant_id,display_name,status,synthetic) VALUES('d65-synthetic','D65 Synthetic','active',true);
INSERT INTO payments_ledger.journal(tenant_id,journal_id,correlation_id,idempotency_key,canonical_payload_hash,occurred_at,synthetic)
VALUES('d65-synthetic','d65-journal','d65-correlation','d65-idempotency',repeat('a',64),'2026-01-01T00:00:00Z',true);
INSERT INTO payments_ledger.journal_line(tenant_id,journal_id,line_no,account_ref,side,amount_minor,currency,source_ref,synthetic) VALUES
('d65-synthetic','d65-journal',1,'d65-receivable','debit',12345,'USD','d65-source',true),
('d65-synthetic','d65-journal',2,'d65-revenue','credit',12345,'USD','d65-source',true);
COMMIT;`,
    );
    const money = financialRows(upgrade);
    const moneyHash = hash(Buffer.from(money));
    const parsedMoney = JSON.parse(money) as {
      journals: unknown[];
      lines: { amount_minor: number; side: string }[];
    };
    expect(parsedMoney.journals).toHaveLength(1);
    expect(parsedMoney.lines).toHaveLength(2);
    expect(parsedMoney.lines.map((line) => [line.side, line.amount_minor])).toEqual([
      ['debit', 12345],
      ['credit', 12345],
    ]);
    const assertMoney = (): void => {
      const current = financialRows(upgrade);
      expect(current).toBe(money);
      expect(hash(Buffer.from(current))).toBe(moneyHash);
    };
    // Bootstrap metadata remains an additional, separate sentinel.
    const sentinel = query(
      upgrade,
      'SELECT jsonb_agg(to_jsonb(t) ORDER BY tenant_id) FROM platform_core.synthetic_tenant t;',
    );
    expect(migrate(upgrade, forward)).toMatchObject({
      applied: forward.length - 42,
      skipped: 42,
      total: forward.length,
    });
    expect(JSON.parse(journal(upgrade)).slice(0, 42)).toEqual(JSON.parse(prefix));
    expect(
      query(
        upgrade,
        'SELECT jsonb_agg(to_jsonb(t) ORDER BY tenant_id) FROM platform_core.synthetic_tenant t;',
      ),
    ).toBe(sentinel);
    assertMoney();
    expect(
      query(
        upgrade,
        "SELECT count(*) FROM payments_ledger.journal WHERE journal_id='d65-journal' AND write_off_approval_hash IS NULL;",
      ),
    ).toBe('1');
    expect(migrate(fresh, forward).applied).toBe(forward.length);
    expect(inventory(upgrade)).toBe(inventory(fresh));
    for (const schema of ['payments_ledger', 'inventory']) {
      const coverage = (m: Migration): string | undefined =>
        m.bytes.toString().match(/DO \$coverage\$[\s\S]*?\$coverage\$;/)?.[0];
      const latest = [...forward]
        .reverse()
        .find((m) => coverage(m)?.includes(`n.nspname = '${schema}'`));
      const guard = latest && coverage(latest);
      expect(guard, `complete current ${schema} guard`).toBeDefined();
      for (const protectedTable of [false, true]) {
        const r = execute(
          upgrade,
          `BEGIN; CREATE TABLE ${schema}.synthetic_rogue(id int); ${protectedTable ? `ALTER TABLE ${schema}.synthetic_rogue ENABLE ROW LEVEL SECURITY; ALTER TABLE ${schema}.synthetic_rogue FORCE ROW LEVEL SECURITY;` : ''} ${guard} ROLLBACK;`,
        );
        expect(r.status).not.toBe(0);
        expect(r.stderr).toMatch(/rls coverage failure/);
        expect(query(upgrade, `SELECT to_regclass('${schema}.synthetic_rogue') IS NULL;`)).toBe(
          't',
        );
      }
      const original = head.find((m) =>
        m.path.includes(schema === 'inventory' ? '/0066-' : '/0019-'),
      );
      expect(original).toBeDefined();
      const obsolete = original && coverage(original);
      expect(obsolete).toBeDefined();
      const rejection = execute(upgrade, `BEGIN; ${obsolete} ROLLBACK;`);
      expect(rejection.status).not.toBe(0);
      expect(rejection.stderr).toMatch(/rls coverage failure/);
    }
    const before = journal(upgrade);
    const schema = inventory(upgrade);
    expect(migrate(upgrade, forward)).toMatchObject({ applied: 0, skipped: forward.length });
    expect(journal(upgrade)).toBe(before);
    assertMoney();
    expect(inventory(upgrade)).toBe(schema);
    expect(
      query(
        upgrade,
        'SELECT jsonb_agg(to_jsonb(t) ORDER BY tenant_id) FROM platform_core.synthetic_tenant t;',
      ),
    ).toBe(sentinel);
    expect(
      query(
        upgrade,
        'SELECT jsonb_agg(jsonb_build_array(position,path,sha256,bytes) ORDER BY position) FROM local_migrations.applied;',
      ),
    ).toBe(
      query(
        fresh,
        'SELECT jsonb_agg(jsonb_build_array(position,path,sha256,bytes) ORDER BY position) FROM local_migrations.applied;',
      ),
    );
  });
  it('initializes zero rows only on strict bootstrap and protects both metadata tables', () => {
    const db = database('bootstrap');
    expect(migrate(db, [])).toMatchObject({ applied: 0, total: 0 });
    expect(
      query(
        db,
        "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='local_migrations' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity;",
      ),
    ).toBe('2');
    expect(query(db, "SELECT EXISTS(SELECT FROM pg_roles WHERE rolname='practicehub_app');")).toBe(
      't',
    );
    const denied = execute(db, 'SET ROLE practicehub_app; SELECT * FROM local_migrations.applied;');
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toMatch(/permission denied/);
  });
  it.each(['unlogged', 'collation'])(
    'rejects bootstrap %s drift before journal or pending DDL',
    (kind) => {
      const db = database(`bootstrap_${kind}`);
      if (kind === 'unlogged') {
        expect(
          query(
            db,
            "SELECT relpersistence FROM pg_class WHERE oid='platform_core.synthetic_tenant'::regclass;",
          ),
        ).toBe('p');
        query(db, 'ALTER TABLE platform_core.synthetic_tenant SET UNLOGGED;');
        expect(
          query(
            db,
            "SELECT relpersistence FROM pg_class WHERE oid='platform_core.synthetic_tenant'::regclass;",
          ),
        ).toBe('u');
      } else {
        const before = query(
          db,
          "SELECT attcollation FROM pg_attribute WHERE attrelid='platform_core.synthetic_tenant'::regclass AND attname='display_name';",
        );
        // pg_catalog.C is a required alternate catalog identity, not a capability skip.
        const alternate = query(
          db,
          `SELECT oid FROM pg_collation WHERE collname='C' AND collnamespace='pg_catalog'::regnamespace AND oid<>${before};`,
        );
        expect(alternate, 'required alternate collation unavailable: DB proof blocked').toMatch(
          /^\d+$/,
        );
        query(
          db,
          'ALTER TABLE platform_core.synthetic_tenant ALTER COLUMN display_name TYPE text COLLATE pg_catalog."C";',
        );
        expect(
          query(
            db,
            "SELECT attcollation FROM pg_attribute WHERE attrelid='platform_core.synthetic_tenant'::regclass AND attname='display_name';",
          ),
        ).toBe(alternate);
      }
      expect(() => migrate(db, [first])).toThrow(/legacy-unjournaled/);
      expect(
        query(
          db,
          "SELECT to_regnamespace('local_migrations') IS NULL AND to_regclass('public.synthetic_effect') IS NULL;",
        ),
      ).toBe('t');
    },
  );
  it.each(['legacy', 'empty'])(
    'refuses %s journal over business objects before pending DDL',
    (kind) => {
      const db = database(kind);
      if (kind === 'empty') migrate(db, []);
      query(db, 'CREATE SCHEMA unexpected_business;');
      expect(() => migrate(db, [first])).toThrow(/legacy-unjournaled/);
      expect(query(db, "SELECT to_regclass('public.synthetic_effect') IS NULL;")).toBe('t');
    },
  );
  it.each(['bytes', 'missing', 'unknown', 'hole'])(
    'rejects entire invalid prefix (%s) before pending DDL',
    (kind) => {
      const db = database(kind);
      migrate(db, [first]);
      const before = journal(db);
      const next = sample('0002', 'CREATE TABLE public.must_not_exist(id int);');
      let files = [first, next];
      if (kind === 'bytes') files = [sample('0001', first.bytes.toString() + '\n'), next];
      if (kind === 'missing') files = [next];
      if (kind === 'unknown')
        query(
          db,
          "UPDATE local_migrations.applied SET path='modules/unknown/migrations/0001-unknown.sql';",
        );
      if (kind === 'hole') query(db, 'UPDATE local_migrations.applied SET position=2;');
      const invalid = journal(db);
      expect(() => migrate(db, files)).toThrow(/prefix/);
      expect(query(db, "SELECT to_regclass('public.must_not_exist') IS NULL;")).toBe('t');
      expect(journal(db)).toBe(invalid);
      if (kind === 'bytes' || kind === 'missing') expect(journal(db)).toBe(before);
    },
  );
  it('rolls SQL failure back including DDL/data, preserves prefix and permits corrected retry exactly once', () => {
    const db = database('rollback');
    migrate(db, [first]);
    const before = journal(db);
    const bad = sample(
      '0002',
      'CREATE TABLE public.failed_effect(id int); INSERT INTO public.synthetic_effect VALUES(2,true); SELECT 1/0;',
    );
    expect(() => migrate(db, [first, bad])).toThrow();
    expect(journal(db)).toBe(before);
    expect(query(db, "SELECT to_regclass('public.failed_effect') IS NULL;")).toBe('t');
    expect(query(db, 'SELECT count(*) FROM public.synthetic_effect;')).toBe('1');
    const fixed = sample(
      '0002',
      'CREATE TABLE public.failed_effect(id int); INSERT INTO public.synthetic_effect VALUES(2,true);',
    );
    expect(migrate(db, [first, fixed]).applied).toBe(1);
    expect(migrate(db, [first, fixed]).applied).toBe(0);
    expect(query(db, 'SELECT count(*) FROM public.synthetic_effect;')).toBe('2');
  });
  it('journal INSERT failure cannot commit SQL or emit successful readback', () => {
    const db = database('journalfail');
    migrate(db, []);
    // Fault the journal write at the execution boundary, after valid preflight and real SQL.
    // No production bypass: the same CHECK/transaction behavior must reject this row.
    expect(() =>
      runMigrations([first], (script) =>
        execute(
          db,
          Buffer.from(
            script.toString().replace("VALUES(1,'modules/example/", "VALUES(0,'modules/example/"),
          ),
        ),
      ),
    ).toThrow();
    expect(journal(db)).toBe('[]');
    expect(query(db, "SELECT to_regclass('public.synthetic_effect') IS NULL;")).toBe('t');
  });
  it('deferred commit failure rolls migration and journal back', () => {
    const db = database('commitfail');
    migrate(db, []);
    const bad = sample(
      '0001',
      'CREATE TABLE public.deferred_failure(id int UNIQUE DEFERRABLE INITIALLY DEFERRED); INSERT INTO public.deferred_failure VALUES(1),(1);',
    );
    expect(() => migrate(db, [bad])).toThrow();
    expect(journal(db)).toBe('[]');
    expect(query(db, "SELECT to_regclass('public.deferred_failure') IS NULL;")).toBe('t');
  });
  it('serializes two actual sessions, then releases the session lock and skips committed work', async () => {
    const db = database('concurrent');
    migrate(db, []);
    const slow = sample(
      '0001',
      'CREATE TABLE public.once_only(id int); INSERT INTO public.once_only VALUES(1); SELECT pg_sleep(8);',
    );
    const built = buildMigrationScript([slow]);
    const owned = client(db, built.script);
    try {
      await owned.held();
      expect(() => migrate(db, [slow])).toThrow(/busy/);
      expect(await owned.lifecycle.wait(15000), owned.output().stderr).toBe(0);
      expect(owned.output().stdout).toContain(built.marker);
      expect(await owned.backend.released()).toBe(true);
      expect(migrate(db, [slow]).applied).toBe(0);
      expect(query(db, 'SELECT count(*) FROM public.once_only;')).toBe('1');
    } finally {
      await owned.release();
    }
  });
  it('disconnect before COMMIT rolls back effects and releases the lock for exactly-once retry', async () => {
    const db = database('crash');
    migrate(db, []);
    const slow = sample(
      '0001',
      'CREATE TABLE public.crash_effect(id int); INSERT INTO public.crash_effect VALUES(1); SELECT pg_sleep(30);',
    );
    const owned = client(db, buildMigrationScript([slow]).script);
    try {
      await owned.held();
      await owned.backend.terminate();
      expect(await owned.lifecycle.wait(10000)).not.toBe(0);
      await owned.release();
      expect(journal(db)).toBe('[]');
      expect(query(db, "SELECT to_regclass('public.crash_effect') IS NULL;")).toBe('t');
      const retry = sample(
        '0001',
        'CREATE TABLE public.crash_effect(id int); INSERT INTO public.crash_effect VALUES(1);',
      );
      expect(migrate(db, [retry]).applied).toBe(1);
      expect(migrate(db, [retry]).applied).toBe(0);
      expect(query(db, 'SELECT count(*) FROM public.crash_effect;')).toBe('1');
    } finally {
      await owned.release();
    }
  });
  it('lost client acknowledgement after real COMMIT is resolved by journal readback without duplicate effects', () => {
    const db = database('ambiguous');
    expect(() =>
      runMigrations([first], (script) => {
        const actual = execute(db, script);
        expect(actual.status, actual.stderr).toBe(0);
        return {
          status: null,
          stdout: '',
          stderr: 'injected lost acknowledgement after server commit',
        };
      }),
    ).toThrow(/committed prefix/);
    expect(migrate(db, [first])).toMatchObject({ applied: 0, skipped: 1 });
    expect(query(db, 'SELECT count(*) FROM public.synthetic_effect;')).toBe('1');
  });
  it.each(['shape', 'acl', 'rls'])(
    'rejects journal metadata tampering (%s) before pending SQL',
    (kind) => {
      const db = database(`meta_${kind}`);
      migrate(db, []);
      if (kind === 'shape')
        query(db, 'ALTER TABLE local_migrations.applied ALTER COLUMN sha256 DROP NOT NULL;');
      if (kind === 'acl') query(db, 'GRANT SELECT ON local_migrations.applied TO PUBLIC;');
      if (kind === 'rls')
        query(db, 'ALTER TABLE local_migrations.applied NO FORCE ROW LEVEL SECURITY;');
      expect(() => migrate(db, [first])).toThrow(/journal metadata/);
      expect(query(db, "SELECT to_regclass('public.synthetic_effect') IS NULL;")).toBe('t');
    },
  );
});
