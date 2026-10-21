import type { ChildProcess } from 'node:child_process';
import {
  createWindowsMigrationSupervisor,
  type MigrationProcessSupervisor,
  type NativeJobObservation,
  type WindowsSupervisorBinding,
} from './migration-supervisor.js';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { localDockerSelection, type LocalDockerBinding } from './compose-config.js';

export const psqlArguments = [
  '--no-psqlrc',
  '--quiet',
  '--tuples-only',
  '--no-align',
  '--set=ON_ERROR_STOP=1',
  '--set=ON_ERROR_ROLLBACK=off',
  '--file',
  '-',
] as const;

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const literal = (value: string): string => "'" + value.replaceAll("'", "''") + "'";

/** A restricted lexer, not a general SQL parser. Opaque bodies are never rewritten. */
export function activePsqlSql(sql: string): string {
  let visible = '';
  for (let i = 0; i < sql.length;) {
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
      visible += ' ';
    } else if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) throw new Error('Unterminated SQL comment');
      visible += ' ';
    } else if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      const escape = quote === "'" && /(?:^|[^a-z0-9_])e$/i.test(sql.slice(0, i));
      i++;
      let closed = false;
      while (i < sql.length) {
        if (escape && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new Error('Unterminated SQL quote');
      visible += ' opaque ';
    } else if (sql[i] === '$' && /^\$(?:[a-z_][a-z0-9_]*)?\$/i.test(sql.slice(i))) {
      const tag = /^\$(?:[a-z_][a-z0-9_]*)?\$/i.exec(sql.slice(i))?.[0];
      if (!tag) throw new Error('Invalid dollar quote');
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) throw new Error('Unterminated SQL dollar quote');
      i = end + tag.length;
      visible += ' opaque ';
    } else {
      if (sql[i] === '\\' || (sql[i] === ':' && sql[i - 1] !== ':' && sql[i + 1] !== ':')) {
        throw new Error('psql commands/interpolation are unsupported');
      }
      visible += sql[i];
      i++;
    }
  }
  return visible;
}

export function validateSql(sql: string): void {
  for (const statement of activePsqlSql(sql)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)) {
    if (
      !/^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|DO|GRANT|REVOKE|COMMENT|SELECT|WITH)\b/i.test(
        statement,
      ) ||
      /\b(CONCURRENTLY|BEGIN\s+ATOMIC)\b/i.test(statement) ||
      /^(?:CREATE|ALTER|DROP)\s+(?:DATABASE|TABLESPACE|SUBSCRIPTION|SYSTEM)\b/i.test(statement)
    ) {
      throw new Error(`Unsupported transactional SQL: ${statement.slice(0, 100)}`);
    }
  }
}

export class Migration {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly #bytes: Buffer;
  constructor(path: string, bytes: Uint8Array) {
    if (!/^modules\/[a-z0-9-]+\/migrations\/[0-9]{4}-[a-z0-9-]+\.sql$/.test(path)) {
      throw new Error(`Unsupported migration path: ${path}`);
    }
    this.#bytes = Buffer.from(bytes);
    if (this.#bytes.length === 0) throw new Error('Empty migration');
    const sql = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.#bytes);
    if (sql.includes('\0') || sql.startsWith('\uFEFF'))
      throw new Error('NUL/BOM SQL is unsupported');
    validateSql(sql);
    this.path = path;
    this.sha256 = digest(this.#bytes);
    this.size = this.#bytes.length;
    Object.freeze(this);
  }
  get bytes(): Buffer {
    return Buffer.from(this.#bytes);
  }
}

export function orderedManifest(migrations: readonly Migration[]): readonly Migration[] {
  const sorted = [...migrations].sort(
    (a, b) => basename(a.path).localeCompare(basename(b.path)) || a.path.localeCompare(b.path),
  );
  if (new Set(sorted.map((file) => file.path)).size !== sorted.length)
    throw new Error('Duplicate migration path');
  return Object.freeze(sorted);
}

export function discoverMigrations(root: string): readonly Migration[] {
  const files: Migration[] = [];
  const modules = join(root, 'modules');
  const checked = (path: string): void => {
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== resolve(path))
      throw new Error(`Migration link/escape: ${path}`);
  };
  checked(modules);
  for (const module of readdirSync(modules, { withFileTypes: true })) {
    if (module.isSymbolicLink()) throw new Error(`Module link: ${module.name}`);
    if (!module.isDirectory()) continue;
    const dir = join(modules, module.name, 'migrations');
    if (!existsSync(dir)) continue;
    checked(dir);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.sql') || file.endsWith('.rollback.sql')) continue;
      const path = join(dir, file);
      checked(path);
      if (!lstatSync(path).isFile()) throw new Error(`Not a migration file: ${path}`);
      files.push(new Migration(relative(root, path).split(sep).join('/'), readFileSync(path)));
    }
  }
  // NR-075: infra/postgres/migrations remains outside this discovery contract.
  return orderedManifest(files);
}

export function verifyMigrationSources(root: string, migrations: readonly Migration[]): void {
  const current = discoverMigrations(root);
  if (
    JSON.stringify(current.map((m) => [m.path, m.sha256, m.size])) !==
    JSON.stringify(migrations.map((m) => [m.path, m.sha256, m.size]))
  ) {
    throw new Error(
      'Migration sources changed during execution; the committed journal contains the cached bytes. Reconcile before retry.',
    );
  }
}

const bootstrapCheck = `
CREATE TEMP TABLE bootstrap_expected (
 tenant_id text PRIMARY KEY, display_name text NOT NULL,
 synthetic boolean NOT NULL CHECK (synthetic),
 bootstrap_capability_state text NOT NULL CHECK (bootstrap_capability_state IN ('disabled','simulated'))
);
DO $bootstrap$
DECLARE actual oid := to_regclass('platform_core.synthetic_tenant'); expected oid := 'pg_temp.bootstrap_expected'::regclass;
BEGIN
 IF actual IS NULL OR
 EXISTS (SELECT FROM pg_namespace WHERE nspname NOT IN ('public','platform_core','local_migrations','information_schema') AND nspname !~ '^pg_') OR
 EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','platform_core') AND c.oid <> actual AND c.oid <> (SELECT indexrelid FROM pg_index WHERE indrelid=actual AND indisprimary)) OR
 EXISTS (SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','platform_core')) OR
 EXISTS (SELECT FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname IN ('public','platform_core') AND t.oid NOT IN (SELECT reltype FROM pg_class WHERE oid=actual) AND t.typelem NOT IN (SELECT reltype FROM pg_class WHERE oid=actual)) OR
 EXISTS (SELECT FROM pg_trigger WHERE tgrelid=actual AND NOT tgisinternal) OR
 EXISTS (SELECT FROM pg_policy WHERE polrelid=actual) OR
 EXISTS (SELECT FROM pg_event_trigger) OR
 EXISTS (SELECT FROM pg_extension WHERE extname<>'plpgsql') OR
 EXISTS (SELECT FROM pg_namespace n,LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='platform_core' AND a.grantee<>n.nspowner) OR
 EXISTS (SELECT FROM pg_namespace WHERE nspname='platform_core' AND nspowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)) OR
 EXISTS (SELECT FROM pg_rewrite WHERE ev_class=actual) OR
 EXISTS (SELECT FROM pg_class c,LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=actual AND a.grantee<>c.relowner) OR
 EXISTS (SELECT FROM pg_attribute a,LATERAL aclexplode(a.attacl) acl WHERE a.attrelid=actual AND acl.grantee<>(SELECT oid FROM pg_roles WHERE rolname=current_user)) OR
 EXISTS (SELECT FROM pg_class WHERE oid=actual AND (relkind<>'r' OR relpersistence<>'p' OR relrowsecurity OR relforcerowsecurity OR relowner <> (SELECT oid FROM pg_roles WHERE rolname=current_user))) THEN
  RAISE EXCEPTION 'legacy-unjournaled: expected strict synthetic bootstrap only';
 END IF;
 IF (SELECT jsonb_agg(jsonb_build_array(attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated,atthasdef,attcollation) ORDER BY attnum) FROM pg_attribute WHERE attrelid=actual AND attnum>0) IS DISTINCT FROM
    (SELECT jsonb_agg(jsonb_build_array(attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated,atthasdef,attcollation) ORDER BY attnum) FROM pg_attribute WHERE attrelid=expected AND attnum>0) OR
    (SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid=actual) IS DISTINCT FROM
    (SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid=expected) THEN
  RAISE EXCEPTION 'legacy-unjournaled: bootstrap catalog differs';
 END IF;
 IF (SELECT jsonb_agg(to_jsonb(t) ORDER BY tenant_id) FROM platform_core.synthetic_tenant t) IS DISTINCT FROM
 '[{"tenant_id":"northwind-synthetic","display_name":"Northwind Health & Care Synthetic","synthetic":true,"bootstrap_capability_state":"simulated"},{"tenant_id":"riverbend-synthetic","display_name":"Riverbend Synthetic","synthetic":true,"bootstrap_capability_state":"disabled"}]'::jsonb THEN
  RAISE EXCEPTION 'legacy-unjournaled: bootstrap synthetic rows differ';
 END IF;
END $bootstrap$;
DROP TABLE pg_temp.bootstrap_expected;
`;

const createJournal = `
CREATE SCHEMA local_migrations;
REVOKE ALL ON SCHEMA local_migrations FROM PUBLIC;
CREATE TABLE local_migrations.descriptor (
 singleton boolean PRIMARY KEY CHECK(singleton), version integer NOT NULL CHECK(version=1),
 journal_id uuid NOT NULL, bootstrap text NOT NULL CHECK(bootstrap='synthetic-bootstrap-v1'),
 synthetic boolean NOT NULL CHECK(synthetic)
);
CREATE TABLE local_migrations.applied (
 position integer PRIMARY KEY CHECK(position>0), path text UNIQUE NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), bytes integer NOT NULL CHECK(bytes>0),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
 version integer NOT NULL CHECK(version=1), synthetic boolean NOT NULL CHECK(synthetic),
 applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON ALL TABLES IN SCHEMA local_migrations FROM PUBLIC;
ALTER TABLE local_migrations.descriptor ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_migrations.descriptor FORCE ROW LEVEL SECURITY;
ALTER TABLE local_migrations.applied ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_migrations.applied FORCE ROW LEVEL SECURITY;
`;

const journalCheck = `
CREATE TEMP TABLE expected_descriptor (
 singleton boolean PRIMARY KEY CHECK(singleton), version integer NOT NULL CHECK(version=1),
 journal_id uuid NOT NULL, bootstrap text NOT NULL CHECK(bootstrap='synthetic-bootstrap-v1'),
 synthetic boolean NOT NULL CHECK(synthetic)
);
CREATE TEMP TABLE expected_applied (
 position integer PRIMARY KEY CHECK(position>0), path text UNIQUE NOT NULL,
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'), bytes integer NOT NULL CHECK(bytes>0),
 manifest_sha256 text NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
 version integer NOT NULL CHECK(version=1), synthetic boolean NOT NULL CHECK(synthetic),
 applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DO $journal$
DECLARE relation text; actual oid; expected oid;
BEGIN
 FOR relation IN SELECT unnest(ARRAY['descriptor','applied']) LOOP
  actual := to_regclass('local_migrations.' || relation);
  expected := to_regclass('pg_temp.expected_' || relation);
  IF actual IS NULL OR
   (SELECT jsonb_agg(jsonb_build_array(attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated,attisdropped,attcollation,pg_get_expr(d.adbin,d.adrelid)) ORDER BY attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE attrelid=actual AND attnum>0) IS DISTINCT FROM
   (SELECT jsonb_agg(jsonb_build_array(attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated,attisdropped,attcollation,pg_get_expr(d.adbin,d.adrelid)) ORDER BY attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE attrelid=expected AND attnum>0) OR
   (SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid=actual) IS DISTINCT FROM
   (SELECT array_agg(pg_get_constraintdef(oid) ORDER BY pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid=expected) OR
   EXISTS(SELECT FROM pg_attribute a,LATERAL aclexplode(a.attacl) acl WHERE attrelid=actual AND acl.grantee<>(SELECT oid FROM pg_roles WHERE rolname=current_user)) OR
   EXISTS(SELECT FROM pg_trigger WHERE tgrelid=actual AND NOT tgisinternal) OR
   EXISTS(SELECT FROM pg_inherits WHERE inhrelid=actual OR inhparent=actual) OR
   EXISTS(SELECT FROM pg_index WHERE indrelid=actual AND (NOT indisvalid OR NOT indisready OR NOT indislive)) OR
   EXISTS(SELECT FROM pg_class WHERE oid=actual AND relpersistence<>'p') OR
   EXISTS(SELECT FROM pg_rewrite WHERE ev_class=actual) THEN
   RAISE EXCEPTION 'Invalid journal metadata shape: %', relation;
  END IF;
 END LOOP;
 IF EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='local_migrations' AND (c.relkind NOT IN ('r','i') OR (c.relkind='r' AND c.relname NOT IN ('descriptor','applied')))) OR
 (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='local_migrations' AND c.relkind='i')<>3 OR
 EXISTS(SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='local_migrations') OR
 (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='local_migrations')<>4 THEN RAISE EXCEPTION 'Invalid journal object set'; END IF;
 IF (SELECT count(*) FROM local_migrations.descriptor) <> 1 OR
 NOT EXISTS (SELECT FROM local_migrations.descriptor WHERE singleton AND version=1 AND bootstrap='synthetic-bootstrap-v1' AND synthetic) OR
 (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='local_migrations' AND c.relkind='r' AND c.relname IN ('descriptor','applied') AND c.relrowsecurity AND c.relforcerowsecurity AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))<>2 OR
 EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace, LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a WHERE n.nspname='local_migrations' AND a.grantee<>c.relowner) OR
 EXISTS (SELECT FROM pg_namespace WHERE nspname='local_migrations' AND nspowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user)) OR
 EXISTS (SELECT FROM pg_namespace n,LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='local_migrations' AND a.grantee<>n.nspowner) OR
 EXISTS (SELECT FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='local_migrations') THEN
  RAISE EXCEPTION 'Invalid journal metadata/protection';
 END IF;
 IF EXISTS (SELECT FROM local_migrations.applied a FULL JOIN pg_temp.manifest m USING(position) WHERE a.position IS NOT NULL AND (m.position IS NULL OR a.path<>m.path OR a.sha256<>m.sha256 OR a.bytes<>m.bytes OR a.version<>1 OR NOT a.synthetic)) OR
 (SELECT count(*) FROM local_migrations.applied) <> coalesce((SELECT max(position) FROM local_migrations.applied),0) THEN
  RAISE EXCEPTION 'Migration journal is not the exact source prefix';
 END IF;
END $journal$;
DROP TABLE pg_temp.expected_descriptor,pg_temp.expected_applied;
`;

export interface MigrationReport {
  readonly applied: number;
  readonly skipped: number;
  readonly total: number;
  readonly manifestSha256: string;
}
export interface ExecutionResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** DB tests require a separately granted, pinned disposable target; no shared default. */
export interface TestTarget {
  readonly version: 2;
  readonly containerId: string;
  readonly clusterSystemIdentifier: string;
  readonly freshContainerId: string;
  readonly freshClusterSystemIdentifier: string;
  readonly databasePrefix: string;
  readonly headRoot: string;
  readonly headManifestSha256: string;
  readonly grant: string;
}
export function validateTestTarget(value: unknown): TestTarget {
  if (typeof value !== 'object' || value === null)
    throw new Error('Explicit synthetic target binding required');
  const v = value as Record<string, unknown>;
  if (
    v['version'] !== 2 ||
    v['syntheticOnly'] !== true ||
    v['allowCreateDatabases'] !== true ||
    typeof v['containerId'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v['containerId']) ||
    typeof v['freshContainerId'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v['freshContainerId']) ||
    v['freshContainerId'] === v['containerId'] ||
    typeof v['clusterSystemIdentifier'] !== 'string' ||
    !/^[1-9][0-9]*$/.test(v['clusterSystemIdentifier']) ||
    typeof v['freshClusterSystemIdentifier'] !== 'string' ||
    !/^[1-9][0-9]*$/.test(v['freshClusterSystemIdentifier']) ||
    v['freshClusterSystemIdentifier'] === v['clusterSystemIdentifier'] ||
    typeof v['databasePrefix'] !== 'string' ||
    !/^ph_migration_synthetic_[a-z0-9_]{1,16}$/.test(v['databasePrefix']) ||
    typeof v['headRoot'] !== 'string' ||
    resolve(v['headRoot']) !== v['headRoot'] ||
    typeof v['headManifestSha256'] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v['headManifestSha256']) ||
    typeof v['grant'] !== 'string' ||
    v['grant'].length === 0
  )
    throw new Error('Unsafe/incomplete synthetic target binding');
  return Object.freeze({
    version: 2,
    containerId: v['containerId'],
    clusterSystemIdentifier: v['clusterSystemIdentifier'],
    freshContainerId: v['freshContainerId'],
    freshClusterSystemIdentifier: v['freshClusterSystemIdentifier'],
    databasePrefix: v['databasePrefix'],
    headRoot: v['headRoot'],
    headManifestSha256: v['headManifestSha256'],
    grant: v['grant'],
  });
}

export interface BoundCluster {
  readonly containerId: string;
  readonly clusterSystemIdentifier: string;
}
export interface BoundDatabase extends BoundCluster {
  readonly databaseName: string;
}
export function bindTestDatabase(cluster: BoundCluster, databaseName: string): BoundDatabase {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName))
    throw new Error('Unsafe synthetic database name');
  return Object.freeze({ ...cluster, databaseName });
}

/** Shared by sync execution and every async client/identity/release operation. */
export function testDatabaseArguments(db: BoundDatabase, tag?: string): string[] {
  return [
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
  ];
}

/** No database-creation capability is returned until BOTH physical observations pass. */
export function admitTestClusters(
  target: TestTarget,
  observe: (admin: BoundDatabase) => {
    readonly containerId: string;
    readonly clusterSystemIdentifier: string;
    readonly moduleLabsAbsent: boolean;
  },
) {
  const primary: BoundCluster = Object.freeze({
    containerId: target.containerId,
    clusterSystemIdentifier: target.clusterSystemIdentifier,
  });
  const fresh: BoundCluster = Object.freeze({
    containerId: target.freshContainerId,
    clusterSystemIdentifier: target.freshClusterSystemIdentifier,
  });
  for (const cluster of [primary, fresh]) {
    const actual = observe(bindTestDatabase(cluster, 'postgres'));
    if (
      actual.containerId !== cluster.containerId ||
      actual.clusterSystemIdentifier !== cluster.clusterSystemIdentifier ||
      actual.moduleLabsAbsent !== true
    )
      throw new Error('Synthetic cluster identity/role admission refused');
  }
  return Object.freeze({
    primary,
    fresh,
    database(suffix: string, cluster: BoundCluster = primary): BoundDatabase {
      if (cluster !== primary && cluster !== fresh)
        throw new Error('Database cluster was not admitted');
      return bindTestDatabase(cluster, `${target.databasePrefix}_${suffix}`);
    },
  });
}

export function buildMigrationScript(input: readonly Migration[]): {
  script: Buffer;
  manifestSha256: string;
  marker: string;
} {
  const migrations = orderedManifest(input);
  const manifestSha256 = digest(
    Buffer.from(JSON.stringify(migrations.map((m) => [m.path, m.sha256, m.size]))),
  );
  const marker = `PH_MIGRATIONS_${randomUUID()}`;
  const chunks: Buffer[] = [];
  const add = (sql: string): void => {
    chunks.push(Buffer.from(sql));
  };
  add(`SET client_encoding='UTF8'; SET standard_conforming_strings=on; SET search_path=pg_catalog,public;
DO $admin$ BEGIN IF current_user<>'practicehub' OR session_user<>current_user OR NOT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN RAISE EXCEPTION 'Synthetic migration admin required'; END IF;
IF NOT pg_try_advisory_lock(724106,1) THEN RAISE EXCEPTION 'Migration runner busy'; END IF; END $admin$;
CREATE TEMP TABLE manifest(position integer PRIMARY KEY,path text UNIQUE NOT NULL,sha256 text NOT NULL,bytes integer NOT NULL);
`);
  for (const [index, m] of migrations.entries())
    add(
      `INSERT INTO pg_temp.manifest VALUES (${index + 1},${literal(m.path)},${literal(m.sha256)},${m.size});\n`,
    );
  add(`BEGIN;
SELECT to_regnamespace('local_migrations') IS NOT NULL AS journal_exists \\gset
\\if :journal_exists
${journalCheck}
SELECT NOT EXISTS(SELECT FROM local_migrations.applied) AS needs_bootstrap \\gset
\\else
\\set needs_bootstrap true
\\endif
\\if :needs_bootstrap
${bootstrapCheck}
\\endif
\\if :journal_exists
\\else
${createJournal}
INSERT INTO local_migrations.descriptor VALUES(true,1,${literal(randomUUID())},'synthetic-bootstrap-v1',true);
\\endif
${journalCheck}
COMMIT;
SELECT count(*) AS initial_count FROM local_migrations.applied \\gset
`);
  for (const [index, m] of migrations.entries()) {
    add(`SELECT EXISTS(SELECT FROM local_migrations.applied WHERE position=${index + 1}) AS already_applied \\gset
\\if :already_applied
\\else
\\echo ${marker}:attempt:${m.path}
BEGIN;
`);
    chunks.push(m.bytes);
    add(`\n;\nINSERT INTO local_migrations.applied(position,path,sha256,bytes,manifest_sha256,version,synthetic) VALUES(${index + 1},${literal(m.path)},${literal(m.sha256)},${m.size},${literal(manifestSha256)},1,true);
COMMIT;
\\echo ${marker}:committed:${m.path}
\\endif
`);
  }
  add(`${journalCheck}
SELECT '${marker}|' || count(*) || '|' || :initial_count || '|${manifestSha256}' FROM local_migrations.applied;
SELECT pg_advisory_unlock(724106,1);
`);
  return { script: Buffer.concat(chunks), manifestSha256, marker };
}

export function runMigrations(
  migrations: readonly Migration[],
  execute: (sql: Buffer) => ExecutionResult,
): MigrationReport {
  const { script, manifestSha256, marker } = buildMigrationScript(migrations);
  const result = execute(script);
  return readMigrationReport(migrations.length, manifestSha256, marker, result);
}

export async function runMigrationsAsync(
  migrations: readonly Migration[],
  execute: (sql: Buffer) => Promise<ExecutionResult>,
): Promise<MigrationReport> {
  const { script, manifestSha256, marker } = buildMigrationScript(migrations);
  return readMigrationReport(migrations.length, manifestSha256, marker, await execute(script));
}

function readMigrationReport(
  expectedTotal: number,
  manifestSha256: string,
  marker: string,
  result: ExecutionResult,
): MigrationReport {
  if (result.status !== 0) {
    const progress = result.stdout.split(/\r?\n/).filter((line) => line.startsWith(`${marker}:`));
    throw new Error(
      `Migration attempt failed (status ${String(result.status)}, last phase ${progress.at(-1) ?? 'preflight'}); committed prefix must be read back on retry. ${result.stderr}`,
    );
  }
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.startsWith(`${marker}|`));
  const parts = lines[0]?.split('|');
  if (
    lines.length !== 1 ||
    parts?.length !== 4 ||
    parts[3] !== manifestSha256 ||
    !/^\d+$/.test(parts[1] ?? '') ||
    !/^\d+$/.test(parts[2] ?? '')
  )
    throw new Error('Missing/invalid journal readback');
  const total = Number(parts[1]);
  const skipped = Number(parts[2]);
  if (total !== expectedTotal || skipped > total) throw new Error('Incomplete journal readback');
  return { applied: total - skipped, skipped, total, manifestSha256 };
}

/** Every wait has its own deadline; a runner timeout is never release evidence. */
export async function bounded<T>(
  work: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Observe immediately after spawn, before stdin writes or any possible error event. */
export function observeMigrationClient(child: ChildProcess) {
  const ownedPid = child.pid;
  let didClose = false;
  let failure: Error | undefined;
  const closed = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code) => {
      didClose = true;
      resolve(code);
    });
  });
  async function wait(milliseconds: number): Promise<number | null> {
    const code = await bounded(closed, milliseconds, `client ${String(ownedPid)} close`);
    if (failure) throw failure;
    return code;
  }
  return {
    ownedPid,
    wait,
    async release(
      backend: { released: () => Promise<boolean>; terminate: () => Promise<void> },
      milliseconds: number,
    ): Promise<void> {
      const errors: unknown[] = [];
      try {
        if (!(await bounded(backend.released(), milliseconds, 'backend release check'))) {
          await bounded(backend.terminate(), milliseconds, 'owned backend termination');
        }
      } catch (error) {
        errors.push(error);
      }
      // A PID captured from this child object is the only client we may terminate.
      if (!didClose && ownedPid !== undefined && child.pid === ownedPid) {
        try {
          if (!child.kill()) throw new Error(`client ${ownedPid} termination refused`);
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await wait(milliseconds);
      } catch (error) {
        errors.push(error);
      }
      try {
        await bounded(
          (async () => {
            const end = Date.now() + milliseconds;
            while (
              !(await bounded(
                backend.released(),
                Math.max(1, end - Date.now()),
                'backend release query',
              ))
            ) {
              if (Date.now() >= end) throw new Error('backend/lock still present');
              await new Promise((resolve) =>
                setTimeout(resolve, Math.min(25, Math.max(1, end - Date.now()))),
              );
            }
          })(),
          milliseconds,
          'backend/lock release',
        );
      } catch (error) {
        errors.push(error);
      }
      if (errors.length)
        throw new AggregateError(errors, 'Unresolved migration client/backend release');
    },
  };
}
/** Authority is supplied by the caller, never inferred from a running container. */
export interface MigrationTarget extends BoundDatabase {
  readonly databaseUser: 'practicehub';
  readonly grant: string;
}
export interface MigrationExecutionOptions {
  readonly timeoutMs: number;
  readonly cleanupMs: number;
}
export interface MigrationTransport {
  bindDocker?(binding: LocalDockerBinding): void;
  command?(args: readonly string[], options: MigrationExecutionOptions): Promise<ExecutionResult>;
  preflight?(target: MigrationTarget): Promise<void>;
  execute(
    target: MigrationTarget,
    sql: Buffer,
    options: MigrationExecutionOptions,
  ): Promise<ExecutionResult>;
}
export function validateMigrationTarget(target: MigrationTarget | undefined): MigrationTarget {
  if (
    !target ||
    !/^[a-f0-9]{64}$/.test(target.containerId) ||
    !/^[1-9][0-9]*$/.test(target.clusterSystemIdentifier) ||
    !/^[a-z][a-z0-9_]{0,62}$/.test(target.databaseName) ||
    target.databaseUser !== 'practicehub' ||
    !target.grant.trim()
  )
    throw new Error('Explicit migration target and grant required');
  return Object.freeze({ ...target });
}

export interface BackendIdentity {
  readonly pid: number;
  readonly backendStart: string;
  readonly database: string;
  readonly user: string;
  readonly tag: string;
  readonly systemIdentifier: string;
}

/** Production ownership and native release proof are one capability. */
export type MigrationObservation =
  | NativeJobObservation
  | {
      readonly kind:
        'migration-backend-identity' | 'migration-backend-absent' | 'migration-observer-start';
      readonly containerId: string;
      readonly clusterSystemIdentifier: string;
      readonly databaseName: string;
      readonly databaseUser: string;
      readonly tag: string;
      readonly backend?: BackendIdentity;
      readonly wrapperPid: number | undefined;
      readonly phase?: 'after-main-close';
    };
export interface DockerMigrationDependencies {
  readonly onObservation?: (event: MigrationObservation) => void;
  readonly nativePaths?: WindowsSupervisorBinding;
  readonly supervisor?: MigrationProcessSupervisor;
}

/** Evidence oracle only; never grants process or backend ownership. */
export function requireMainTimeoutEvidence(
  events: readonly MigrationObservation[],
  start: number,
  target: MigrationTarget,
): BackendIdentity {
  const interval = events.slice(start);
  const identities = interval.filter(
    (event) => event.kind === 'migration-backend-identity' && event.tag.startsWith('ph_migrate_'),
  );
  if (identities.length !== 1)
    throw new Error('Expected one slow main backend identity in invocation interval');
  const identity = identities[0];
  if (identity === null || identity === undefined)
    throw new Error('Expected one slow main backend identity in invocation interval');
  if (identity.kind !== 'migration-backend-identity' || !identity.backend)
    throw new Error('Missing main backend');
  const backend = identity.backend;
  if (
    !Number.isSafeInteger(identity.wrapperPid) ||
    !Number.isSafeInteger(backend.pid) ||
    backend.pid <= 0 ||
    !backend.backendStart ||
    identity.containerId !== target.containerId ||
    identity.clusterSystemIdentifier !== target.clusterSystemIdentifier ||
    identity.databaseName !== target.databaseName ||
    identity.databaseUser !== target.databaseUser ||
    backend.database !== target.databaseName ||
    backend.user !== target.databaseUser ||
    backend.systemIdentifier !== target.clusterSystemIdentifier ||
    backend.tag !== identity.tag
  )
    throw new Error('Slow main target/backend identity mismatch');
  const identityIndex = interval.indexOf(identity);
  const releaseIndex = interval.findIndex(
    (event, index) =>
      index > identityIndex &&
      event.kind === 'native-job-release' &&
      event.applicationTag === identity.tag &&
      event.wrapperPid === identity.wrapperPid &&
      event.active === 0 &&
      Number.isSafeInteger(event.pid) &&
      event.pid > 0 &&
      /^[1-9][0-9]*$/.test(event.created) &&
      /^[a-f0-9]{64}$/.test(event.job),
  );
  if (releaseIndex < 0) throw new Error('Slow main owned job release missing');
  const absent = interval.find(
    (event, index) =>
      index > releaseIndex &&
      event.kind === 'migration-backend-absent' &&
      event.phase === 'after-main-close' &&
      event.tag === identity.tag &&
      event.wrapperPid === identity.wrapperPid &&
      event.containerId === identity.containerId &&
      event.clusterSystemIdentifier === identity.clusterSystemIdentifier &&
      event.databaseName === identity.databaseName &&
      event.databaseUser === identity.databaseUser &&
      event.backend &&
      event.backend.pid === backend.pid &&
      event.backend.backendStart === backend.backendStart &&
      event.backend.tag === backend.tag &&
      event.backend.database === backend.database &&
      event.backend.user === backend.user &&
      event.backend.systemIdentifier === backend.systemIdentifier,
  );
  if (!absent) throw new Error('Slow main terminal after-exit backend absence missing');
  return backend;
}

export function createDockerMigrationTransport(
  dependencies: DockerMigrationDependencies = {},
): MigrationTransport {
  const supervisor =
    dependencies.supervisor ??
    createWindowsMigrationSupervisor({
      ...dependencies.nativePaths,
      ...(dependencies.onObservation ? { onObservation: dependencies.onObservation } : {}),
    });
  let docker: LocalDockerBinding | undefined;
  let dockerPin: string | undefined;
  function spawnOwned(args: readonly string[], applicationTag?: string): ChildProcess {
    if (!docker && !dependencies.supervisor)
      throw new Error('Approved local Docker selection required');
    if (docker) localDockerSelection(docker);
    return supervisor.spawn(args, {
      ...(docker ? { docker } : {}),
      ...(applicationTag ? { applicationTag } : {}),
    });
  }
  async function preflight(target: MigrationTarget): Promise<void> {
    validateMigrationTarget(target);
    await bounded(supervisor.admit(), 10000, 'local supervisor admission');
  }
  return {
    bindDocker(binding) {
      localDockerSelection(binding);
      const pin = JSON.stringify(binding);
      if (dockerPin !== undefined && dockerPin !== pin)
        throw new Error('Docker selection changed after transport admission');
      docker = Object.freeze({
        endpoint: binding.endpoint,
        configFile: Object.freeze({ ...binding.configFile }),
        composePlugin: Object.freeze({ ...binding.composePlugin }),
      });
      dockerPin = pin;
    },
    preflight,
    async command(args, options) {
      if (![options.timeoutMs, options.cleanupMs].every((n) => Number.isSafeInteger(n) && n > 0))
        throw new Error('Positive bounded migration deadlines required');
      await bounded(supervisor.admit(), options.cleanupMs, 'local supervisor admission');
      const child = spawnOwned(args);
      const lifecycle = observeMigrationClient(child);
      let stdout = '';
      let stderr = '';
      let streamFailure: Error | undefined;
      child.stdout?.on('data', (chunk: Buffer) => {
        if (Buffer.byteLength(stdout) + chunk.length > 16 * 1024 * 1024)
          streamFailure = new Error('Command output bound exceeded');
        else stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-65536);
      });
      child.stdin?.on('error', (error) => {
        streamFailure = error;
      });
      let status: number | null = null;
      const failures: unknown[] = [];
      try {
        child.stdin?.end();
        status = await lifecycle.wait(options.timeoutMs);
        if (streamFailure) throw streamFailure;
      } catch (error) {
        failures.push(error);
      }
      try {
        await bounded(
          supervisor.release(child, options.cleanupMs),
          options.cleanupMs * 3,
          'preflight command local tree release',
        );
        await lifecycle.wait(options.cleanupMs);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length)
        throw new AggregateError(failures, 'Unresolved migration preflight command');
      return { status, stdout, stderr };
    },
    async execute(inputTarget, sql, options) {
      const target = validateMigrationTarget(inputTarget);
      if (![options.timeoutMs, options.cleanupMs].every((n) => Number.isSafeInteger(n) && n > 0))
        throw new Error('Positive bounded migration deadlines required');
      // Refuse before mutation when no process-tree supervision was configured.
      await preflight(target);
      const tag = `ph_migrate_${randomUUID()}`;
      const handshake = `PH_BACKEND_${randomUUID()}`;
      const observe = (
        kind:
          'migration-backend-identity' | 'migration-backend-absent' | 'migration-observer-start',
        applicationTag: string,
        backend?: BackendIdentity,
      ): void => {
        dependencies.onObservation?.(
          Object.freeze({
            kind,
            containerId: target.containerId,
            clusterSystemIdentifier: target.clusterSystemIdentifier,
            databaseName: target.databaseName,
            databaseUser: target.databaseUser,
            tag: applicationTag,
            ...(backend ? { backend } : {}),
            wrapperPid: client.child.pid,
            ...(kind === 'migration-backend-absent' ? { phase: 'after-main-close' as const } : {}),
          }),
        );
      };
      const children: ChildProcess[] = [];
      const guard = `DO $target$ BEGIN IF current_database()<>${literal(target.databaseName)} OR current_user<>${literal(target.databaseUser)} OR (SELECT system_identifier::text FROM pg_control_system())<>${literal(target.clusterSystemIdentifier)} THEN RAISE EXCEPTION 'Migration target identity mismatch'; END IF; END $target$;\n`;
      const identitySql = `SELECT ${literal(handshake)} || row_to_json(i)::text FROM (SELECT pid,backend_start::text AS "backendStart",datname AS database,usename AS "user",application_name AS tag,(SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier" FROM pg_stat_activity WHERE pid=pg_backend_pid()) i;\n`;
      function open(applicationName: string) {
        const child = spawnOwned(testDatabaseArguments(target, applicationName), applicationName);
        children.push(child);
        const lifecycle = observeMigrationClient(child);
        let stdout = '';
        let stderr = '';
        let streamFailure: Error | undefined;
        const listeners = new Set<() => void>();
        child.stdout?.on('data', (chunk: Buffer) => {
          if (Buffer.byteLength(stdout) + chunk.length > 16 * 1024 * 1024) {
            streamFailure = new Error('Migration output bound exceeded');
            return;
          }
          stdout += chunk.toString();
          for (const listener of listeners) listener();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-65536);
        });
        child.stdin?.on('error', (error) => {
          streamFailure = error;
        });
        return {
          child,
          lifecycle,
          listeners,
          output: () => stdout,
          async result(milliseconds: number): Promise<ExecutionResult> {
            const status = await lifecycle.wait(milliseconds);
            if (streamFailure) throw streamFailure;
            return { status, stdout, stderr };
          },
        };
      }
      // Auxiliary commands are read-only except the exact guarded termination.
      // Server limits bound sessions even if an observer's local transport fails;
      // such failure is still UNKNOWN and blocks this invocation. Successful
      // observer close is not independent remote observer-release evidence:
      // operational acceptance also requires external final pg_stat_activity
      // readback after this process exits (all ph_observe_* session tags).
      async function query(statement: string): Promise<string> {
        const observerTag = `ph_observe_${randomUUID()}`;
        const observer = open(observerTag);
        let value: string | undefined;
        const errors: unknown[] = [];
        try {
          observe('migration-observer-start', observerTag);
          observer.child.stdin?.end(
            `SET statement_timeout=${options.cleanupMs}; SET idle_session_timeout=${options.cleanupMs};\n${guard}${statement}\n`,
          );
          const result = await observer.result(options.cleanupMs);
          if (result.status !== 0)
            throw new Error(`Migration observation failed: ${result.stderr}`);
          value = result.stdout.trim();
        } catch (error) {
          errors.push(error);
        }
        try {
          await bounded(
            supervisor.release(observer.child, options.cleanupMs),
            options.cleanupMs * 3,
            'observer local tree release',
          );
          await observer.lifecycle.wait(options.cleanupMs);
        } catch (error) {
          errors.push(error);
        }
        if (errors.length)
          throw new AggregateError(errors, 'Unresolved observer execution/release');
        if (value === null || value === undefined)
          throw new Error('Missing migration observation output');
        return value;
      }

      let identity: BackendIdentity | undefined;
      let failure: unknown;
      let result: ExecutionResult | undefined;
      const client = open(tag);
      try {
        const identified = new Promise<BackendIdentity>((resolve, reject) => {
          const inspect = () => {
            const lines = client
              .output()
              .split(/\r?\n/)
              .filter((line) => line.startsWith(handshake));
            if (lines.length === 0 || !client.output().endsWith('\n')) return;
            try {
              if (lines.length !== 1) throw new Error('Duplicate backend identity');
              const line = lines[0];
              if (line === null || line === undefined) throw new Error('Missing backend identity');
              const value = JSON.parse(line.slice(handshake.length)) as BackendIdentity;
              if (
                !Number.isSafeInteger(value.pid) ||
                value.pid <= 0 ||
                typeof value.backendStart !== 'string' ||
                value.backendStart.length === 0 ||
                value.database !== target.databaseName ||
                value.user !== target.databaseUser ||
                value.tag !== tag ||
                value.systemIdentifier !== target.clusterSystemIdentifier
              )
                throw new Error('Backend identity mismatch');
              resolve(Object.freeze(value));
            } catch (error) {
              reject(error);
            }
          };
          client.listeners.add(inspect);
          client.child.once('close', () =>
            reject(new Error('Client closed before backend identity')),
          );
        });
        // No journal/migration bytes are sent until physical identity is read back.
        client.child.stdin?.write(
          `SET statement_timeout=${options.timeoutMs}; SET idle_session_timeout=${options.timeoutMs};\n${guard}${identitySql}`,
        );
        identity = await bounded(identified, options.timeoutMs, 'backend identity');
        observe('migration-backend-identity', tag, identity);
        client.child.stdin?.end(sql);
        const completed = await client.result(options.timeoutMs);
        result = {
          ...completed,
          stdout: completed.stdout
            .split(/\r?\n/)
            .filter((line) => !line.startsWith(handshake))
            .join('\n'),
        };
      } catch (error) {
        failure = error;
      }
      const cleanupErrors: unknown[] = [];
      let finalBackendCheck: (() => Promise<void>) | undefined;
      try {
        // If the handshake failed, never invent a PID or adopt a tag-only match.
        // We can prove absence, but cannot terminate an unidentified session.
        const predicate = identity
          ? `pid=${identity.pid} AND backend_start=${literal(identity.backendStart)}::timestamptz`
          : 'false';
        const exact = identity
          ? `${predicate} AND datname=${literal(identity.database)} AND usename=${literal(identity.user)} AND application_name=${literal(identity.tag)}`
          : 'false';
        const state = async () => {
          const raw = await query(
            `SELECT json_build_object('tagged',(SELECT count(*) FROM pg_stat_activity WHERE application_name=${literal(tag)}),'original',(SELECT count(*) FROM pg_stat_activity WHERE ${predicate}),'exact',(SELECT count(*) FROM pg_stat_activity WHERE ${exact}),'locks',(SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND (${identity ? `a.pid=${identity.pid} AND a.backend_start=${literal(identity.backendStart)}::timestamptz` : 'false'})));`,
          );
          const value = JSON.parse(raw) as {
            tagged: number;
            original: number;
            exact: number;
            locks: number;
          };
          if (
            !Object.values(value).every((v) => Number.isSafeInteger(v) && v >= 0) ||
            !['tagged', 'original', 'exact', 'locks'].every((k) => Object.hasOwn(value, k))
          )
            throw new Error('Invalid release observation');
          return value;
        };
        finalBackendCheck = async () => {
          const after = await state();
          if (after.tagged !== 0 || after.original !== 0 || after.locks !== 0)
            throw new Error('Backend/advisory release UNKNOWN after local tree closure');
        };
        const before = await state();
        if (before.tagged !== 0 || before.original !== 0 || before.locks !== 0) {
          if (!identity || before.exact !== 1 || before.original !== 1 || before.tagged !== 1)
            throw new Error('Backend identity unknown/mismatched; termination refused');
          const terminated = await query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE ${exact};`,
          );
          if (terminated !== 't') throw new Error('Exact backend termination refused');
        }
        const deadline = Date.now() + options.cleanupMs;
        for (;;) {
          const after = await state();
          if (after.tagged === 0 && after.original === 0 && after.locks === 0) break;
          if (Date.now() >= deadline) throw new Error('Backend/advisory release unproved');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      // A failed release must not skip any later owned child. The main occurs once.
      for (const child of children) {
        try {
          await bounded(
            supervisor.release(child, options.cleanupMs),
            options.cleanupMs * 3,
            'local process-tree release',
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      let mainClosed = false;
      try {
        await client.lifecycle.wait(options.cleanupMs);
        mainClosed = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        if (!mainClosed)
          throw new Error('Main child closure UNKNOWN before final backend observation');
        if (!finalBackendCheck) throw new Error('Final backend release observation unavailable');
        await bounded(finalBackendCheck(), options.cleanupMs * 3, 'final backend release');
        observe('migration-backend-absent', tag, identity);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length)
        throw new AggregateError(
          [...(failure ? [failure] : []), ...cleanupErrors],
          'Unresolved migration cleanup',
        );
      if (failure) throw failure;
      if (!result) throw new Error('Missing migration execution result');
      return result;
    },
  };
}
