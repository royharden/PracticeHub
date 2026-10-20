import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLocalCli } from './cli.js';
import { loadLaneConfiguration, type LaneBinding } from './compose-config.js';
import {
  createDockerMigrationTransport,
  discoverMigrations,
  validateMigrationTarget,
  requireMainTimeoutEvidence,
  type MigrationTarget,
  type MigrationObservation,
} from './migrations.js';

// Draft only. Actual execution requires a separately pinned root source/target/lane grant.
// This file never creates/drops a database, changes a role, resets a stack or chooses a default DB.
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected pinned CLI test object');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).sort().join('|') !== [...keys].sort().join('|'))
    throw new Error('CLI test binding has unexpected/missing fields');
}
function pinnedFile(path: unknown, sha256: unknown): Buffer {
  if (
    typeof path !== 'string' ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    typeof sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(sha256)
  )
    throw new Error('Explicit absolute pinned file required');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path)
    throw new Error('Pinned test file must be regular and non-link');
  const bytes = readFileSync(path);
  if (digest(bytes) !== sha256) throw new Error('Pinned CLI test file digest differs');
  return bytes;
}
const bindingPath = process.env['PH_CLI_MIGRATION_TEST_BINDING'];
const bindingSha256 = process.env['PH_CLI_MIGRATION_TEST_BINDING_SHA256'];
const binding = record(JSON.parse(pinnedFile(bindingPath, bindingSha256).toString('utf8')));
exactKeys(binding, [
  'version',
  'syntheticOnly',
  'allowOwnedBackendTermination',
  'grant',
  'target',
  'slowLaneBinding',
  'retryLaneBinding',
  'slowRoot',
  'slowManifest',
  'slowManifestSha256',
  'retryRoot',
  'retryManifest',
  'retryManifestSha256',
  'evidenceRoot',
  'nativePaths',
]);
if (
  binding['version'] !== 1 ||
  binding['syntheticOnly'] !== true ||
  binding['allowOwnedBackendTermination'] !== true ||
  typeof binding['grant'] !== 'string' ||
  !binding['grant']
)
  throw new Error('Fresh actual CLI synthetic execution/termination grant required');
const targetRecord = record(binding['target']);
exactKeys(targetRecord, [
  'containerId',
  'clusterSystemIdentifier',
  'databaseName',
  'databaseUser',
  'grant',
]);
if (
  typeof targetRecord['containerId'] !== 'string' ||
  typeof targetRecord['clusterSystemIdentifier'] !== 'string' ||
  typeof targetRecord['databaseName'] !== 'string' ||
  targetRecord['databaseUser'] !== 'practicehub' ||
  targetRecord['grant'] !== binding['grant']
)
  throw new Error('Incomplete exact CLI target');
const target: MigrationTarget = validateMigrationTarget({
  containerId: targetRecord['containerId'],
  clusterSystemIdentifier: targetRecord['clusterSystemIdentifier'],
  databaseName: targetRecord['databaseName'],
  databaseUser: targetRecord['databaseUser'],
  grant: targetRecord['grant'] as string,
});
if (!/^ph_cli_synthetic_[a-z0-9_]+$/.test(target.databaseName))
  throw new Error('CLI test must name its separately prepared synthetic database');
function absoluteDirectory(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !isAbsolute(value) ||
    resolve(value) !== value ||
    !lstatSync(value).isDirectory() ||
    realpathSync(value) !== value
  )
    throw new Error('Explicit existing non-link test directory required');
  return value;
}
const slowRoot = absoluteDirectory(binding['slowRoot']);
const retryRoot = absoluteDirectory(binding['retryRoot']);
const evidenceRoot = absoluteDirectory(binding['evidenceRoot']);
function laneBinding(value: unknown, root: string): LaneBinding {
  const entry = record(value);
  exactKeys(entry, ['path', 'sha256']);
  pinnedFile(entry['path'], entry['sha256']);
  const result = { path: entry['path'] as string, sha256: entry['sha256'] as string };
  const lane = loadLaneConfiguration(result);
  if (
    lane.mode !== 'operate' ||
    resolve(lane.sourceCwd, lane.migrationRoot ?? '.') !== root ||
    lane.services['app-postgres']?.containerId !== target.containerId
  )
    throw new Error('CLI fixture lane/source/target mismatch');
  return result;
}
const slowLaneBinding = laneBinding(binding['slowLaneBinding'], slowRoot);
const retryLaneBinding = laneBinding(binding['retryLaneBinding'], retryRoot);
function verifyFixture(root: string, manifestPath: unknown, sha256: unknown) {
  const manifest = record(JSON.parse(pinnedFile(manifestPath, sha256).toString('utf8')));
  exactKeys(manifest, ['syntheticOnly', 'files']);
  if (manifest['syntheticOnly'] !== true || !Array.isArray(manifest['files']))
    throw new Error('Synthetic source fixture manifest required');
  const files = discoverMigrations(root);
  const actual = files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.size }));
  if (JSON.stringify(actual) !== JSON.stringify(manifest['files']) || files.length !== 2)
    throw new Error('Exactly pinned two-file CLI fixture required');
  return files;
}
const slow = verifyFixture(slowRoot, binding['slowManifest'], binding['slowManifestSha256']);
const retry = verifyFixture(retryRoot, binding['retryManifest'], binding['retryManifestSha256']);
if (
  slow[0]?.sha256 !== retry[0]?.sha256 ||
  slow[0]?.path !== retry[0]?.path ||
  slow[1]?.path !== retry[1]?.path ||
  slow[1]?.sha256 === retry[1]?.sha256 ||
  !slow[1]?.bytes.toString().includes('pg_sleep(30)') ||
  retry[1]?.bytes.toString().includes('pg_sleep')
)
  throw new Error('Require immutable first prefix and controlled unapplied slow->retry suffix');
const nativePaths = record(binding['nativePaths']);
exactKeys(nativePaths, [
  'executablePath',
  'executableSha256',
  'powershellPath',
  'powershellSha256',
  'powershellVersion',
]);
pinnedFile(nativePaths['executablePath'], nativePaths['executableSha256']);
pinnedFile(nativePaths['powershellPath'], nativePaths['powershellSha256']);
if (
  typeof nativePaths['executablePath'] !== 'string' ||
  typeof nativePaths['powershellPath'] !== 'string' ||
  nativePaths['powershellVersion'] !== '7.6.5'
)
  throw new Error('Explicit actual native executable paths required');
const observations: MigrationObservation[] = [];
const eventPath = join(evidenceRoot, 'cli-observations.jsonl');
writeFileSync(eventPath, '', { encoding: 'utf8', flag: 'wx' });
const transport = createDockerMigrationTransport({
  nativePaths: {
    executablePath: nativePaths['executablePath'],
    executableSha256: nativePaths['executableSha256'] as string,
    powershellPath: nativePaths['powershellPath'],
    powershellSha256: nativePaths['powershellSha256'] as string,
    powershellVersion: '7.6.5',
  },
  onObservation(event) {
    // Observational sink only: it cannot attest or override process/backend ownership decisions.
    appendFileSync(eventPath, JSON.stringify(event) + '\n', 'utf8');
    observations.push(event);
  },
});
if (transport.bindDocker === undefined || transport.bindDocker === null)
  throw new Error('CLI fixture transport must provide Docker binding');
transport.bindDocker(loadLaneConfiguration(slowLaneBinding).docker);
async function query(sql: string): Promise<string> {
  const result = await transport.execute(
    target,
    Buffer.from(`SET default_transaction_read_only=on;\n${sql}\n`),
    { timeoutMs: 10000, cleanupMs: 10000 },
  );
  if (result.status !== 0) throw new Error(`Read-only observer failed: ${result.stderr}`);
  const rows = result.stdout.split(/\r?\n/).filter((line) => line.startsWith('PH_CLI_RESULT|'));
  if (rows.length !== 1) throw new Error('Missing/ambiguous real CLI observer result');
  const row = rows[0];
  if (row === undefined || row === null) throw new Error('Missing CLI observer result row');
  return row.slice('PH_CLI_RESULT|'.length);
}
function cli(root: string, timeoutMs: number) {
  return createLocalCli(undefined, undefined, undefined, {
    laneBinding: root === slowRoot ? slowLaneBinding : retryLaneBinding,
    target,
    root,
    timeoutMs,
    cleanupMs: 10000,
    transport,
  });
}
async function state() {
  return record(
    JSON.parse(
      await query(`SELECT 'PH_CLI_RESULT|' || json_build_object(
    'journalExists',to_regclass('local_migrations.applied') IS NOT NULL,
    'slowEffect',to_regclass('public.cli_timeout_effect') IS NOT NULL,
    'ownedBackends',(SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND application_name LIKE 'ph_migrate_%' AND pid<>pg_backend_pid()),
    'ownedAdvisoryLocks',(SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database() AND a.application_name LIKE 'ph_migrate_%' AND a.pid<>pg_backend_pid() AND l.locktype='advisory' AND l.classid=724106 AND l.objid=1)
  )::text;`),
    ),
  );
}
function save(name: string, value: unknown): void {
  // Exclusive create protects previous failed/successful execution histories.
  writeFileSync(join(evidenceRoot, name), JSON.stringify(value, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
  });
}
describe.sequential('actual production CLI supervised migration path', () => {
  it('times out actual uncommitted work, preserves prefix and releases exact backend/lock', async () => {
    const before = await state();
    save('cli-before.json', before);
    expect(before['journalExists']).toBe(false);
    expect(before['slowEffect']).toBe(false);
    expect(before['ownedBackends']).toBe(0);
    expect(before['ownedAdvisoryLocks']).toBe(0);
    let failure: unknown;
    const slowObservationStart = observations.length;
    try {
      await cli(slowRoot, 1000).main(['migrate']);
    } catch (error) {
      failure = error;
    }
    // Match real timeout/statement-cancellation, not a missing grant, bad binding or unavailable host.
    expect(failure).toBeInstanceOf(Error);
    const diagnostic = String(failure);
    expect(diagnostic).toMatch(/timed out|statement timeout|canceling statement/);
    expect(diagnostic).not.toMatch(/UNKNOWN|supervisor required|target identity mismatch/);
    save('cli-timeout-diagnostic.json', {
      diagnostic,
      expectedFailure: true,
      grant: binding['grant'],
    });
    const slowBackend = requireMainTimeoutEvidence(observations, slowObservationStart, target);
    save('cli-slow-main-evidence.json', {
      start: slowObservationStart,
      backend: slowBackend,
      events: observations.slice(slowObservationStart),
    });
    const after = await state();
    save('cli-after-timeout.json', after);
    expect(after['journalExists']).toBe(true);
    expect(after['slowEffect']).toBe(false);
    expect(after['ownedBackends']).toBe(0);
    expect(after['ownedAdvisoryLocks']).toBe(0);
    expect(await query("SELECT 'PH_CLI_RESULT|' || count(*) FROM local_migrations.applied;")).toBe(
      '1',
    );
    const prefix = await query(
      "SELECT 'PH_CLI_RESULT|' || sha256 FROM local_migrations.applied WHERE position=1;",
    );
    expect(prefix).toBe(slow[0]?.sha256);
    expect(
      await query(
        "SELECT 'PH_CLI_RESULT|' || count(*) FROM public.cli_prefix_sentinel WHERE id=1 AND synthetic;",
      ),
    ).toBe('1');
    const sentinel = await query(
      "SELECT 'PH_CLI_RESULT|' || json_agg(row_to_json(s) ORDER BY id)::text FROM public.cli_prefix_sentinel s;",
    );
    save('cli-prefix.json', { prefix, expected: slow[0]?.sha256, sentinel });
    // Retry only after every timeout/cleanup/prefix assertion above succeeded.
    await cli(retryRoot, 10000).main(['migrate']);
    const first = await query(
      "SELECT 'PH_CLI_RESULT|' || (SELECT count(*) FROM public.cli_timeout_effect)::text || '|' || (SELECT count(*) FROM local_migrations.applied)::text;",
    );
    expect(first).toBe('1|2');
    const journal = await query(
      "SELECT 'PH_CLI_RESULT|' || json_agg(row_to_json(a) ORDER BY position)::text FROM local_migrations.applied a;",
    );
    await cli(retryRoot, 10000).main(['migrate']);
    expect(
      await query(
        "SELECT 'PH_CLI_RESULT|' || (SELECT count(*) FROM public.cli_timeout_effect)::text || '|' || (SELECT count(*) FROM local_migrations.applied)::text;",
      ),
    ).toBe(first);
    expect(
      await query(
        "SELECT 'PH_CLI_RESULT|' || json_agg(row_to_json(a) ORDER BY position)::text FROM local_migrations.applied a;",
      ),
    ).toBe(journal);
    const final = await state();
    expect(final['ownedBackends']).toBe(0);
    expect(final['ownedAdvisoryLocks']).toBe(0);
    expect(
      await query(
        "SELECT 'PH_CLI_RESULT|' || json_agg(row_to_json(s) ORDER BY id)::text FROM public.cli_prefix_sentinel s;",
      ),
    ).toBe(sentinel);
    save('cli-final.json', {
      first,
      journal,
      state: final,
      target,
      fixtureBindingSha256: bindingSha256,
    });
    // Final external root observer still must inspect auxiliary observer tags after this suite exits.
  });
});
