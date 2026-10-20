import {
  requireMainTimeoutEvidence,
  type MigrationObservation,
  type BackendIdentity,
} from './migrations.js';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  admitTestClusters,
  createDockerMigrationTransport,
  runMigrationsAsync,
  type MigrationTarget,
  bindTestDatabase,
  buildMigrationScript,
  discoverMigrations,
  Migration,
  observeMigrationClient,
  orderedManifest,
  psqlArguments,
  runMigrations,
  testDatabaseArguments,
  validateSql,
  validateTestTarget,
} from './migrations.js';

const file = (name = '0001-first', sql = 'SELECT 1;'): Migration =>
  new Migration(`modules/example/migrations/${name}.sql`, Buffer.from(sql));
describe('applied-once source and protocol', () => {
  it('retains byte identity and cannot mutate its cached SQL through callers', () => {
    const bytes = Buffer.from('-- CRLF\r\nSELECT 1;\r\n');
    const original = Buffer.from(bytes);
    const migration = new Migration('modules/example/migrations/0001-first.sql', bytes);
    bytes.fill(0);
    migration.bytes.fill(0);
    expect(migration.bytes).toEqual(original);
    expect(migration.sha256).toBe(createHash('sha256').update(original).digest('hex'));
    expect(buildMigrationScript([migration]).script.includes(original)).toBe(true);
    expect(file('0001-first', 'SELECT 1;\n').sha256).not.toBe(
      file('0001-first', 'SELECT 1;\r\n').sha256,
    );
  });
  it('discovers only forward module paths, retaining duplicate ordinals in basename/path order', () => {
    const root = mkdtempSync(join(tmpdir(), 'ph-migrations-'));
    try {
      for (const module of ['z', 'a']) {
        const dir = join(root, 'modules', module, 'migrations');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, '0021-second.sql'), 'SELECT 1;');
        writeFileSync(join(dir, '0021-second.rollback.sql'), 'ROLLBACK;');
      }
      mkdirSync(join(root, 'infra', 'postgres', 'migrations'), { recursive: true });
      writeFileSync(join(root, 'infra', 'postgres', 'migrations', '0000-ignored.sql'), 'BEGIN;');
      const manifest = discoverMigrations(root);
      expect(manifest.map((m) => m.path)).toEqual([
        'modules/a/migrations/0021-second.sql',
        'modules/z/migrations/0021-second.sql',
      ]);
      writeFileSync(join(root, 'modules', 'a', 'migrations', '0021-second.sql'), 'SELECT 2;');
      expect(manifest[0]?.bytes.toString()).toBe('SELECT 1;');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('validates the real complete discovered SQL without executing it', () => {
    const actual = discoverMigrations(resolve('../..'));
    expect(actual.length).toBeGreaterThanOrEqual(42);
    expect(actual.filter((m) => m.path.includes('/0021-'))).toHaveLength(2);
  });
  it.each([
    '../0001-x.sql',
    'modules/x/migrations/0001-x.rollback.sql',
    'modules/x/migrations/../0001-x.sql',
  ])('rejects unsafe path %s', (path) =>
    expect(() => new Migration(path, Buffer.from('SELECT 1;'))).toThrow(),
  );
  it('rejects duplicate identities rather than deduplicating them', () =>
    expect(() => orderedManifest([file(), file()])).toThrow(/Duplicate/));
  it.each([Buffer.from([0xff]), Buffer.from('\uFEFFSELECT 1;'), Buffer.from('SELECT \0;')])(
    'rejects invalid encoding/NUL/BOM',
    (bytes) => expect(() => new Migration('modules/x/migrations/0001-x.sql', bytes)).toThrow(),
  );
  it('allows opaque quoted transaction words, comments, casts and dollar body BEGIN untouched', () => {
    const sql = `/* outer /* BEGIN; */ end */ DO $body$ BEGIN RAISE NOTICE 'COMMIT;'; END $body$; SELECT E'it\\'s', 'BEGIN;''COMMIT', 'x'::text; -- ROLLBACK`;
    expect(() => validateSql(sql)).not.toThrow();
    expect(buildMigrationScript([file('0001-body', sql)]).script.includes(Buffer.from(sql))).toBe(
      true,
    );
  });
  it.each([
    'BEGIN; SELECT 1; COMMIT;',
    'END;',
    'ABORT;',
    'START TRANSACTION;',
    'SAVEPOINT x;',
    "PREPARE TRANSACTION 'x';",
    'VACUUM;',
    'CREATE INDEX CONCURRENTLY x ON a(b);',
    'REINDEX TABLE CONCURRENTLY x;',
    'CREATE DATABASE x;',
    'ALTER SYSTEM SET x=1;',
    '\\i other.sql',
    "SELECT :'input';",
    'COPY x FROM STDIN;',
    'CREATE FUNCTION x() RETURNS int LANGUAGE SQL BEGIN ATOMIC SELECT 1; END;',
    "SELECT 'broken",
    '/* broken',
    'DO $x$ BEGIN',
  ])('rejects unsupported source before invoking executor: %s', (sql) => {
    let calls = 0;
    expect(() =>
      runMigrations([file('0001-bad', sql)], () => {
        calls++;
        return { status: 0, stdout: '', stderr: '' };
      }),
    ).toThrow();
    expect(calls).toBe(0);
  });
  it('validates the complete prefix before pending SQL, and wraps raw bytes plus row in one transaction', () => {
    const raw = 'CREATE TABLE public.synthetic_effect(id int);';
    const script = buildMigrationScript([file('0001-effect', raw)]).script.toString();
    expect(script.indexOf('Migration journal is not the exact source prefix')).toBeLessThan(
      script.indexOf(raw),
    );
    expect(script).toContain(`BEGIN;\n${raw}\n;\nINSERT INTO local_migrations.applied`);
    expect(script.indexOf('pg_try_advisory_lock')).toBeLessThan(script.indexOf(raw));
    expect(script.indexOf('pg_advisory_unlock')).toBeGreaterThan(script.indexOf(raw));
    expect(psqlArguments).toContain('--no-psqlrc');
    expect(psqlArguments).toContain('--set=ON_ERROR_STOP=1');
    expect(psqlArguments).toContain('--set=ON_ERROR_ROLLBACK=off');
  });
  it.each([1, null])('rejects failed/terminated psql status %s', (status) =>
    expect(() =>
      runMigrations([file()], () => ({ status, stdout: '', stderr: 'failure' })),
    ).toThrow(/failed/),
  );
  it('rejects exit-zero without matching complete final readback', () =>
    expect(() => runMigrations([file()], () => ({ status: 0, stdout: '', stderr: '' }))).toThrow(
      /readback/,
    ));
  it('reports only complete committed readback, including replay zero', () => {
    for (const initial of [0, 1]) {
      const result = runMigrations([file()], (script) => {
        const text = script.toString();
        const marker = /PH_MIGRATIONS_[0-9a-f-]+/.exec(text)?.[0];
        const hash = /\|([a-f0-9]{64})' FROM/.exec(text)?.[1];
        return { status: 0, stdout: `${marker}|1|${initial}|${hash}\n`, stderr: '' };
      });
      expect(result.applied).toBe(1 - initial);
      expect(result.skipped).toBe(initial);
    }
  });
  it.each([
    undefined,
    {},
    {
      syntheticOnly: true,
      allowCreateDatabases: true,
      containerId: 'app-postgres',
      databasePrefix: 'practicehub',
    },
    {
      syntheticOnly: true,
      allowCreateDatabases: true,
      containerId: 'a'.repeat(64),
      databasePrefix: 'practicehub',
      headRoot: resolve('.'),
      headManifestSha256: 'a'.repeat(64),
      grant: 'test',
    },
  ])('rejects unsafe or missing DB binding', (value) =>
    expect(() => validateTestTarget(value)).toThrow(),
  );
});

describe('isolated comparison binding and admission', () => {
  const binding = {
    version: 2,
    syntheticOnly: true,
    allowCreateDatabases: true,
    containerId: 'a'.repeat(64),
    clusterSystemIdentifier: '7696560484942077986',
    freshContainerId: 'b'.repeat(64),
    freshClusterSystemIdentifier: '7696560484942077987',
    databasePrefix: 'ph_migration_synthetic_unit',
    headRoot: resolve('.'),
    headManifestSha256: 'c'.repeat(64),
    grant: 'unit-only; no physical grant',
  };
  it.each([
    ['version', undefined],
    ['version', 1],
    ['freshContainerId', undefined],
    ['freshClusterSystemIdentifier', undefined],
    ['clusterSystemIdentifier', undefined],
    ['containerId', 'a'.repeat(12)],
    ['freshContainerId', 'b'.repeat(63)],
    ['freshContainerId', 'z'.repeat(64)],
    ['freshContainerId', binding.containerId],
    ['clusterSystemIdentifier', Number('7696560484942077986')],
    ['clusterSystemIdentifier', '1e19'],
    ['freshClusterSystemIdentifier', '-1'],
    ['freshClusterSystemIdentifier', ' 123'],
    ['freshClusterSystemIdentifier', '07696560484942077986'],
    ['freshClusterSystemIdentifier', binding.clusterSystemIdentifier],
    ['syntheticOnly', false],
    ['allowCreateDatabases', false],
  ])('refuses invalid v2 field %s = %s without a single-cluster fallback', (key, value) => {
    expect(() => validateTestTarget({ ...binding, [String(key)]: value })).toThrow(
      /synthetic target binding/,
    );
  });

  it('admits both clusters before exposing database routes; pins sync and tagged async arguments', () => {
    const target = validateTestTarget(binding);
    const observations: string[] = [];
    const clusters = admitTestClusters(target, (admin) => {
      observations.push(admin.containerId);
      expect(admin.databaseName).toBe('postgres');
      expect(Object.isFrozen(admin)).toBe(true);
      return { ...admin, moduleLabsAbsent: true };
    });
    expect(observations).toEqual([binding.containerId, binding.freshContainerId]);
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(clusters)).toBe(true);
    expect(Object.isFrozen(clusters.primary)).toBe(true);
    expect(Object.isFrozen(clusters.fresh)).toBe(true);
    const upgrade = clusters.database('upgrade');
    const fresh = clusters.database('fresh', clusters.fresh);
    const crash = clusters.database('crash');
    expect([upgrade.containerId, fresh.containerId, crash.containerId]).toEqual([
      binding.containerId,
      binding.freshContainerId,
      binding.containerId,
    ]);
    // A name does not select a cluster; the explicit immutable reference does.
    expect(clusters.database('fresh').containerId).toBe(binding.containerId);
    expect(() => clusters.database('other', { ...clusters.fresh })).toThrow(/not admitted/);
    for (const db of [upgrade, fresh, crash]) {
      expect(Object.isFrozen(db)).toBe(true);
      for (const tag of [undefined, 'owned-backend']) {
        const args = testDatabaseArguments(db, tag);
        expect(args[args.indexOf('psql') - 1]).toBe(db.containerId);
        expect(args[args.indexOf('--dbname') + 1]).toBe(db.databaseName);
        expect(args).toEqual([
          'exec',
          '--interactive',
          ...(tag ? ['--env', `PGAPPNAME=${tag}`] : []),
          db.containerId,
          'psql',
          '--username',
          'practicehub',
          '--dbname',
          db.databaseName,
          ...psqlArguments,
        ]);
      }
      const admin = bindTestDatabase(db, 'postgres');
      expect(admin.containerId).toBe(db.containerId);
      expect(admin.clusterSystemIdentifier).toBe(db.clusterSystemIdentifier);
      expect(admin.databaseName).toBe('postgres');
    }
    expect(() => clusters.database('unsafe"; DROP DATABASE postgres;')).toThrow(/Unsafe/);
  });

  it.each([
    ['primary', 'containerId'],
    ['fresh', 'containerId'],
    ['primary', 'clusterSystemIdentifier'],
    ['fresh', 'clusterSystemIdentifier'],
    ['primary', 'moduleLabsAbsent'],
    ['fresh', 'moduleLabsAbsent'],
  ])('refuses %s %s mismatch before the caller can create a database', (which, field) => {
    const createDatabase = vi.fn();
    expect(() => {
      const clusters = admitTestClusters(validateTestTarget(binding), (admin) => {
        const actual = { ...admin, moduleLabsAbsent: true };
        const selected = which === 'primary' ? binding.containerId : binding.freshContainerId;
        return admin.containerId === selected
          ? { ...actual, [field]: field === 'moduleLabsAbsent' ? false : 'wrong' }
          : actual;
      });
      createDatabase(clusters.database('upgrade'));
    }).toThrow(/admission refused/);
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it('propagates unavailable physical observations before database creation', () => {
    const createDatabase = vi.fn();
    expect(() => {
      const clusters = admitTestClusters(validateTestTarget(binding), () => {
        throw new Error('inspection unavailable');
      });
      createDatabase(clusters.database('upgrade'));
    }).toThrow('inspection unavailable');
    expect(createDatabase).not.toHaveBeenCalled();
  });
});

// Controlled lifecycle faults: these prove supervisor behavior, not Docker/backend effects.
describe('bounded owned-client lifecycle', () => {
  function fixture() {
    const events = new EventEmitter();
    const kill = vi.fn(() => true);
    const child = Object.assign(events, { pid: 1234, kill }) as unknown as ChildProcess;
    return { events, kill, lifecycle: observeMigrationClient(child) };
  }
  it('observes normal close and independently verifies backend release', async () => {
    const f = fixture();
    f.events.emit('close', 0);
    expect(await f.lifecycle.wait(100)).toBe(0);
    const released = vi.fn(async () => true);
    const terminate = vi.fn(async () => {});
    await f.lifecycle.release({ released, terminate }, 100);
    expect(released).toHaveBeenCalledTimes(2);
    expect(terminate).not.toHaveBeenCalled();
    expect(f.kill).not.toHaveBeenCalled();
  });
  it('retains spawn error even when the close event follows', async () => {
    const f = fixture();
    f.events.emit('error', new Error('spawn ENOENT'));
    f.events.emit('close', -2);
    await expect(f.lifecycle.wait(100)).rejects.toThrow('ENOENT');
    await expect(
      f.lifecycle.release({ released: async () => true, terminate: async () => {} }, 100),
    ).rejects.toThrow('Unresolved');
  });
  it('bounds a client that never closes, including cleanup', async () => {
    const f = fixture();
    await expect(f.lifecycle.wait(10)).rejects.toThrow('timed out');
    await expect(
      f.lifecycle.release({ released: async () => true, terminate: async () => {} }, 10),
    ).rejects.toThrow('Unresolved');
    expect(f.kill).toHaveBeenCalledOnce();
  });
  it('does not equate successful client kill/close with backend release', async () => {
    const f = fixture();
    f.kill.mockImplementation(() => {
      f.events.emit('close', null);
      return true;
    });
    const terminate = vi.fn(async () => {});
    await expect(
      f.lifecycle.release({ released: async () => false, terminate }, 30),
    ).rejects.toThrow('Unresolved');
    expect(terminate).toHaveBeenCalledOnce();
    expect(f.kill).toHaveBeenCalledOnce();
  });
  it.each(['failure', 'hang'])(
    'bounds backend termination %s but still closes the owned client',
    async (kind) => {
      const f = fixture();
      f.kill.mockImplementation(() => {
        f.events.emit('close', null);
        return true;
      });
      const terminate = () =>
        kind === 'hang'
          ? new Promise<void>(() => {})
          : Promise.reject(new Error('termination denied'));
      await expect(
        f.lifecycle.release({ released: async () => false, terminate }, 10),
      ).rejects.toThrow('Unresolved');
      expect(f.kill).toHaveBeenCalledOnce();
    },
  );
  it('bounds failed backend observation and preserves cleanup failure', async () => {
    const f = fixture();
    f.kill.mockImplementation(() => {
      f.events.emit('close', null);
      return true;
    });
    await expect(
      f.lifecycle.release(
        { released: () => new Promise<boolean>(() => {}), terminate: async () => {} },
        10,
      ),
    ).rejects.toThrow('Unresolved');
    expect(f.kill).toHaveBeenCalledOnce();
  });
});

// Protocol/lifecycle simulations only; these are NOT operational release evidence.
describe('asynchronous production migration transport', () => {
  const target: MigrationTarget = {
    containerId: 'a'.repeat(64),
    clusterSystemIdentifier: '123456789',
    databaseName: 'ph_migration_synthetic_unit',
    databaseUser: 'practicehub',
    grant: 'unit-only-no-runtime-authority',
  };
  const deadlines = { timeoutMs: 15, cleanupMs: 15 };
  function simulation(
    mode: 'success' | 'sql-error' | 'timeout' | 'mismatch' | 'unknown' = 'success',
    treeReleased = true,
    failMainRelease = false,
  ) {
    let backendPresent = false;
    const termination = vi.fn();
    const spawnFake = vi.fn((_command: string, args: readonly string[]) => {
      const tagArg = args.find((arg) => arg.startsWith('PGAPPNAME='));
      if (tagArg === undefined || tagArg === null)
        throw new Error('Migration simulation requires an application tag');
      const tag = tagArg.slice('PGAPPNAME='.length);
      const isMigration = tag.startsWith('ph_migrate_');
      const events = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const stdin = new EventEmitter();
      const child = Object.assign(events, {
        pid: 500 + spawnFake.mock.calls.length,
        stdout,
        stderr,
        stdin,
        exitCode: null as number | null,
        signalCode: null as string | null,
        kill: vi.fn(() => {
          child.signalCode = 'SIGTERM';
          queueMicrotask(() => events.emit('close', null));
          return true;
        }),
      });
      const finish = (output: string, status = 0) =>
        queueMicrotask(() => {
          stdout.emit('data', Buffer.from(output + '\n'));
          child.exitCode = status;
          events.emit('close', status);
        });
      Object.assign(stdin, {
        write: (text: string) => {
          const markerMatch = text.match(/PH_BACKEND_[a-f0-9-]+/);
          if (markerMatch === null) throw new Error('Missing simulated backend marker');
          const marker = markerMatch[0];
          backendPresent = true;
          queueMicrotask(() =>
            stdout.emit(
              'data',
              Buffer.from(
                marker +
                  JSON.stringify({
                    pid: 400,
                    backendStart: '2026-01-01 00:00:00+00',
                    database: target.databaseName,
                    user: target.databaseUser,
                    tag,
                    systemIdentifier: target.clusterSystemIdentifier,
                  }) +
                  '\n',
              ),
            ),
          );
          return true;
        },
        end: (input: Buffer | string) => {
          const text = input.toString();
          if (isMigration) {
            if (mode === 'timeout' || mode === 'mismatch') return;
            backendPresent = false;
            const markerMatch = text.match(/PH_MIGRATIONS_[a-f0-9-]+/);
            if (markerMatch === null) throw new Error('Missing simulated migration marker');
            const marker = markerMatch[0];
            const hashMatch = text.match(/\|([a-f0-9]{64})'/);
            if (hashMatch === null) throw new Error('Missing simulated migration hash match');
            const hash = hashMatch[1];
            if (hash === undefined || hash === null)
              throw new Error('Missing simulated migration hash');
            finish(`${marker}|1|0|${hash}`, mode === 'sql-error' ? 1 : 0);
          } else if (text.includes('pg_terminate_backend')) {
            termination(text);
            backendPresent = false;
            finish('t');
          } else if (mode === 'unknown') {
            finish('not-json');
          } else {
            finish(
              JSON.stringify({
                tagged: backendPresent ? 1 : 0,
                original: backendPresent ? 1 : 0,
                exact: backendPresent && mode !== 'mismatch' ? 1 : 0,
                locks: backendPresent ? 1 : 0,
              }),
            );
          }
        },
      });
      return child as unknown as ChildProcess;
    });
    const release = vi.fn(async (child: ChildProcess) => {
      if (failMainRelease && child === spawnFake.mock.results[0]?.value)
        throw new Error('first main release failure');
      if (!treeReleased) throw new Error('Local process-tree release UNKNOWN');
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    const transport = createDockerMigrationTransport({
      supervisor: {
        admit: async () => {},
        spawn: (args) => spawnFake('docker', args),
        release,
      },
    });
    const run = () =>
      runMigrationsAsync([file()], (sql) => transport.execute(target, sql, deadlines));
    return { run, spawnFake, termination, release };
  }
  it('main release failure still attempts every later child and preserves an unrelated sentinel', async () => {
    const f = simulation('success', true, true);
    const unrelated = { kill: vi.fn() };
    await expect(f.run()).rejects.toThrow(/Unresolved migration cleanup/);
    const mainResult = f.spawnFake.mock.results[0];
    if (mainResult === undefined || mainResult === null)
      throw new Error('Missing simulated main spawn result');
    const main = mainResult.value;
    const mainIndex = f.release.mock.calls.findIndex(([child]) => child === main);
    expect(mainIndex).toBeGreaterThanOrEqual(0);
    const later = f.release.mock.calls.slice(mainIndex + 1).map(([child]) => child);
    for (const entry of f.spawnFake.mock.results.slice(1)) expect(later).toContain(entry.value);
    expect(later.length).toBeGreaterThan(0);
    expect(unrelated.kill).not.toHaveBeenCalled();
    expect(f.release.mock.calls.flat()).not.toContain(unrelated);
  });
  it('refuses missing native tree supervision before spawning or sending SQL', async () => {
    const spawnFake = vi.fn();
    const transport = createDockerMigrationTransport({
      supervisor: {
        admit: async () => {
          throw new Error('supervisor required');
        },
        spawn: spawnFake as never,
        release: async () => {},
      },
    });
    await expect(transport.execute(target, Buffer.from('SELECT 1'), deadlines)).rejects.toThrow(
      /supervisor required/,
    );
    expect(spawnFake).not.toHaveBeenCalled();
  });
  it('awaits identity, real journal parser and both release observations', async () => {
    const f = simulation();
    await expect(f.run()).resolves.toMatchObject({ applied: 1, skipped: 0, total: 1 });
    expect(f.termination).not.toHaveBeenCalled();
    expect(f.spawnFake.mock.calls.length).toBeGreaterThan(1);
  });
  it('does not turn a valid readback accompanying SQL failure into success', async () => {
    await expect(simulation('sql-error').run()).rejects.toThrow(/Migration attempt failed/);
  });
  it('terminates a timed-out orphan only with the full backend identity and still reports timeout', async () => {
    const f = simulation('timeout');
    await expect(f.run()).rejects.toThrow(/timed out/);
    expect(f.termination).toHaveBeenCalledOnce();
    const terminationCall = f.termination.mock.calls[0];
    if (terminationCall === undefined || terminationCall === null)
      throw new Error('Missing simulated termination call');
    const sql = terminationCall[0] as string;
    expect(sql).toContain('pid=400 AND backend_start=');
    expect(sql).toContain(`datname='${target.databaseName}'`);
    expect(sql).toContain("usename='practicehub' AND application_name='ph_migrate_");
  });
  it('refuses termination when the original PID/start no longer matches user/database/tag', async () => {
    const f = simulation('mismatch');
    await expect(f.run()).rejects.toThrow(/Unresolved migration cleanup/);
    expect(f.termination).not.toHaveBeenCalled();
  });
  it.each(['unknown', 'tree'] as const)('blocks success for %s release proof', async (kind) => {
    const f = simulation(kind === 'unknown' ? 'unknown' : 'success', kind !== 'tree');
    await expect(f.run()).rejects.toThrow(/Unresolved migration cleanup/);
  });
  it('rejects a malformed async journal readback through the same parser as sync', async () => {
    await expect(
      runMigrationsAsync([file()], async () => ({ status: 0, stdout: 'wrong marker', stderr: '' })),
    ).rejects.toThrow(/Missing\/invalid journal readback/);
  });
});

describe('supervised migration target preflight commands', () => {
  it.each([true, false])('requires owned command closure (released=%s)', async (released) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 71,
      exitCode: null as number | null,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: Object.assign(new EventEmitter(), {
        end: () =>
          queueMicrotask(() => {
            child.stdout.emit('data', Buffer.from('a'.repeat(64) + '\n'));
            child.exitCode = 0;
            child.emit('close', 0);
          }),
      }),
    });
    const spawnFake = vi.fn(() => child as unknown as ChildProcess);
    const transport = createDockerMigrationTransport({
      supervisor: {
        admit: async () => {},
        spawn: spawnFake,
        release: async () => {
          if (!released) throw new Error('job accounting unknown');
        },
      },
    });
    if (transport.command === undefined || transport.command === null)
      throw new Error('Preflight fixture transport must provide command');
    const operation = transport.command(['inspect', '--format', '{{.Id}}', 'abc'], {
      timeoutMs: 100,
      cleanupMs: 100,
    });
    if (released)
      await expect(operation).resolves.toMatchObject({ status: 0, stdout: 'a'.repeat(64) + '\n' });
    else await expect(operation).rejects.toThrow(/Unresolved migration preflight command/);
    expect(spawnFake).toHaveBeenCalledWith(['inspect', '--format', '{{.Id}}', 'abc'], {});
  });
});

it('keeps the default transport factory inert until explicit native admission', () => {
  const transport = createDockerMigrationTransport();
  expect(transport.execute).toBeTypeOf('function');
  expect(transport.command).toBeTypeOf('function');
  expect(transport.preflight).toBeTypeOf('function');
});

describe('slow CLI observation interval and identity oracle', () => {
  const target: MigrationTarget = {
    containerId: 'a'.repeat(64),
    clusterSystemIdentifier: '1234',
    databaseName: 'synthetic',
    databaseUser: 'practicehub',
    grant: 'unit-only',
  };
  function events(tag: string, wrapperPid: number): MigrationObservation[] {
    const backend: BackendIdentity = {
      pid: 41,
      backendStart: '2026-01-01+00',
      database: target.databaseName,
      user: target.databaseUser,
      tag,
      systemIdentifier: target.clusterSystemIdentifier,
    };
    const common = {
      containerId: target.containerId,
      clusterSystemIdentifier: target.clusterSystemIdentifier,
      databaseName: target.databaseName,
      databaseUser: target.databaseUser,
      tag,
      wrapperPid,
      backend,
    };
    return [
      { ...common, kind: 'migration-backend-identity' },
      {
        kind: 'native-job-release',
        wrapperPid,
        pid: 77,
        created: '133000000000000001',
        exitCode: 137,
        active: 0,
        job: 'a'.repeat(64),
        applicationTag: tag,
      },
      { ...common, kind: 'migration-backend-absent', phase: 'after-main-close' },
    ];
  }
  it('requires the slow main identity/job and subsequent exact backend absence', () => {
    const before = events('ph_migrate_before-query', 10);
    const slow = events('ph_migrate_slow', 11);
    expect(requireMainTimeoutEvidence([...before, ...slow], before.length, target).tag).toBe(
      'ph_migrate_slow',
    );
  });
  it.each([
    'migration-backend-identity',
    'native-job-release',
    'migration-backend-absent',
  ] as const)('keeps before-query events but rejects suppressed slow %s evidence', (kind) => {
    const before = events('ph_migrate_before-query', 10);
    const slow = events('ph_migrate_slow', 11).filter((event) => event.kind !== kind);
    expect(() => requireMainTimeoutEvidence([...before, ...slow], before.length, target)).toThrow();
  });
  it.each(['observer', 'different wrapper', 'reordered absence', 'different backend start'])(
    'rejects %s substitutions',
    (which) => {
      const slow = events('ph_migrate_slow', 11);
      if (which === 'observer') {
        const observerRelease = events('ph_observe_auxiliary', 11)[1];
        if (observerRelease === undefined || observerRelease === null)
          throw new Error('Missing observer release fixture');
        slow[1] = observerRelease;
      }
      if (which === 'different wrapper') {
        const differentRelease = events('ph_migrate_slow', 12)[1];
        if (differentRelease === undefined || differentRelease === null)
          throw new Error('Missing different-wrapper release fixture');
        slow[1] = differentRelease;
      }
      if (which === 'reordered absence') {
        const absence = slow[2];
        const release = slow[1];
        if (absence === undefined || absence === null || release === undefined || release === null)
          throw new Error('Missing reordered absence fixtures');
        [slow[1], slow[2]] = [absence, release];
      }
      if (which === 'different backend start') {
        const absent = slow[2];
        if (absent === undefined || absent === null)
          throw new Error('Missing backend absence fixture');
        if (absent.kind === 'migration-backend-absent' && absent.backend)
          slow[2] = { ...absent, backend: { ...absent.backend, backendStart: 'other' } };
      }
      expect(() => requireMainTimeoutEvidence(slow, 0, target)).toThrow();
    },
  );
});
