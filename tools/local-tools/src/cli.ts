import {
  withLaneObservationContext,
  laneObservationOwnerState,
} from './lane-observation-context.js';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverMigrations,
  createDockerMigrationTransport,
  runMigrationsAsync,
  validateMigrationTarget,
  type MigrationTarget,
  type MigrationTransport,
  verifyMigrationSources,
  activePsqlSql,
} from './migrations.js';
import type { WindowsSupervisorBinding } from './migration-supervisor.js';
import {
  composeArguments,
  loadLaneConfiguration,
  laneComposeArguments,
  verifyLaneService,
  verifyResolvedLaneConfiguration,
  readLaneSource,
  readPinnedFile,
  type LaneBinding,
  type LaneConfiguration,
  type PinnedFile,
} from './compose-config.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export interface LocalMigrationOptions {
  readonly laneBinding?: LaneBinding;
  readonly target?: MigrationTarget;
  readonly root?: string;
  readonly timeoutMs?: number;
  readonly cleanupMs?: number;
  readonly transport?: MigrationTransport;
  readonly nativePaths?: WindowsSupervisorBinding;
  readonly localAcceptance?: LocalAcceptanceScope;
  /** Loader-provided external pin; local scope never comes from ambient discovery. */
  readonly bindingFile?: PinnedFile;
}

const localDbSuites = [
  'platform-core',
  'identity',
  'audit-evidence',
  'consent',
  'events',
  'documents',
  'platform-integration',
  'ai-gateway',
  'analytics',
  'breach-case',
  'catalog-cash',
  'comms',
  'membership-entitlements',
  'payments-ledger',
  'portal-intake',
  'migration',
] as const;
const ledgerSuites = [
  'final_dunning',
  'final_v2',
  'migration',
  'original0071',
  'empty',
  'upgrade',
  'recovery',
  'refusal',
  'legacy_cash',
] as const;
/** Finite effect scope carried only inside the existing externally pinned binding. */
export interface LocalAcceptanceScope {
  readonly version: 1;
  readonly syntheticOnly: true;
  readonly grant: string;
  readonly lane: LaneBinding;
  readonly target: MigrationTarget;
  readonly sourceCwd: string;
  readonly dockerEndpoint: string;
  readonly project: string;
  readonly database: {
    readonly host: '127.0.0.1';
    readonly port: number;
    readonly name: 'practicehub';
    readonly owner: 'practicehub';
    readonly appRole: 'practicehub_app';
    readonly administrativeDatabase: 'postgres';
  };
  readonly dex: {
    readonly issuer: 'http://127.0.0.1:5556/dex';
    readonly clientId: 'practicehub-local';
    readonly callback: 'http://127.0.0.1:53000/auth/callback';
  };
  readonly ledger: {
    readonly run: string;
    readonly databases: readonly string[];
    readonly effects: readonly string[];
  };
  readonly suites: readonly string[];
  /** Complete local source/config/helper/SQL/generated-code closure, relative to sourceCwd. */
  readonly sourceFiles: readonly PinnedFile[];
  readonly runtime: { readonly node: PinnedFile; readonly pnpm: PinnedFile };
}

function exactFields(value: object, fields: readonly string[]): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('|') !== [...fields].sort().join('|')
  )
    throw new Error('Local acceptance scope has missing or unknown fields');
}

/** Failure preserves the actual command result/cause; never rolls back partial up. */
export class ProvisioningIncompleteError extends Error {
  readonly state = 'partial-or-unknown-requires-independent-readback';
  constructor(
    readonly project: string,
    cause: unknown,
  ) {
    super(
      'Provisioning incomplete; preserve partial containers/volumes and obtain independent readback before a fresh target binding',
      { cause },
    );
  }
}

/** Real command dispatcher with replaceable process/HTTP transports for bounded routing tests. */
export function createLocalCli(
  processTransport: typeof spawnSync = spawnSync,
  httpTransport: typeof fetch = fetch,
  override = process.env['PRACTICEHUB_COMPOSE_OVERRIDE'],
  migrationOptions: LocalMigrationOptions = {},
) {
  let composeArgs = composeArguments(repoRoot, override);
  let lane: LaneConfiguration | undefined;
  let admittedLaneIdentity: string | undefined;
  let sourceRoot = repoRoot;
  let localAcceptanceActive = false;
  // One seed() call admits the database once. Later files reuse that target.
  let seedBatchActive = false;
  let seedBatchTarget: MigrationTarget | undefined;
  // One testLocal admits the simulator once. Later simCalls in that call do HTTP only.
  let insideTestLocal = false;
  let testLocalSimAdmitted = false;
  const migrationTransport =
    migrationOptions.transport ??
    createDockerMigrationTransport({
      ...(migrationOptions.nativePaths ? { nativePaths: migrationOptions.nativePaths } : {}),
      onObservation: (event) => console.error(`PH_MIGRATION_OBSERVATION ${JSON.stringify(event)}`),
    });

  function invocation(
    command: string,
    args: readonly string[],
  ): { command: string; args: string[] } {
    if (command === 'pnpm') {
      const corepackCli = join(
        dirname(process.execPath),
        'node_modules',
        'corepack',
        'dist',
        'pnpm.js',
      );
      if (existsSync(corepackCli)) {
        return { command: process.execPath, args: [corepackCli, ...args] };
      }
    }
    return {
      command: process.platform === 'win32' && command !== 'docker' ? `${command}.cmd` : command,
      args: [...args],
    };
  }

  function run(command: string, args: readonly string[], options: SpawnSyncOptions = {}): string {
    const resolved = invocation(command, args);
    const result = processTransport(resolved.command, resolved.args, {
      timeout: 110000,
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
      stdio: options.stdio ?? 'pipe',
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
    if (result.status !== 0) {
      const stderr = typeof result.stderr === 'string' ? result.stderr : '';
      throw new Error(`${command} ${args.join(' ')} failed: ${stderr.trim()}`);
    }
    return typeof result.stdout === 'string' ? result.stdout.trim() : '';
  }

  function compose(args: readonly string[], stdio: SpawnSyncOptions['stdio'] = 'inherit'): string {
    return run('docker', [...composeArgs, ...args], { stdio });
  }

  async function admitLane(mode: 'operate' | 'provision' = 'operate'): Promise<LaneConfiguration> {
    const approved = loadLaneConfiguration(migrationOptions.laneBinding);
    if (localAcceptanceActive) requireDelegatedEndpointScope(approved);
    const identity = JSON.stringify(approved);
    if (admittedLaneIdentity !== undefined && identity !== admittedLaneIdentity)
      throw new Error('Lane changed after initial admission');
    if (approved.mode !== mode) throw new Error('Fresh external lane mode binding required');
    if (override !== undefined)
      throw new Error('Legacy Compose override is preview-only; use ordered approved lane files');
    if (
      migrationOptions.root !== undefined &&
      resolve(migrationOptions.root) !== resolve(approved.sourceCwd, approved.migrationRoot ?? '.')
    )
      throw new Error('Migration source cwd differs from approved lane');
    lane = approved;
    // Keep the expected value private: bindDocker receives the docker object.
    // This snapshot is only compared after a fresh full load, never a read cache.
    admittedLaneIdentity ??= identity;
    sourceRoot = resolve(approved.sourceCwd, approved.migrationRoot ?? '.');
    composeArgs = laneComposeArguments(approved);
    if (!migrationTransport.bindDocker)
      throw new Error('Supervised Docker selection binding required');
    migrationTransport.bindDocker(approved.docker);
    return approved;
  }

  async function inspectService(name: string): Promise<void> {
    const approved = await admitLane();
    verifyResolvedLaneConfiguration(
      approved,
      await migrationCommand([...composeArgs, 'config', '--format', 'json']),
    );
    const expected = approved.services[name];
    if (!expected?.containerId) throw new Error('Expected full service container identity');
    const id = await migrationCommand([...composeArgs, 'ps', '--all', '--quiet', name]);
    if (id !== expected.containerId) throw new Error('Compose container identity mismatch');
    verifyLaneService(approved, name, await migrationCommand(['inspect', expected.containerId]));
  }

  async function psqlStdin(sql: string): Promise<void> {
    const reused = seedBatchTarget;
    const target = reused ?? (await migrationPreflight());
    if (!reused) await inspectService('app-postgres');
    // psql meta-commands can reconnect, include unpinned files or run a shell.
    activePsqlSql(sql);
    if (!reused) await admitLane();
    const result = await migrationTransport.execute(target, Buffer.from(sql), {
      timeoutMs: migrationOptions.timeoutMs ?? 110000,
      cleanupMs: migrationOptions.cleanupMs ?? 10000,
    });
    if (result.status !== 0) throw new Error(`Seed SQL failed: ${result.stderr}`);
  }

  async function migrationPreflight(): Promise<MigrationTarget> {
    const approved = await admitLane();
    const target = validateMigrationTarget(migrationOptions.target);
    if (target.containerId !== approved.services['app-postgres']?.containerId)
      throw new Error('Database target differs from approved lane container');
    for (const n of [migrationOptions.timeoutMs ?? 110000, migrationOptions.cleanupMs ?? 10000])
      if (!Number.isSafeInteger(n) || n <= 0)
        throw new Error('Positive bounded migration deadlines required');
    await migrationTransport.preflight?.(target);
    if (seedBatchActive) seedBatchTarget ??= target;
    return target;
  }

  async function migrationCommand(args: readonly string[]): Promise<string> {
    if (!migrationTransport.command) {
      throw new Error('Supervised migration preflight command transport required');
    }
    // A preceding command can run caller code and mutate files or the binding.
    // Re-read the full closure synchronously at this dispatch boundary, and
    // refuse a freshly valid but different lane from the one that formed args.
    const current = loadLaneConfiguration(migrationOptions.laneBinding);
    if (JSON.stringify(current) !== admittedLaneIdentity)
      throw new Error('Lane changed before supervised command dispatch');
    const result = await migrationTransport.command(args, {
      timeoutMs: migrationOptions.timeoutMs ?? 110000,
      cleanupMs: migrationOptions.cleanupMs ?? 10000,
    });
    if (result.status !== 0)
      throw new Error(`Supervised command failed: ${JSON.stringify(result)}`);
    return result.stdout.trim();
  }

  async function migrate(): Promise<void> {
    const target = await migrationPreflight();
    await inspectService('app-postgres');
    const migrations = discoverMigrations(sourceRoot);
    for (const migration of migrations) {
      const currentLane = lane;
      if (currentLane === null || currentLane === undefined)
        throw new Error('Missing admitted migration lane');
      const approved = readLaneSource(
        currentLane,
        relative(currentLane.sourceCwd, join(sourceRoot, migration.path)).replaceAll('\\', '/'),
      );
      if (createHash('sha256').update(approved).digest('hex') !== migration.sha256)
        throw new Error('Approved migration source mismatch');
    }
    let report: Awaited<ReturnType<typeof runMigrationsAsync>> | undefined;
    const failures: unknown[] = [];
    try {
      report = await runMigrationsAsync(migrations, (input) =>
        migrationTransport.execute(target, input, {
          timeoutMs: migrationOptions.timeoutMs ?? 110000,
          cleanupMs: migrationOptions.cleanupMs ?? 10000,
        }),
      );
    } catch (error) {
      failures.push(error);
    }
    try {
      verifyMigrationSources(sourceRoot, migrations);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, 'Migration execution/source integrity failed');
    if (!report) throw new Error('Missing migration report');
    console.log(
      `migrations applied=${report.applied} skipped=${report.skipped} total=${report.total} manifest=${report.manifestSha256}`,
    );
  }

  function doctor(): void {
    const expectedNode = 'v24.18.0';
    if (process.version !== expectedNode) {
      throw new Error(`Node ${expectedNode} is required; received ${process.version}`);
    }
    const pnpmVersion = run('pnpm', ['--version']);
    if (pnpmVersion !== '11.9.0') {
      throw new Error(`pnpm 11.9.0 is required; received ${pnpmVersion}`);
    }
    const store = run('pnpm', ['store', 'path']);
    const storeParts = store.toLowerCase().split(/[\\/]+/);
    if (
      !isAbsolute(store) ||
      store.toLowerCase().startsWith(repoRoot.toLowerCase()) ||
      storeParts.includes('onedrive')
    ) {
      throw new Error(
        `pnpm store must be an absolute path outside the repo and OneDrive; received ${store}`,
      );
    }
    run('docker', ['compose', 'version']);
    compose(['config', '--quiet'], 'pipe');
    console.log(`node=${process.version} pnpm=${pnpmVersion} store=${store} compose=OK`);
  }

  async function up(): Promise<void> {
    const approved = await admitLane('provision');
    verifyResolvedLaneConfiguration(
      approved,
      await migrationCommand([...composeArgs, 'config', '--format', 'json']),
    );
    for (const name of Object.keys(approved.services))
      if (await migrationCommand([...composeArgs, 'ps', '--all', '--quiet', name]))
        throw new Error(
          'Provisioning an existing service requires a fresh externally bound lifecycle grant',
        );
    // No host build, image pull, inferred service selection, old target or SQL.
    // A failure can mean some containers started. Preserve that result and state.
    const args = [
      ...composeArgs,
      'up',
      '--no-build',
      '--pull',
      'never',
      '--no-deps',
      '--no-recreate',
      '--detach',
      '--wait',
      ...Object.keys(approved.services).sort(),
    ];
    try {
      await admitLane('provision');
      const output = await migrationCommand(args);
      console.log(
        JSON.stringify({
          kind: 'provision-awaiting-independent-readback',
          project: approved.project,
          output,
          migrationIssued: false,
          bindingIssued: false,
        }),
      );
    } catch (cause) {
      throw new ProvisioningIncompleteError(approved.project, cause);
    }
  }

  async function seed(): Promise<void> {
    const approved = await admitLane();
    const paths = [
      'infra/postgres/init/002-seed.sql',
      'infra/postgres/seed/003-tenancy-seed.sql',
      'infra/postgres/seed/004-jurisdiction-seed.sql',
      'infra/postgres/seed/005-capability-seed.sql',
      'infra/postgres/seed/034-voice-seed.sql',
      'infra/postgres/seed/006-identity-seed.sql',
      'infra/postgres/seed/007-authn-seed.sql',
      'infra/postgres/seed/008-merge-seed.sql',
      'infra/postgres/seed/009-audit-seed.sql',
      'infra/postgres/seed/010-pdp-seed.sql',
      'infra/postgres/seed/011-consent-seed.sql',
      'infra/postgres/seed/012-events-seed.sql',
      'infra/postgres/seed/013-policy-clocks-seed.sql',
      'infra/postgres/seed/014-workitems-seed.sql',
      'infra/postgres/seed/015-elevation-seed.sql',
      'infra/postgres/seed/016-oncall-seed.sql',
      'infra/postgres/seed/017-documents-seed.sql',
      'infra/postgres/seed/018-documents-records-seed.sql',
      'infra/postgres/seed/019-vendor-registry-seed.sql',
      'infra/postgres/seed/020-synthgen-corpus-seed.sql',
      'infra/postgres/seed/021-threads-seed.sql',
      'infra/postgres/seed/022-paid-service-loop-seed.sql',
      'infra/postgres/seed/024-ai-gateway-seed.sql',
      'infra/postgres/seed/025-portal-intake-seed.sql',
      'infra/postgres/seed/027-analytics-seed.sql',
      'infra/postgres/seed/028-migration-seed.sql',
      'infra/postgres/seed/029-breach-case-seed.sql',
    ];
    seedBatchActive = true;
    seedBatchTarget = undefined;
    try {
      // Refuse an invalid seed anywhere in the batch before starting migrations.
      // Yield between reads so validation does not starve the source observer.
      for (const path of paths) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        activePsqlSql(readLaneSource(approved, path).toString('utf8'));
      }
      await migrate();
      for (const path of paths) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        const bytes = readLaneSource(approved, path);
        activePsqlSql(bytes.toString('utf8'));
        const current = readLaneSource(await admitLane(), path);
        if (!current.equals(bytes)) throw new Error('Seed source changed after admission');
        await psqlStdin(current.toString('utf8'));
        console.log(`seeded ${path}`);
      }
    } finally {
      seedBatchActive = false;
      seedBatchTarget = undefined;
    }
  }

  interface SimCallOptions {
    readonly method?: string;
    readonly body?: unknown;
    /** A dispatch that trips an armed process-crash primitive never answers. */
    readonly expectDeath?: boolean;
  }

  async function simCall(
    path: string,
    options: SimCallOptions = {},
  ): Promise<Record<string, unknown>> {
    for (const [key, value] of Object.entries(process.env))
      if (value && /^(?:https?_proxy|all_proxy|node_use_env_proxy)$/i.test(key))
        throw new Error('Ambient HTTP proxy configuration refused');
    const reuseSimulator = insideTestLocal && testLocalSimAdmitted;
    if (!reuseSimulator) await inspectService('vendor-simulator');
    if (lane === null || lane === undefined) throw new Error('Missing admitted simulator lane');
    const vendorSimBase = lane.simulatorOrigin;
    if (!/^\/[a-zA-Z0-9/_-]+$/.test(path)) throw new Error('Invalid simulator path');
    const method = options.method ?? 'GET';
    try {
      if (!reuseSimulator) {
        await admitLane();
        if (localAcceptanceActive)
          requireDelegatedEndpointScope(loadLaneConfiguration(migrationOptions.laneBinding));
        if (insideTestLocal) testLocalSimAdmitted = true;
      }
      const response = await httpTransport(`${vendorSimBase}${path}`, {
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
        method,
        ...(options.body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(options.body),
            }),
      });
      const text = await response.text();
      if (options.expectDeath) {
        throw new Error(`vendor-sim answered ${response.status} where a process death was armed`);
      }
      if (!response.ok) {
        throw new Error(`vendor-sim ${method} ${path} -> ${response.status} ${text}`);
      }
      return JSON.parse(text) as Record<string, unknown>;
    } catch (error) {
      if (options.expectDeath && error instanceof TypeError) {
        // The socket died with the process, which is the point of the drill.
        return {};
      }
      throw error;
    }
  }

  function simRequestBody(key: string, at: string): Record<string, unknown> {
    return {
      idempotencyKey: `synthetic-local-${key}`,
      payloadRef: `synthetic-local-payload-${key}`,
      requestedAt: at,
      // A deliberately identifier-shaped payload: the ledger dump is scanned for
      // these values below, so "the sim store holds no payload" is exercised on
      // the LIVE service, not only in the unit suite.
      payload: { mrn: 'synthetic-local-mrn-55512345', phone: 'synthetic-local-phone-7025550143' },
      synthetic: true,
    };
  }

  /**
   * WP-027 rail-simulator probes against the LIVE service: the frozen surface,
   * the process-kill hook across a real container death (the ledger survives and
   * a re-delivery reconciles instead of sending twice), the PHI scan of the live
   * store, and the reset rollback.
   */
  async function probeRailSimulator(): Promise<void> {
    const health = await simCall('/healthz');
    if (health.dataPolicy !== 'synthetic-only' || health.rails !== 17 || health.primitives !== 18) {
      throw new Error(
        `vendor-sim health differs: dataPolicy=${String(health.dataPolicy)} rails=${String(health.rails)} primitives=${String(health.primitives)}`,
      );
    }

    // Start from the rollback state so the drill is deterministic across runs.
    await simCall('/control/reset', { method: 'POST' });

    const catalog = (await simCall('/primitives')).catalog as { primitiveId: string }[];
    const catalogIds = catalog.map((primitive) => primitive.primitiveId).join(',');
    const expectedIds = Array.from(
      { length: 18 },
      (_, index) => `X-${String(index + 1).padStart(2, '0')}`,
    ).join(',');
    if (catalogIds !== expectedIds) {
      throw new Error(`vendor-sim primitive catalog differs: ${catalogIds}`);
    }

    // The process-kill drill. Arm a crash between the external effect and its
    // receipt, drive the rail, and let the container die.
    await simCall('/scenarios/RAIL-008/X-02', {
      method: 'POST',
      body: { killPoint: 'after-effect-before-receipt' },
    });
    await simCall('/rails/RAIL-008/create-payment-intent', {
      method: 'POST',
      body: simRequestBody('kill-drill', '2026-01-01T00:00:00Z'),
      expectDeath: true,
    });

    let died = false;
    for (let attempt = 0; attempt < 25 && !died; attempt += 1) {
      died = /"State":\s*"exited"/.test(
        await migrationCommand([
          ...composeArgs,
          'ps',
          '--all',
          '--format',
          'json',
          'vendor-simulator',
        ]),
      );
      if (!died) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (!died) {
      throw new Error('vendor-sim did not die on the armed process-crash primitive');
    }
    await inspectService('vendor-simulator');
    await admitLane();
    if (lane === null || lane === undefined) throw new Error('Missing admitted simulator lane');
    const simulator = lane.services['vendor-simulator'];
    if (simulator === null || simulator === undefined)
      throw new Error('Missing admitted simulator service');
    const simulatorContainerId = simulator.containerId;
    if (simulatorContainerId === null || simulatorContainerId === undefined)
      throw new Error('Missing admitted simulator container identity');
    await migrationCommand(['start', simulatorContainerId]);
    await inspectService('vendor-simulator');

    const recovered = (await simCall('/state')).state as {
      effects: { idempotencyKey: string; state: string; receiptRef: string | null }[];
      receipts: unknown[];
    };
    const killed = recovered.effects.find(
      (effect) => effect.idempotencyKey === 'synthetic-local-kill-drill',
    );
    if (
      killed?.state !== 'unknown' ||
      killed.receiptRef !== null ||
      recovered.receipts.length !== 0
    ) {
      throw new Error(
        `vendor-sim ledger did not survive the kill as an unknown effect: ${JSON.stringify(killed)}`,
      );
    }

    const replayed = (
      await simCall('/rails/RAIL-008/create-payment-intent', {
        method: 'POST',
        body: simRequestBody('kill-drill', '2026-01-01T00:05:00Z'),
      })
    ).response as { status: string; attempts: number; resendsExternalEffect: boolean };
    if (
      replayed.status !== 'uncertain' ||
      replayed.attempts !== 2 ||
      replayed.resendsExternalEffect !== false
    ) {
      throw new Error(
        `vendor-sim re-delivery after a crash did not reconcile: ${JSON.stringify(replayed)}`,
      );
    }

    // PHI scan of the live sim store: the identifier-shaped payload values above
    // must appear nowhere in the ledger, and every record carries the watermark.
    const dumped = (await simCall('/state')).state as {
      effects: { synthetic: boolean }[];
    };
    const dumpText = JSON.stringify(dumped);
    for (const value of ['synthetic-local-mrn-55512345', 'synthetic-local-phone-7025550143']) {
      if (dumpText.includes(value)) {
        throw new Error(`vendor-sim store leaked a request payload value (${value})`);
      }
    }
    if (dumped.effects.length !== 1 || dumped.effects.some((effect) => effect.synthetic !== true)) {
      throw new Error(`vendor-sim store holds an unwatermarked or unexpected record: ${dumpText}`);
    }

    // The rollback expectation: `sim reset` clears the ledger.
    const reset = (await simCall('/control/reset', { method: 'POST' })).state as {
      effects: unknown[];
      receipts: unknown[];
      heartbeats: unknown[];
    };
    if (
      reset.effects.length !== 0 ||
      reset.receipts.length !== 0 ||
      reset.heartbeats.length !== 0
    ) {
      throw new Error(`vendor-sim reset left state behind: ${JSON.stringify(reset)}`);
    }

    await probeRailFleetHeartbeat();
  }

  interface HeartbeatEvaluation {
    readonly railId: string;
    readonly verdict: string;
    readonly reasons: readonly string[];
  }

  /**
   * WP-028 fleet probes against the LIVE service: every declared rail is bound to
   * an authority, the whole fleet is judged for silence (a rail carrying nothing
   * is loud, never assumed calm), and carrying one rail to its declared band
   * quiets that rail alone.
   */
  async function probeRailFleetHeartbeat(): Promise<void> {
    const declared = (await simCall('/rails')).rails as {
      railId: string;
      authorityId: string;
      presets: { authorityScenarioIndex: number }[];
    }[];
    const bare = declared.filter(
      (rail) => !/^AUTH-\d{3}$/.test(rail.authorityId) || rail.presets.length === 0,
    );
    if (declared.length !== 17 || bare.length > 0) {
      throw new Error(
        `vendor-sim rail fleet differs: rails=${declared.length} unbound=${bare.map((rail) => rail.railId).join(',')}`,
      );
    }

    // A fleet with no traffic: every rail alarms, and each names why.
    const dark = (await simCall('/heartbeat')).heartbeat as HeartbeatEvaluation[];
    const calm = dark.filter((entry) => entry.verdict !== 'alarm').map((entry) => entry.railId);
    if (dark.length !== declared.length || calm.length > 0) {
      throw new Error(
        `vendor-sim heartbeat sweep read a silent rail as calm: swept=${dark.length} calm=${calm.join(',')}`,
      );
    }
    if (!dark.every((entry) => entry.reasons.includes('rail-dark'))) {
      throw new Error('vendor-sim heartbeat sweep did not name a dark rail as dark');
    }

    // Carry the lowest-band rail to its expectation: it, and only it, goes quiet.
    await simCall('/rails/RAIL-016/fetch-edition', {
      method: 'POST',
      body: simRequestBody('band', '2026-01-01T00:10:00Z'),
    });
    await simCall('/heartbeat/RAIL-016', {
      method: 'POST',
      body: { recordedAt: '2026-01-01T00:10:00Z' },
    });
    const swept = (await simCall('/heartbeat')).heartbeat as HeartbeatEvaluation[];
    const quiet = swept.filter((entry) => entry.verdict === 'quiet').map((entry) => entry.railId);
    if (quiet.join(',') !== 'RAIL-016') {
      throw new Error(`vendor-sim heartbeat band probe differs: quiet=${quiet.join(',')}`);
    }

    const heartbeatDump = JSON.stringify(swept);
    for (const value of ['synthetic-local-mrn-55512345', 'synthetic-local-phone-7025550143']) {
      if (heartbeatDump.includes(value)) {
        throw new Error(`vendor-sim heartbeat surface leaked a request payload value (${value})`);
      }
    }

    await simCall('/control/reset', { method: 'POST' });
  }

  function requireDelegatedEndpointScope(approved: LaneConfiguration): LocalAcceptanceScope {
    const origin = migrationOptions.bindingFile;
    if (!origin || !migrationOptions.localAcceptance)
      throw new Error('local:test endpoint scope unbound: pinned localAcceptance scope required');
    const fresh = loadMigrationBinding(origin.path, origin.sha256);
    const scope = fresh.localAcceptance;
    if (
      !scope ||
      JSON.stringify(scope) !== JSON.stringify(migrationOptions.localAcceptance) ||
      JSON.stringify(fresh.target) !== JSON.stringify(migrationOptions.target) ||
      JSON.stringify(fresh.nativePaths) !== JSON.stringify(migrationOptions.nativePaths)
    )
      throw new Error('Local acceptance binding changed or target differs');
    exactFields(scope, [
      'version',
      'syntheticOnly',
      'grant',
      'lane',
      'target',
      'sourceCwd',
      'dockerEndpoint',
      'project',
      'database',
      'dex',
      'ledger',
      'suites',
      'sourceFiles',
      'runtime',
    ]);
    exactFields(scope.lane, ['path', 'sha256']);
    exactFields(scope.target, [
      'containerId',
      'clusterSystemIdentifier',
      'databaseName',
      'databaseUser',
      'grant',
    ]);
    exactFields(scope.database, [
      'host',
      'port',
      'name',
      'owner',
      'appRole',
      'administrativeDatabase',
    ]);
    exactFields(scope.dex, ['issuer', 'clientId', 'callback']);
    exactFields(scope.ledger, ['run', 'databases', 'effects']);
    exactFields(scope.runtime, ['node', 'pnpm']);
    const target = validateMigrationTarget(migrationOptions.target);
    if (
      scope.version !== 1 ||
      scope.syntheticOnly !== true ||
      scope.grant !== target.grant ||
      JSON.stringify(scope.target) !== JSON.stringify(target) ||
      JSON.stringify(scope.lane) !== JSON.stringify(migrationOptions.laneBinding) ||
      scope.sourceCwd !== approved.sourceCwd ||
      scope.dockerEndpoint !== approved.docker.endpoint ||
      scope.project !== approved.project ||
      approved.mode !== 'operate' ||
      target.containerId !== approved.services['app-postgres']?.containerId ||
      target.databaseName !== 'practicehub' ||
      scope.database.name !== 'practicehub' ||
      scope.database.owner !== 'practicehub' ||
      scope.database.appRole !== 'practicehub_app' ||
      scope.database.administrativeDatabase !== 'postgres' ||
      scope.database.host !== '127.0.0.1' ||
      !Number.isSafeInteger(scope.database.port) ||
      scope.database.port < 1024 ||
      scope.database.port > 65535 ||
      !approved.services['app-postgres']?.ports.some(
        (port) =>
          port.containerPort === '5432/tcp' &&
          port.hostIp === scope.database.host &&
          port.hostPort === scope.database.port,
      ) ||
      scope.dex.issuer !== 'http://127.0.0.1:5556/dex' ||
      scope.dex.clientId !== 'practicehub-local' ||
      scope.dex.callback !== 'http://127.0.0.1:53000/auth/callback' ||
      !approved.services['dex']?.ports.some(
        (port) =>
          port.containerPort === '5556/tcp' &&
          port.hostIp === '127.0.0.1' &&
          port.hostPort === 5556,
      ) ||
      !Array.isArray(scope.suites) ||
      JSON.stringify(scope.suites) !== JSON.stringify(localDbSuites) ||
      !/^[a-z0-9]{1,16}$/.test(scope.ledger.run) ||
      JSON.stringify(scope.ledger.databases) !==
        JSON.stringify(
          ledgerSuites.map((suite) => `ph_ledger_proof_${scope.ledger.run}_${suite}`),
        ) ||
      JSON.stringify(scope.ledger.effects) !==
        JSON.stringify([
          'create-fresh-database',
          'drop-only-invocation-created-database',
          'cluster-role-migrations',
          'alter-practicehub-app-role',
        ])
    )
      throw new Error('Local acceptance endpoint/target/role/suite/effect scope mismatch');
    const root = approved.sourceCwd;
    if (!Array.isArray(scope.sourceFiles) || !scope.sourceFiles.length)
      throw new Error('Complete local acceptance source closure required');
    const actual = new Set<string>();
    // Finite product roots only. Refuse links before descent; never follow a source alias.
    function walk(path: string): void {
      const absolute = resolve(root, path);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('Local acceptance source link refused');
      if (stat.isDirectory()) {
        for (const entry of readdirSync(absolute, { withFileTypes: true })) {
          if (entry.name.startsWith('.'))
            throw new Error('Private agent directory is not local acceptance source');
          if (entry.name === 'node_modules') continue; // Third-party graph is admitted separately.
          walk(`${path}/${entry.name}`);
        }
      } else if (stat.isFile()) actual.add(path);
      else if (!stat.isFile()) throw new Error('Local acceptance non-file source refused');
    }
    for (const path of ['modules', 'packages', 'infra/postgres', 'infra/dex', 'tools/local-tools'])
      walk(path);
    for (const path of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.base.json',
    ])
      actual.add(path);
    for (const entry of readdirSync(root, { withFileTypes: true }))
      if (/^(?:vite\.config\.|vitest\.config\.|\.npmrc$|\.pnpmfile\.|\.pnp\.)/.test(entry.name))
        walk(entry.name);
    const expected = new Set(scope.sourceFiles.map((file) => file.path));
    if (
      expected.size !== scope.sourceFiles.length ||
      expected.size !== actual.size ||
      [...actual].some((path) => !expected.has(path))
    )
      throw new Error('Local acceptance source closure changed (including added DB tests)');
    for (const file of scope.sourceFiles) {
      exactFields(file, ['path', 'sha256']);
      if (
        isAbsolute(file.path) ||
        file.path.includes('\\') ||
        file.path.split('/').some((part: string) => !part || part === '.' || part === '..')
      )
        throw new Error('Local acceptance source path must be relative');
      readPinnedFile({ path: resolve(root, file.path), sha256: file.sha256 });
    }
    for (const name of localDbSuites) {
      const pkg = JSON.parse(
        readPinnedFile({
          path: join(root, `modules/${name}/package.json`),
          sha256:
            scope.sourceFiles.find((file) => file.path === `modules/${name}/package.json`)
              ?.sha256 ?? '',
        }).toString('utf8'),
      ) as { name?: string; scripts?: Record<string, string> };
      if (
        pkg.name !== `@practicehub/${name}` ||
        pkg.scripts?.['test:db'] !== 'vitest run --config vitest.db.config.ts' ||
        !expected.has(`modules/${name}/vitest.db.config.ts`) ||
        ![...expected].some(
          (path) => path.startsWith(`modules/${name}/src/`) && path.endsWith('.db.test.ts'),
        )
      )
        throw new Error('Exact delegated package/config/DB collection required');
    }
    for (const path of [
      'infra/dex/config.yaml',
      'modules/identity/src/federation.ts',
      'modules/identity/src/dex.federation.test.ts',
      'modules/identity/vitest.federation.config.ts',
      'modules/payments-ledger/src/db-test-harness.ts',
      'infra/postgres/init/001-bootstrap.sql',
    ])
      if (!expected.has(path)) throw new Error('Missing endpoint/helper/SQL pin');
    const identityPackage = JSON.parse(
      readPinnedFile({
        path: join(root, 'modules/identity/package.json'),
        sha256:
          scope.sourceFiles.find((file) => file.path === 'modules/identity/package.json')?.sha256 ??
          '',
      }).toString('utf8'),
    ) as { scripts?: Record<string, string> };
    if (
      identityPackage.scripts?.['test:federation'] !==
      'vitest run --config vitest.federation.config.ts'
    )
      throw new Error('Exact federation command required');
    exactFields(scope.runtime.node, ['path', 'sha256']);
    exactFields(scope.runtime.pnpm, ['path', 'sha256']);
    if (!isAbsolute(scope.runtime.node.path) || !isAbsolute(scope.runtime.pnpm.path))
      throw new Error('Exact pinned Node and pnpm entry paths required');
    readPinnedFile(scope.runtime.node);
    readPinnedFile(scope.runtime.pnpm);
    return scope;
  }

  async function localScalar(
    query: string,
    captured?: { target?: MigrationTarget },
  ): Promise<string> {
    const target = await migrationPreflight();
    if (captured) captured.target = target;
    await inspectService('app-postgres');
    await admitLane();
    activePsqlSql(query);
    // The final bindDocker callback may queue a mutation across that await.
    // Re-read the complete lane and scope synchronously at the SQL boundary.
    const current = loadLaneConfiguration(migrationOptions.laneBinding);
    if (JSON.stringify(current) !== admittedLaneIdentity)
      throw new Error('Lane changed before local SQL dispatch');
    requireDelegatedEndpointScope(current);
    const result = await migrationTransport.execute(target, Buffer.from(query), {
      timeoutMs: migrationOptions.timeoutMs ?? 110000,
      cleanupMs: migrationOptions.cleanupMs ?? 10000,
    });
    if (result.status !== 0) throw new Error(`Local SQL failed: ${result.stderr}`);
    return result.stdout.trim();
  }

  async function runLocalAcceptanceSuites(federation = false): Promise<void> {
    // This existing CLI seam is also exposed for injected-transport routing controls.
    const approved = loadLaneConfiguration(migrationOptions.laneBinding);
    requireDelegatedEndpointScope(approved);
    localAcceptanceActive = true;
    const names = federation ? ['identity'] : [...localDbSuites];
    let suiteTarget: MigrationTarget | undefined;
    let suiteScope: LocalAcceptanceScope | undefined;
    for (const [index, name] of names.entries()) {
      if (index === 0) {
        suiteTarget = await migrationPreflight();
        await inspectService('app-postgres');
        if (federation) await inspectService('dex');
        // The supervised SQL transport verifies CID/SID/database/owner on this read,
        // before the endpoint-bound child. Mock success is only routing evidence.
        await localScalar('SELECT 1;');
      } else if (suiteTarget) {
        const result = await migrationTransport.execute(suiteTarget, Buffer.from('SELECT 1;'), {
          timeoutMs: migrationOptions.timeoutMs ?? 110000,
          cleanupMs: migrationOptions.cleanupMs ?? 10000,
        });
        if (result.status !== 0) throw new Error(`Local SQL failed: ${result.stderr}`);
      }
      if (index === 0)
        suiteScope = requireDelegatedEndpointScope(
          loadLaneConfiguration(migrationOptions.laneBinding),
        );
      const scope = suiteScope;
      if (!scope) throw new Error('Local acceptance scope missing before delegated suite');
      const env: NodeJS.ProcessEnv = {
        SystemRoot: process.env['SystemRoot'],
        WINDIR: process.env['WINDIR'],
        COMSPEC: process.env['COMSPEC'],
        TEMP: process.env['TEMP'],
        TMP: process.env['TMP'],
        PATH: dirname(scope.runtime.node.path),
        NODE_OPTIONS: '--no-global-search-paths',
        PRACTICEHUB_DB_HOST: scope.database.host,
        PRACTICEHUB_DB_PORT: String(scope.database.port),
        PRACTICEHUB_LEDGER_DB_PROOF: 'synthetic-isolated',
        PRACTICEHUB_LEDGER_DB_RUN: scope.ledger.run,
      };
      const args = [
        '--no-global-search-paths',
        scope.runtime.pnpm.path,
        '--filter',
        `@practicehub/${name}`,
        'run',
        federation ? 'test:federation' : 'test:db',
      ];
      const result = processTransport(scope.runtime.node.path, args, {
        cwd: scope.sourceCwd,
        timeout: 110000,
        encoding: 'utf8',
        env,
        stdio: 'inherit',
        shell: false,
      });
      if (result.status !== 0)
        throw new Error(`Delegated ${name} failed: ${String(result.status)}`);
      requireDelegatedEndpointScope(loadLaneConfiguration(migrationOptions.laneBinding));
    }
  }

  async function testLocal(): Promise<void> {
    insideTestLocal = true;
    testLocalSimAdmitted = false;
    try {
      const approved = loadLaneConfiguration(migrationOptions.laneBinding);
      requireDelegatedEndpointScope(approved);
      localAcceptanceActive = true;
      await migrationPreflight();
      for (const name of Object.keys(approved.services)) await inspectService(name);
      const expected = new Set([
        'app-postgres',
        'dex',
        'mailpit',
        'medplum-app',
        'medplum-postgres',
        'medplum-redis',
        'medplum-server',
        'minio',
        'otel-lgtm',
        'vendor-simulator',
      ]);
      const services = new Map(
        (await migrationCommand([...composeArgs, 'ps', '--format', 'json']))
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => {
            const service = JSON.parse(line) as {
              Health?: string;
              Service: string;
              State: string;
            };
            return [service.Service, service] as const;
          }),
      );
      const missing = [...expected].filter((service) => !services.has(service));
      if (missing.length > 0) {
        throw new Error(`local stack missing services: ${missing.join(', ')}`);
      }
      const unhealthy = [...expected].filter((name) => {
        const service = services.get(name);
        return service?.State !== 'running' || service.Health !== 'healthy';
      });
      if (unhealthy.length > 0) {
        throw new Error(`local stack has unhealthy services: ${unhealthy.join(', ')}`);
      }

      const tenantRows = (
        await localScalar(
          "SELECT tenant_id || ':' || bootstrap_capability_state FROM platform_core.synthetic_tenant ORDER BY tenant_id;",
        )
      )
        .split(/\r?\n/)
        .filter(Boolean);
      const expectedTenantRows = ['northwind-synthetic:simulated', 'riverbend-synthetic:disabled'];
      if (tenantRows.join('|') !== expectedTenantRows.join('|')) {
        throw new Error(`synthetic tenant states differ: ${tenantRows.join(', ')}`);
      }

      let probes = 0;
      const captured: { target?: MigrationTarget } = {};
      const scalar = async (query: string): Promise<string> => {
        probes += 1;
        if (probes > 1 && captured.target) {
          const result = await migrationTransport.execute(captured.target, Buffer.from(query), {
            timeoutMs: migrationOptions.timeoutMs ?? 110000,
            cleanupMs: migrationOptions.cleanupMs ?? 10000,
          });
          if (result.status !== 0) throw new Error(`Local SQL failed: ${result.stderr}`);
          return result.stdout.trim();
        }
        return localScalar(query, captured);
      };

      // NR-022 (ADR-ADJ-008 §5): RLS coverage and watermark are derived from the
      // LIVE CATALOG, never a hand-maintained list — a module schema is one that
      // carries a `synthetic`-column base table, so a new module's tables are
      // covered by construction. A hand-extended probe list is a REOPEN-class
      // finding; these two queries are the mechanical carrier.
      const moduleSchemaSubquery =
        'SELECT DISTINCT n2.nspname FROM pg_attribute a ' +
        'JOIN pg_class c2 ON c2.oid = a.attrelid ' +
        'JOIN pg_namespace n2 ON n2.oid = c2.relnamespace ' +
        "WHERE a.attname = 'synthetic' AND a.attnum > 0 AND NOT a.attisdropped AND c2.relkind = 'r'";

      // WP-010/WP-013/WP-020/WP-018: forced RLS on every table in every module
      // schema (module schemas derived from the catalog).
      const unprotected = await scalar(
        'SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
          "WHERE c.relkind = 'r' " +
          `AND n.nspname IN (${moduleSchemaSubquery}) ` +
          'AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);',
      );
      if (unprotected !== '0') {
        throw new Error(`module schemas have ${unprotected} table(s) without forced RLS`);
      }

      // Synthetic watermark on every seeded row of every catalog-declared
      // synthetic-carrying table (union built from the catalog, not by hand).
      const watermarkTables = (
        await scalar(
          "SELECT string_agg(quote_ident(n.nspname) || '.' || quote_ident(c.relname), '|' " +
            'ORDER BY n.nspname, c.relname) ' +
            'FROM pg_attribute a ' +
            'JOIN pg_class c ON c.oid = a.attrelid ' +
            'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
            "WHERE a.attname = 'synthetic' AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r';",
        )
      )
        .split('|')
        .filter(Boolean);
      if (watermarkTables.length === 0) {
        throw new Error('watermark probe found no synthetic-carrying module tables');
      }
      const unwatermarked = await scalar(
        `SELECT ${watermarkTables
          .map((table) => `(SELECT count(*) FROM ${table} WHERE synthetic IS DISTINCT FROM true)`)
          .join(' + ')};`,
      );
      if (unwatermarked !== '0') {
        throw new Error(
          `module schemas hold ${unwatermarked} row(s) without the synthetic watermark`,
        );
      }

      // WP-011: the jurisdiction registry is seeded and complete — the floor and
      // unknown packs present AND effective (ADR-ADJ-002 semantics 3: the
      // fail-closed substrate must be effective at every queriable as-of, so a
      // future-dated-only floor/unknown is a failure, not a fallback), and every
      // pack covering all 12 topics.
      const missingRequiredPacks = await scalar(
        "SELECT count(*) FROM (VALUES ('floor'), ('unknown')) AS required(jurisdiction) " +
          'WHERE NOT EXISTS (SELECT FROM platform_core.jurisdiction_rule_pack p ' +
          'WHERE p.jurisdiction = required.jurisdiction AND p.effective_on <= current_date);',
      );
      if (missingRequiredPacks !== '0') {
        throw new Error(
          'jurisdiction registry is missing an effective floor and/or unknown safe-default pack',
        );
      }
      const incompletePacks = await scalar(
        'SELECT count(*) FROM platform_core.jurisdiction_rule_pack p ' +
          'WHERE (SELECT count(*) FROM platform_core.jurisdiction_rule r ' +
          'WHERE r.jurisdiction = p.jurisdiction AND r.pack_version = p.version) <> 12;',
      );
      if (incompletePacks !== '0') {
        throw new Error(`${incompletePacks} jurisdiction pack(s) do not cover all 12 topics`);
      }

      // WP-012: capability registry seeded with the opposite-state tenant proof.
      const capabilityStates = await scalar(
        "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
          "FROM platform_core.capability_grant WHERE capability_id = 'platform.capability-registry';",
      );
      const expectedCapabilityStates = 'northwind-synthetic:simulated,riverbend-synthetic:disabled';
      if (capabilityStates !== expectedCapabilityStates) {
        throw new Error(`capability registry tenant states differ: ${capabilityStates}`);
      }

      // WP-012: the grant projection matches the append-only event log both ways.
      const orphanGrants = await scalar(
        'SELECT count(*) FROM platform_core.capability_grant g ' +
          'WHERE g.since_event_id IS NOT NULL AND NOT EXISTS (' +
          'SELECT FROM platform_core.capability_event e ' +
          'WHERE e.event_id = g.since_event_id AND e.tenant_id = g.tenant_id ' +
          'AND e.capability_id = g.capability_id AND e.scope_key = g.scope_key ' +
          'AND e.to_state = g.state ' +
          'AND e.seq = (SELECT max(e2.seq) FROM platform_core.capability_event e2 ' +
          'WHERE e2.tenant_id = g.tenant_id AND e2.capability_id = g.capability_id ' +
          'AND e2.scope_key = g.scope_key));',
      );
      const orphanStreams = await scalar(
        'SELECT count(*) FROM (' +
          'SELECT DISTINCT ON (tenant_id, capability_id, scope_key) ' +
          'tenant_id, capability_id, scope_key, to_state ' +
          'FROM platform_core.capability_event ' +
          'ORDER BY tenant_id, capability_id, scope_key, seq DESC) latest ' +
          'WHERE NOT EXISTS (SELECT FROM platform_core.capability_grant g ' +
          'WHERE g.tenant_id = latest.tenant_id AND g.capability_id = latest.capability_id ' +
          'AND g.scope_key = latest.scope_key AND g.state = latest.to_state);',
      );
      if (orphanGrants !== '0' || orphanStreams !== '0') {
        throw new Error(
          `capability projection out of sync: orphan_grants=${orphanGrants} orphan_streams=${orphanStreams}`,
        );
      }

      // WP-013: the standing shared-endpoint proof — the seeded household phone
      // and email each attach to exactly two DISTINCT persons, and both persons
      // exist as separate rows (a shared endpoint is never a person).
      const sharedEndpointPersons = await scalar(
        "SELECT string_agg(persons::text, ',' ORDER BY endpoint_id) FROM (" +
          'SELECT a.endpoint_id, count(DISTINCT a.person_id) AS persons ' +
          'FROM identity.endpoint_association a ' +
          "WHERE a.tenant_id = 'northwind-synthetic' " +
          "AND a.endpoint_id IN ('nce-rivera-email', 'nce-rivera-phone') " +
          'GROUP BY a.endpoint_id) shared;',
      );
      if (sharedEndpointPersons !== '2,2') {
        throw new Error(
          `shared-endpoint standing proof broken: association counts ${sharedEndpointPersons}`,
        );
      }
      const sharedEndpointDistinctPersons = await scalar(
        'SELECT count(*) FROM identity.person ' +
          "WHERE tenant_id = 'northwind-synthetic' " +
          "AND person_id IN ('np-alex-rivera', 'np-casey-rivera');",
      );
      if (sharedEndpointDistinctPersons !== '2') {
        throw new Error(
          'shared-endpoint standing proof broken: the household persons are not two distinct rows',
        );
      }

      // WP-014: the staff-MFA structural invariant holds at rest — no staff
      // session below aal2 exists in the live database (DB CHECK backs it; this
      // probe proves the CHECK is actually deployed).
      const subMfaStaffSessions = await scalar(
        "SELECT count(*) FROM identity.auth_session WHERE principal = 'staff' AND assurance <> 'aal2';",
      );
      if (subMfaStaffSessions !== '0') {
        throw new Error(
          `${subMfaStaffSessions} staff session(s) below aal2 — staff MFA is mandatory`,
        );
      }

      // WP-014: per-role session policies are seeded for tenant 1 while tenant 2
      // deliberately carries none — the fail-to-stricter default is Riverbend's
      // posture (REQ-ID-024 exception 3), the standing opposite-config proof.
      const sessionPolicyRows = await scalar(
        "SELECT string_agg(tenant_id || ':' || cnt, ',' ORDER BY tenant_id) FROM (" +
          'SELECT tenant_id, count(*) AS cnt FROM platform_core.tenant_config ' +
          "WHERE namespace = 'policy' AND key LIKE 'session-policy:%' GROUP BY tenant_id) p;",
      );
      if (sessionPolicyRows !== 'northwind-synthetic:3') {
        throw new Error(`session-policy config posture differs: ${sessionPolicyRows}`);
      }

      // WP-014: the authn capability sits at the package ceiling with the
      // opposite-state tenant proof (northwind scaffolded, riverbend disabled).
      const authnCapabilityStates = await scalar(
        "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
          "FROM platform_core.capability_grant WHERE capability_id = 'identity.authn';",
      );
      if (authnCapabilityStates !== 'northwind-synthetic:scaffolded,riverbend-synthetic:disabled') {
        throw new Error(`authn capability tenant states differ: ${authnCapabilityStates}`);
      }

      // WP-016: merge governance standing proofs. Case posture — one resolved
      // acquisition merge plus one open specialized-pattern collision on tenant 1,
      // one open Riverbend case for the cross-tenant negatives.
      const mergeCaseStates = await scalar(
        "SELECT string_agg(tenant_id || ':' || status, ',' ORDER BY tenant_id, case_id) " +
          'FROM identity.merge_case;',
      );
      const expectedMergeCaseStates =
        'northwind-synthetic:resolved-merged,northwind-synthetic:open,riverbend-synthetic:open';
      if (mergeCaseStates !== expectedMergeCaseStates) {
        throw new Error(`merge case posture differs: ${mergeCaseStates}`);
      }

      // WP-016: alias preservation — the merged-away legacy identifier still
      // resolves, to the SURVIVOR, and its re-attribution lineage row exists
      // (REQ-ID-009 AC-2; the merge stays reversible from its lineage).
      const aliasProof = await scalar(
        "SELECT s.person_id || '|' || (" +
          'SELECT count(*) FROM identity.merge_lineage l ' +
          "WHERE l.artifact_kind = 'source-identifier' " +
          "AND l.artifact_ref = 'legacy-lakeside:lg-000778' " +
          "AND l.disposition = 're-attributed') " +
          'FROM identity.source_identifier s ' +
          "WHERE s.source_system = 'legacy-lakeside' AND s.source_value = 'lg-000778';",
      );
      if (aliasProof !== 'np-sam-porter|1') {
        throw new Error(`merge alias-preservation proof broken: ${aliasProof}`);
      }

      // WP-016: case<->event projection sync, both directions — every
      // resolved-merged case names a matching merge event; every merge event's
      // case is resolved-merged naming it back.
      const orphanMergedCases = await scalar(
        'SELECT count(*) FROM identity.merge_case c ' +
          "WHERE c.status = 'resolved-merged' AND NOT EXISTS (" +
          'SELECT FROM identity.merge_event e ' +
          'WHERE e.tenant_id = c.tenant_id AND e.event_id = c.merge_event_id ' +
          "AND e.kind = 'merge' AND e.case_id = c.case_id);",
      );
      const orphanMergeEvents = await scalar(
        'SELECT count(*) FROM identity.merge_event e ' +
          "WHERE e.kind = 'merge' " +
          'AND NOT EXISTS (SELECT FROM identity.merge_event u ' +
          "WHERE u.kind = 'unmerge' AND u.tenant_id = e.tenant_id " +
          'AND u.reverses_event_id = e.event_id) ' +
          'AND NOT EXISTS (SELECT FROM identity.merge_case c ' +
          'WHERE c.tenant_id = e.tenant_id AND c.case_id = e.case_id ' +
          "AND c.status = 'resolved-merged' AND c.merge_event_id = e.event_id);",
      );
      if (orphanMergedCases !== '0' || orphanMergeEvents !== '0') {
        throw new Error(
          `merge projection out of sync: orphan_cases=${orphanMergedCases} ` +
            `orphan_events=${orphanMergeEvents}`,
        );
      }

      // WP-016: the merge-governance capability sits at the package ceiling with
      // the opposite-state tenant proof (northwind scaffolded, riverbend disabled).
      const mergeCapabilityStates = await scalar(
        "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
          "FROM platform_core.capability_grant WHERE capability_id = 'identity.merge-governance';",
      );
      if (mergeCapabilityStates !== 'northwind-synthetic:scaffolded,riverbend-synthetic:disabled') {
        throw new Error(`merge capability tenant states differ: ${mergeCapabilityStates}`);
      }

      // WP-015: PDP posture — Northwind carries the 8 canonical v1 role
      // templates while Riverbend deliberately carries NONE (an unresolvable
      // template is a deny; tenant 2 is the standing deny-by-default proof).
      const roleTemplatePosture = await scalar(
        "SELECT string_agg(tenant_id || ':' || cnt, ',' ORDER BY tenant_id) FROM (" +
          'SELECT tenant_id, count(*) AS cnt FROM identity.role_template GROUP BY tenant_id) t;',
      );
      if (roleTemplatePosture !== 'northwind-synthetic:8') {
        throw new Error(`role-template posture differs: ${roleTemplatePosture}`);
      }

      // WP-015: the deceased chart-lock standing proof — the flag is SET with a
      // recorded confirmation source and no correction (REQ-ID-021 AC-3).
      const deceasedProof = await scalar(
        'SELECT count(*) FROM identity.person_flag ' +
          "WHERE person_id = 'np-riley-fox' AND kind = 'deceased' AND action = 'set' " +
          'AND source_ref IS NOT NULL ' +
          'AND NOT EXISTS (SELECT FROM identity.person_flag c ' +
          "WHERE c.person_id = 'np-riley-fox' AND c.action = 'corrected');",
      );
      if (deceasedProof !== '1') {
        throw new Error(`deceased chart-lock standing proof broken: ${deceasedProof}`);
      }

      // WP-015: GIPA partition standing proofs — a confirmed genetic tag exists
      // and the migrated needs-review row is BLOCKED from release (REQ-ID-019
      // EX-1); a violating row is unrepresentable by CHECK, this probes the live
      // posture.
      const partitionProof = await scalar(
        "SELECT (SELECT count(*) FROM identity.partition_tag WHERE tag = 'gipa-genetic' " +
          "AND review_status <> 'needs-classification-review')::text || '|' || " +
          '(SELECT count(*) FROM identity.partition_tag ' +
          "WHERE review_status = 'needs-classification-review' AND NOT blocked_from_release)::text;",
      );
      if (!/^[1-9][0-9]*\|0$/.test(partitionProof)) {
        throw new Error(`gipa partition standing proof broken: ${partitionProof}`);
      }

      // WP-015: the PDP and GIPA-partition capabilities sit at the package
      // ceiling with the opposite-state tenant proof.
      for (const capabilityId of ['identity.access-policy', 'privacy.gipa-partition']) {
        const states = await scalar(
          "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
            `FROM platform_core.capability_grant WHERE capability_id = '${capabilityId}';`,
        );
        if (states !== 'northwind-synthetic:scaffolded,riverbend-synthetic:disabled') {
          throw new Error(`${capabilityId} capability tenant states differ: ${states}`);
        }
      }

      // WP-020: the audit hash chains are LINKED at rest — no forged genesis, no
      // gap, no prev-hash that fails to name its predecessor's entry hash (the
      // full sha-256 recompute runs in the audit DB suite).
      const chainBreaks = await scalar(
        'SELECT count(*) FROM audit_evidence.audit_event e ' +
          "WHERE (e.chain_seq = 1 AND e.prev_hash <> 'genesis') " +
          'OR (e.chain_seq > 1 AND NOT EXISTS (' +
          'SELECT FROM audit_evidence.audit_event p ' +
          'WHERE p.tenant_id = e.tenant_id AND p.chain_day = e.chain_day ' +
          'AND p.chain_seq = e.chain_seq - 1 AND p.entry_hash = e.prev_hash));',
      );
      if (chainBreaks !== '0') {
        throw new Error(`audit chain linkage broken on ${chainBreaks} row(s) — tamper evidence`);
      }

      // WP-020: standing stream proofs — the seeded access DENY is recorded
      // (deny paths are audited, R6-REQ-001) and the seeded AI interaction
      // carries its model version (R6-REQ-102).
      const auditStreamProof = await scalar(
        "SELECT (SELECT decision FROM audit_evidence.audit_event WHERE tenant_id = 'northwind-synthetic' AND audit_id = 'nae-0002') " +
          "|| '|' || (SELECT model_version FROM audit_evidence.audit_event WHERE tenant_id = 'northwind-synthetic' AND audit_id = 'nae-0003');",
      );
      if (auditStreamProof !== 'deny|claude-sonnet-5-synthetic') {
        throw new Error(`audit stream standing proof broken: ${auditStreamProof}`);
      }

      // WP-020: legal-hold posture — Northwind carries the ACTIVE hold (destruction
      // suspended), Riverbend the RELEASED hold retaining its evidence.
      const holdPosture = await scalar(
        "SELECT string_agg(tenant_id || ':' || status, ',' ORDER BY tenant_id) " +
          'FROM audit_evidence.legal_hold;',
      );
      if (holdPosture !== 'northwind-synthetic:active,riverbend-synthetic:released') {
        throw new Error(`legal-hold posture differs: ${holdPosture}`);
      }

      // WP-020: the counsel-owned retention registry is seeded complete — every
      // record class carries its v1 entry.
      const retentionClasses = await scalar(
        'SELECT count(*) FROM audit_evidence.retention_schedule WHERE version = 1;',
      );
      if (retentionClasses !== '6') {
        throw new Error(`retention schedule covers ${retentionClasses} of 6 record classes`);
      }

      // WP-020: the audit-store capability sits at the package ceiling with the
      // opposite-state tenant proof (northwind scaffolded, riverbend disabled).
      const auditCapabilityStates = await scalar(
        "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
          "FROM platform_core.capability_grant WHERE capability_id = 'platform.audit-store';",
      );
      if (auditCapabilityStates !== 'northwind-synthetic:scaffolded,riverbend-synthetic:disabled') {
        throw new Error(`audit capability tenant states differ: ${auditCapabilityStates}`);
      }

      // WP-018: the consent-operational capability sits at the package ceiling with
      // the opposite-state tenant proof (northwind scaffolded, riverbend disabled).
      const consentCapabilityStates = await scalar(
        "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
          "FROM platform_core.capability_grant WHERE capability_id = 'consent.operational';",
      );
      if (
        consentCapabilityStates !== 'northwind-synthetic:scaffolded,riverbend-synthetic:disabled'
      ) {
        throw new Error(`consent capability tenant states differ: ${consentCapabilityStates}`);
      }

      // WP-018: STOP standing proof — the seeded sms/marketing consent is opted_out
      // by a STOP keyword (R6-REQ-072 / REQ-COMM-005), while sms/treatment stays
      // opted_in (care is not dropped).
      const stopPosture = await scalar(
        "SELECT string_agg(purpose || '=' || current_state, ',' ORDER BY purpose) " +
          'FROM consent.consent_state ' +
          "WHERE person_ref = 'np-sam-porter' AND channel = 'sms';",
      );
      if (stopPosture !== 'marketing=opted_out,treatment=opted_in') {
        throw new Error(`consent STOP standing proof broken: ${stopPosture}`);
      }

      // WP-018: genetic disclosure authorization standing proof (R6-SR-031) — a
      // genetic grant exists and carries specific written authorization evidence;
      // and the MHRA lapsed-consent standing proof (R6-SR-041) — a disclosure
      // consent past its expiry is on record (canSend/port treat it expired).
      const consentObligationProof = await scalar(
        "SELECT (SELECT count(*) FROM consent.consent_event WHERE record_type = 'genetic' " +
          "AND action = 'grant' AND evidence_ref IS NOT NULL)::text || '|' || " +
          '(SELECT count(*) FROM consent.consent_state ' +
          "WHERE scope_type = 'disclosure' AND expires_at IS NOT NULL AND expires_at <= now())::text;",
      );
      if (!/^[1-9][0-9]*\|[1-9][0-9]*$/.test(consentObligationProof)) {
        throw new Error(`consent obligation standing proof broken: ${consentObligationProof}`);
      }

      // WP-018: the consent projection matches the folded event log — every state
      // row names the latest-effective event for its (person, scope) AND carries
      // that event's resulting state; every scope in the log has a state row.
      const orphanConsentStates = await scalar(
        'SELECT count(*) FROM consent.consent_state s WHERE NOT EXISTS (' +
          'SELECT FROM consent.consent_event e WHERE e.tenant_id = s.tenant_id ' +
          'AND e.consent_event_id = s.last_event_id AND e.person_ref = s.person_ref ' +
          'AND e.scope_key = s.scope_key AND e.resulting_state = s.current_state ' +
          'AND e.effective_at = (SELECT max(e2.effective_at) FROM consent.consent_event e2 ' +
          'WHERE e2.tenant_id = s.tenant_id AND e2.person_ref = s.person_ref ' +
          'AND e2.scope_key = s.scope_key));',
      );
      const orphanConsentScopes = await scalar(
        'SELECT count(*) FROM (SELECT DISTINCT tenant_id, person_ref, scope_key ' +
          'FROM consent.consent_event) e WHERE NOT EXISTS (' +
          'SELECT FROM consent.consent_state s WHERE s.tenant_id = e.tenant_id ' +
          'AND s.person_ref = e.person_ref AND s.scope_key = e.scope_key);',
      );
      if (orphanConsentStates !== '0' || orphanConsentScopes !== '0') {
        throw new Error(
          `consent projection out of sync: orphan_states=${orphanConsentStates} ` +
            `orphan_scopes=${orphanConsentScopes}`,
        );
      }

      // WP-021: the event-spine capability sits at the package ceiling with the
      // opposite-state tenant proof (northwind scaffolded, riverbend disabled).
      const eventSpineCapabilityStates = await scalar(
        "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
          "FROM platform_core.capability_grant WHERE capability_id = 'platform.event-spine';",
      );
      if (
        eventSpineCapabilityStates !== 'northwind-synthetic:scaffolded,riverbend-synthetic:disabled'
      ) {
        throw new Error(
          `event-spine capability tenant states differ: ${eventSpineCapabilityStates}`,
        );
      }

      // WP-021: the seeded outbox posture holds at rest — three outbox events, two
      // published deliveries, two inbox dedup rows, and every outbox event carries a
      // delivery row (projection completeness; a published delivery is delivered
      // exactly once and never re-sent on replay).
      const eventSpinePosture = await scalar(
        "SELECT (SELECT count(*) FROM events.outbox WHERE tenant_id = 'northwind-synthetic')::text " +
          "|| '|' || (SELECT count(*) FROM events.outbox_delivery " +
          "WHERE tenant_id = 'northwind-synthetic' AND status = 'published')::text " +
          "|| '|' || (SELECT count(*) FROM events.inbox WHERE tenant_id = 'northwind-synthetic')::text " +
          "|| '|' || (SELECT count(*) FROM events.outbox o WHERE NOT EXISTS (" +
          'SELECT FROM events.outbox_delivery d ' +
          'WHERE d.tenant_id = o.tenant_id AND d.event_id = o.event_id))::text;',
      );
      if (eventSpinePosture !== '3|2|2|0') {
        throw new Error(`event-spine posture differs: ${eventSpinePosture}`);
      }

      // WP-019: the policy/clock capability sits at the package ceiling with the
      // opposite-state tenant proof (northwind scaffolded, riverbend disabled).
      const policyClockCapabilityStates = await scalar(
        "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
          "FROM platform_core.capability_grant WHERE capability_id = 'consent.policy-clocks';",
      );
      if (
        policyClockCapabilityStates !==
        'northwind-synthetic:scaffolded,riverbend-synthetic:disabled'
      ) {
        throw new Error(
          `policy-clocks capability tenant states differ: ${policyClockCapabilityStates}`,
        );
      }

      // WP-019: the obligation-clock policy registry is seeded complete — every
      // obligation type carries an EFFECTIVE floor policy (ADR-ADJ-002 semantics 3:
      // the federal fail-closed floor must be effective at every queriable as-of).
      const missingClockFloors = await scalar(
        "SELECT count(*) FROM (VALUES ('breach-notification'), ('mhra-renewal'), " +
          "('records-request-closure'), ('rule-pack-review')) AS required(obligation_type) " +
          'WHERE NOT EXISTS (SELECT FROM consent.obligation_clock_policy p ' +
          'WHERE p.obligation_type = required.obligation_type AND p.jurisdiction = ' +
          "'floor' " +
          'AND p.effective_on <= current_date);',
      );
      if (missingClockFloors !== '0') {
        throw new Error(
          'obligation-clock policy registry is missing an effective floor policy for an obligation type',
        );
      }

      // WP-019: clock standing proofs — the FL breach clock runs the stricter 30-day
      // window (C-05 obligation × jurisdiction beats the 60-day floor), the
      // statute-tracker clock is escalated (its worklist opened, R6-SR-102), and the
      // records-access clock is satisfied with closure evidence (R6-REQ-010).
      const clockPosture = await scalar(
        'SELECT (SELECT EXTRACT(DAY FROM (due_at - triggered_at))::int::text ' +
          "FROM consent.obligation_clock WHERE clock_id = 'ncl-breach-0001') || '|' || " +
          "(SELECT status FROM consent.obligation_clock WHERE clock_id = 'ncl-tracker-0001') || '|' || " +
          "(SELECT status FROM consent.obligation_clock WHERE clock_id = 'ncl-access-0001');",
      );
      if (clockPosture !== '30|escalated|satisfied') {
        throw new Error(`obligation-clock standing posture differs: ${clockPosture}`);
      }

      // WP-019: the clock projection matches the append-only event log — every clock
      // names its latest event in the same tenant (materialized read model, not a
      // second source of truth).
      const orphanClocks = await scalar(
        'SELECT count(*) FROM consent.obligation_clock c WHERE NOT EXISTS (' +
          'SELECT FROM consent.obligation_clock_event e WHERE e.tenant_id = c.tenant_id ' +
          'AND e.clock_event_id = c.last_event_id AND e.clock_id = c.clock_id);',
      );
      if (orphanClocks !== '0') {
        throw new Error(`obligation-clock projection out of sync: orphan_clocks=${orphanClocks}`);
      }

      // WP-022: the tasking-engine capability sits at the package ceiling with the
      // opposite-state tenant proof (northwind scaffolded, riverbend disabled).
      const taskingCapabilityStates = await scalar(
        "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
          "FROM platform_core.capability_grant WHERE capability_id = 'platform.tasking-engine';",
      );
      if (
        taskingCapabilityStates !== 'northwind-synthetic:scaffolded,riverbend-synthetic:disabled'
      ) {
        throw new Error(
          `tasking-engine capability tenant states differ: ${taskingCapabilityStates}`,
        );
      }

      // WP-022: the William standing proof (R8 §5.5) holds at rest — the escalated
      // owned thread was reassigned (owner=maya, prior owner william demoted to a
      // watcher, single owner preserved), its next_response timer PAUSED by the
      // holding reply, and a resolution timer started.
      const williamPosture = await scalar(
        "SELECT owner_ref || '|' || priority || '|' || escalated::text || '|' || " +
          "(watchers ? 'synthetic-guide:william')::text || '|' || " +
          "(SELECT state FROM events.sla_timer WHERE work_item_id = 'wi-thread-william-0001' " +
          "AND timer_type = 'next_response') || '|' || " +
          "(SELECT state FROM events.sla_timer WHERE work_item_id = 'wi-thread-william-0001' " +
          "AND timer_type = 'resolution') " +
          "FROM events.work_item WHERE work_item_id = 'wi-thread-william-0001';",
      );
      if (williamPosture !== 'synthetic-guide:maya|high|true|true|paused|running') {
        throw new Error(`William standing proof broken: ${williamPosture}`);
      }

      // WP-022: the unmatched first-touch proof — an unowned inbound WorkItem with a
      // running first_response timer (the gate's "unmatched first-touch timer").
      const unmatchedPosture = await scalar(
        "SELECT (owner_ref IS NULL)::text || '|' || status || '|' || " +
          "(SELECT state FROM events.sla_timer WHERE work_item_id = 'wi-thread-unmatched-0002' " +
          "AND timer_type = 'first_response') " +
          "FROM events.work_item WHERE work_item_id = 'wi-thread-unmatched-0002';",
      );
      if (unmatchedPosture !== 'true|unmatched|running') {
        throw new Error(`unmatched first-touch proof broken: ${unmatchedPosture}`);
      }

      // WP-022: the SLA policy registry is seeded — northwind carries the concierge
      // policy effective as-of today (the engine has a policy to enforce).
      const conciergePolicy = await scalar(
        "SELECT count(*)::text FROM events.sla_policy WHERE tenant_id = 'northwind-synthetic' " +
          "AND policy_id = 'sla-concierge' AND effective_on <= current_date;",
      );
      if (conciergePolicy === '0') {
        throw new Error('SLA policy registry is missing an effective concierge policy');
      }

      // WP-022: the work_item projection matches the folded event log — every item's
      // last_event_seq names its highest event in the same tenant (materialized read
      // model, not a second source of truth), and every event-bearing item has a row.
      const orphanWorkItems = await scalar(
        'SELECT count(*) FROM events.work_item w WHERE w.last_event_seq <> (' +
          'SELECT COALESCE(max(e.event_seq), 0) FROM events.work_item_event e ' +
          'WHERE e.tenant_id = w.tenant_id AND e.work_item_id = w.work_item_id);',
      );
      if (orphanWorkItems !== '0') {
        throw new Error(`work_item projection out of sync: orphan_items=${orphanWorkItems}`);
      }

      // WP-017: the break-glass capability sits at the package ceiling with the
      // opposite-state tenant proof (northwind scaffolded, riverbend disabled).
      const breakGlassCapabilityStates = await scalar(
        "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
          "FROM platform_core.capability_grant WHERE capability_id = 'identity.break-glass';",
      );
      if (
        breakGlassCapabilityStates !== 'northwind-synthetic:scaffolded,riverbend-synthetic:disabled'
      ) {
        throw new Error(
          `break-glass capability tenant states differ: ${breakGlassCapabilityStates}`,
        );
      }

      // WP-017: the break-glass review queue standing proof (R6-REQ-003) — one
      // grant carries its INDEPENDENT review (reviewer <> accessor) and one grant
      // is still UNREVIEWED (ages on the compliance worklist).
      const breakGlassReviewPosture = await scalar(
        "SELECT (SELECT count(*) FROM identity.break_glass_grant WHERE tenant_id = 'northwind-synthetic')::text " +
          "|| '|' || (SELECT count(*) FROM identity.break_glass_review r " +
          'JOIN identity.break_glass_grant g ON g.tenant_id = r.tenant_id AND g.grant_id = r.grant_id ' +
          'WHERE r.reviewer_person_id <> g.accessor_person_id)::text ' +
          "|| '|' || (SELECT count(*) FROM identity.break_glass_grant g " +
          "WHERE g.tenant_id = 'northwind-synthetic' AND NOT EXISTS (" +
          'SELECT FROM identity.break_glass_review r ' +
          'WHERE r.tenant_id = g.tenant_id AND r.grant_id = g.grant_id))::text;',
      );
      if (breakGlassReviewPosture !== '2|1|1') {
        throw new Error(`break-glass review posture differs: ${breakGlassReviewPosture}`);
      }

      // WP-017: the abrupt-departure offboarding standing proof (REQ-ID-028) — the
      // abrupt case revokes the EPCS token, and every owned item is reassigned
      // (zero orphaned: reassignment rows exist for both cases).
      const offboardingPosture = await scalar(
        "SELECT (SELECT (revoked_scopes @> ARRAY['sessions','credentials','epcs-token']::text[])::text " +
          "FROM identity.offboarding_case WHERE offboarding_id = 'noff-0002') " +
          "|| '|' || (SELECT count(*)::text FROM identity.offboarding_reassignment " +
          "WHERE tenant_id = 'northwind-synthetic');",
      );
      if (offboardingPosture !== 'true|3') {
        throw new Error(`offboarding standing proof differs: ${offboardingPosture}`);
      }

      // WP-017: the access-anomaly standing proof (REQ-ADM-019) — an OPEN snooping
      // case with a non-empty forensic signal set exists.
      const anomalyPosture = await scalar(
        'SELECT count(*) FROM identity.access_anomaly_case ' +
          "WHERE tenant_id = 'northwind-synthetic' AND pattern = 'snooping-access' " +
          "AND status = 'open' AND jsonb_array_length(signals) >= 1;",
      );
      if (anomalyPosture !== '1') {
        throw new Error(`access-anomaly standing proof differs: ${anomalyPosture}`);
      }

      // WP-017: the recertification standing proof (REQ-ADM-018) — a REVOKED
      // attestation (drift acted on) is on record.
      const recertPosture = await scalar(
        'SELECT count(*) FROM identity.access_recertification ' +
          "WHERE tenant_id = 'northwind-synthetic' AND decision = 'revoked';",
      );
      if (recertPosture !== '1') {
        throw new Error(`recertification standing proof differs: ${recertPosture}`);
      }

      // WP-023: the provisioned 24/7 on-call rotation stands (REQ-ADM-016) — the
      // northwind concierge rotation is 24x7, riverbend's is business-mode (opposite
      // posture), and neither leaks across the tenant boundary.
      const onCallRotationPosture = await scalar(
        "SELECT string_agg(tenant_id || ':' || coverage_mode, ',' ORDER BY tenant_id) " +
          "FROM events.on_call_rotation WHERE rotation_id IN ('oncall-concierge-nv', 'oncall-rb');",
      );
      if (onCallRotationPosture !== 'northwind-synthetic:24x7,riverbend-synthetic:business') {
        throw new Error(`on-call rotation posture differs: ${onCallRotationPosture}`);
      }

      // WP-023: the coverage-gap alert standing proof (REQ-ADM-041) — an OPEN gap for
      // the vacated overnight window is on the northwind board.
      const gapAlertPosture = await scalar(
        'SELECT count(*) FROM events.coverage_gap_alert ' +
          "WHERE tenant_id = 'northwind-synthetic' AND status = 'open' " +
          "AND detected_reason = 'vacated-slot';",
      );
      if (gapAlertPosture !== '1') {
        throw new Error(`coverage-gap alert standing proof differs: ${gapAlertPosture}`);
      }

      // WP-023: the coverage/PTO handoff standing proof (REQ-TASK-020) — a
      // pto-coverage handoff of two owned threads with context is recorded, and its
      // item_count matches its manifest length (the CHECK is DB-enforced too).
      const handoffPosture = await scalar(
        "SELECT (item_count = jsonb_array_length(context_manifest))::text || '|' || item_count::text " +
          "FROM events.coverage_handoff WHERE tenant_id = 'northwind-synthetic' " +
          "AND handoff_id = 'handoff-noor-pto-0001';",
      );
      if (handoffPosture !== 'true|2') {
        throw new Error(`coverage handoff standing proof differs: ${handoffPosture}`);
      }

      // WP-024: document intake landed at its package ceiling `scaffolded` with the
      // opposite-state tenant proof (northwind scaffolded, riverbend disabled).
      const documentsCapabilityStates = await scalar(
        "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
          "FROM platform_core.capability_grant WHERE capability_id = 'documents.intake';",
      );
      if (
        documentsCapabilityStates !== 'northwind-synthetic:scaffolded,riverbend-synthetic:disabled'
      ) {
        throw new Error(`documents capability tenant states differ: ${documentsCapabilityStates}`);
      }

      // WP-024: quarantine standing proof (REQ-DOC-006) — the wrong-patient record
      // is quarantined with a reason and holds attribute NAMES only (never values).
      const quarantinePosture = await scalar(
        "SELECT status || '|' || quarantine_reason FROM documents.document_state " +
          "WHERE tenant_id = 'northwind-synthetic' AND document_id = 'nd-0002';",
      );
      if (quarantinePosture !== 'quarantined|wrong-patient') {
        throw new Error(`documents quarantine standing proof differs: ${quarantinePosture}`);
      }

      // WP-024: the unknown-patient hold timer at rest (REQ-DOC-010/011) — an
      // unmatched document still on hold beside an over-held one disposed by return.
      const documentHoldPosture = await scalar(
        "SELECT (SELECT status FROM documents.document_state WHERE document_id = 'nd-0003') || '|' || " +
          "(SELECT status || ':' || disposition FROM documents.document_state WHERE document_id = 'nd-0004') " +
          'FROM (SELECT 1) AS _;',
      );
      if (documentHoldPosture !== 'unmatched|disposed:returned') {
        throw new Error(`documents hold-timer standing proof differs: ${documentHoldPosture}`);
      }

      // WP-024: projection<->log linkage — every document_state row names the latest
      // event of its document (the fold is a materialized read model, not a second
      // source of truth).
      const documentProjectionDrift = await scalar(
        'SELECT count(*)::text FROM documents.document_state s ' +
          'WHERE s.last_event_id <> (SELECT e.document_event_id FROM documents.document_event e ' +
          'WHERE e.tenant_id = s.tenant_id AND e.document_id = s.document_id ' +
          'ORDER BY e.occurred_at DESC, e.document_event_id DESC LIMIT 1);',
      );
      if (documentProjectionDrift !== '0') {
        throw new Error(
          `documents projection out of sync: last_event drift=${documentProjectionDrift}`,
        );
      }

      // WP-025: document records landed at its package ceiling `scaffolded` with the
      // opposite-state tenant proof (northwind scaffolded, riverbend disabled).
      const documentsRecordsCapabilityStates = await scalar(
        "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
          "FROM platform_core.capability_grant WHERE capability_id = 'documents.records';",
      );
      if (
        documentsRecordsCapabilityStates !==
        'northwind-synthetic:scaffolded,riverbend-synthetic:disabled'
      ) {
        throw new Error(
          `documents.records capability tenant states differ: ${documentsRecordsCapabilityStates}`,
        );
      }

      // WP-025: supersession at rest (REQ-DOC-003) — nd-0001's current head is the
      // correction (v2), the source (v1) is PRESERVED, and the denied-correction
      // document (nd-0005) keeps its source (v1) current beside the disagreement.
      const supersessionPosture = await scalar(
        "SELECT (SELECT version_no::text || ':' || kind FROM documents.document_version dv " +
          "WHERE tenant_id = 'northwind-synthetic' AND document_id = 'nd-0001' " +
          "AND kind <> 'statement-of-disagreement' " +
          'AND NOT EXISTS (SELECT 1 FROM documents.document_version w ' +
          'WHERE w.tenant_id = dv.tenant_id AND w.document_id = dv.document_id ' +
          'AND w.supersedes_version_no = dv.version_no) ORDER BY version_no DESC LIMIT 1) ' +
          "|| '|' || (SELECT count(*)::text FROM documents.document_version WHERE document_id = 'nd-0001') " +
          "|| '|' || (SELECT version_no::text FROM documents.document_version dv " +
          "WHERE tenant_id = 'northwind-synthetic' AND document_id = 'nd-0005' " +
          "AND kind <> 'statement-of-disagreement' " +
          'AND NOT EXISTS (SELECT 1 FROM documents.document_version w ' +
          'WHERE w.tenant_id = dv.tenant_id AND w.document_id = dv.document_id ' +
          'AND w.supersedes_version_no = dv.version_no) ORDER BY version_no DESC LIMIT 1);',
      );
      if (supersessionPosture !== '2:correction|2|1') {
        throw new Error(`documents supersession standing proof differs: ${supersessionPosture}`);
      }

      // WP-025: partition-scoped search negative at rest (REQ-DOC-013/016) — the
      // genetic panel never surfaces without genetic clearance, and does with it.
      const searchScopePosture = await scalar(
        'SELECT (SELECT count(*)::text FROM documents.document_search_index ' +
          "WHERE tenant_id = 'northwind-synthetic' " +
          "AND search_vector @@ plainto_tsquery('english', 'panel') " +
          "AND partition_tags <@ '{}'::text[]) || '|' || " +
          '(SELECT count(*)::text FROM documents.document_search_index ' +
          "WHERE tenant_id = 'northwind-synthetic' " +
          "AND search_vector @@ plainto_tsquery('english', 'panel') " +
          "AND partition_tags <@ ARRAY['gipa-genetic']::text[]);",
      );
      if (searchScopePosture !== '0|1') {
        throw new Error(
          `documents partition-scoped-search standing proof differs: ${searchScopePosture}`,
        );
      }

      // WP-025: disclosure accounting at rest (REQ-DOC-002/016) — the seeded audit
      // export is closed with evidence and excludes the genetic artifact.
      const disclosurePosture = await scalar(
        "SELECT closure_status || '|' || array_length(excluded_genetic_refs, 1)::text " +
          "FROM documents.records_disclosure WHERE disclosure_id = 'ndd-0001';",
      );
      if (disclosurePosture !== 'closed-with-evidence|1') {
        throw new Error(`documents disclosure standing proof differs: ${disclosurePosture}`);
      }

      // WP-026: the vendor-registry capability sits at the package ceiling with the
      // opposite-state tenant proof (northwind scaffolded, riverbend disabled).
      const vendorRegistryCapabilityStates = await scalar(
        "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
          "FROM platform_core.capability_grant WHERE capability_id = 'platform.vendor-registry';",
      );
      if (
        vendorRegistryCapabilityStates !==
        'northwind-synthetic:scaffolded,riverbend-synthetic:disabled'
      ) {
        throw new Error(
          `vendor-registry capability tenant states differ: ${vendorRegistryCapabilityStates}`,
        );
      }

      // WP-026: the vendor registry standing posture holds at rest — the lapsed
      // vendor is suspended (REQ-PLAT-029), the AI-uncovered vendor lacks its
      // no-training clause (R6-REQ-103), and the labs vendor is NOT permitted GEN
      // (the egress-guard (e) block proof, R6-REQ-009).
      const vendorPosture = await scalar(
        "SELECT (SELECT status FROM platform_integration.vendor WHERE vendor_id = 'synthetic-lapsed-vendor') " +
          "|| '|' || (SELECT no_training_on_phi::text FROM platform_integration.vendor WHERE vendor_id = 'synthetic-ai-uncovered') " +
          "|| '|' || (SELECT ('GEN' = ANY(permitted_categories))::text FROM platform_integration.vendor WHERE vendor_id = 'synthetic-labs-vendor') " +
          'FROM (SELECT 1) AS _;',
      );
      if (vendorPosture !== 'suspended|false|false') {
        throw new Error(`vendor registry standing posture differs: ${vendorPosture}`);
      }

      // WP-026: the egress-decision activity feed carries an allow beside a
      // block-with-incident (REQ-PLAT-001 AC-8 / REQ-PLAT-029), and the vendor
      // projection version equals its lifecycle log's max version (materialized read
      // model, not a second source of truth).
      const egressFeedPosture = await scalar(
        'SELECT (SELECT count(*) FROM platform_integration.egress_decision ' +
          "WHERE tenant_id = 'northwind-synthetic' AND decision = 'allow' AND NOT incident_opened)::text " +
          "|| '|' || (SELECT count(*) FROM platform_integration.egress_decision " +
          "WHERE tenant_id = 'northwind-synthetic' AND decision = 'deny' AND incident_opened)::text;",
      );
      if (!/^[1-9][0-9]*\|[1-9][0-9]*$/.test(egressFeedPosture)) {
        throw new Error(`egress-decision feed standing proof broken: ${egressFeedPosture}`);
      }
      const vendorProjectionDrift = await scalar(
        'SELECT count(*)::text FROM platform_integration.vendor v ' +
          'WHERE v.version <> (SELECT max(e.version) FROM platform_integration.vendor_event e ' +
          'WHERE e.tenant_id = v.tenant_id AND e.vendor_id = v.vendor_id);',
      );
      if (vendorProjectionDrift !== '0') {
        throw new Error(`vendor projection out of sync: version drift=${vendorProjectionDrift}`);
      }

      // WP-026: the content-license gate posture — an active CPT license beside a
      // lapsed drug-compendium license (R6-REQ-080/081).
      const licensePosture = await scalar(
        "SELECT string_agg(content_family || ':' || status, ',' ORDER BY content_family) " +
          "FROM platform_integration.content_license WHERE tenant_id = 'northwind-synthetic';",
      );
      if (licensePosture !== 'cpt:active,drug-compendium:lapsed') {
        throw new Error(`content-license standing posture differs: ${licensePosture}`);
      }

      // WP-027: the rail simulator lands at its package ceiling — northwind
      // `scaffolded` beside riverbend `disabled`, so the injectRailScenario command
      // (floored `simulated`) denies a live injection by design.
      const railSimulatorCapabilityStates = await scalar(
        "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) FROM platform_core.capability_grant WHERE capability_id = 'platform.rail-simulator';",
      );
      if (
        railSimulatorCapabilityStates !==
        'northwind-synthetic:scaffolded,riverbend-synthetic:disabled'
      ) {
        throw new Error(
          `rail-simulator capability tenant states differ: ${railSimulatorCapabilityStates}`,
        );
      }

      // WP-027: the live scenario-control surface, the process-kill drill across a
      // real container death, the PHI scan of the live sim store, and the reset.
      await probeRailSimulator();

      // Preserve all16 existing DB suites and their fail-first order.
      await runLocalAcceptanceSuites();

      // WP-029: synthgen corpus standing proofs, live.
      //
      // (a) The corpus is actually LOADED — the seeded subject count matches the
      //     pinned corpus, so a seed that silently no-ops is caught here rather
      //     than by a later package wondering where its data went.
      const corpusSubjects = await scalar(
        "SELECT count(*) FROM identity.person WHERE tenant_id = 'northwind-synthetic' " +
          "AND provenance_source LIKE 'synthgen-v1%';",
      );
      if (Number(corpusSubjects) < 100) {
        throw new Error(`synthgen corpus not loaded: ${corpusSubjects} corpus persons at rest`);
      }

      // (b) SHARED-ENDPOINT AT SCALE. WP-013 proved the shape on one seeded
      //     household; the corpus proves it holds across the whole generated
      //     world — every corpus household endpoint attaches to >= 1 person and at
      //     least one attaches to several, and no endpoint IS a person.
      const sharedCorpusEndpoints = await scalar(
        'SELECT count(*) FROM (' +
          'SELECT a.endpoint_id FROM identity.endpoint_association a ' +
          "WHERE a.tenant_id = 'northwind-synthetic' AND a.endpoint_id LIKE 'sg-ep-%' " +
          'GROUP BY a.endpoint_id HAVING count(DISTINCT a.person_id) > 1) shared;',
      );
      if (Number(sharedCorpusEndpoints) < 1) {
        throw new Error(
          'synthgen corpus standing proof broken: no corpus endpoint is shared across persons — ' +
            'the household-collision world is missing',
        );
      }

      // (c) KNOWN-TRUTH DUPLICATES ARE REAL ROWS. Every same-person collision seeds
      //     an acquired twin: a second person carrying the same legal name with its
      //     own crosswalk value and NO patient record. A merge queue with nothing
      //     to merge proves nothing.
      const acquiredTwins = await scalar(
        'SELECT count(*) FROM identity.person p ' +
          "WHERE p.tenant_id = 'northwind-synthetic' " +
          "AND p.provenance_source = 'synthgen-v1-acquired-clinic' " +
          "AND p.status = 'provisional' " +
          'AND NOT EXISTS (SELECT FROM identity.patient_record r ' +
          'WHERE r.tenant_id = p.tenant_id AND r.person_id = p.person_id);',
      );
      if (Number(acquiredTwins) < 1) {
        throw new Error(
          `synthgen corpus standing proof broken: ${acquiredTwins} unmatched acquired twins at rest`,
        );
      }

      // (d) The corpus capability sits at the package ceiling with the
      //     opposite-state tenant proof.
      const corpusCapabilityStates = await scalar(
        "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
          "FROM platform_core.capability_grant WHERE capability_id = 'platform.synthetic-corpus';",
      );
      if (
        corpusCapabilityStates !== 'northwind-synthetic:scaffolded,riverbend-synthetic:disabled'
      ) {
        throw new Error(
          `synthetic-corpus capability tenant states differ: ${corpusCapabilityStates}`,
        );
      }

      // WP-014: the dex federation e2e runs against the live compose dex —
      // discovery, mock-connector code flow, crosswalk mapping, and the
      // dark-by-registry denial proof.
      await runLocalAcceptanceSuites(true);

      console.log(
        `services_healthy=${services.size} tenants=${tenantRows.join(',')} ` +
          'rls_coverage=OK watermark=OK jurisdiction_packs=OK capability_registry=OK ' +
          'identity_model=OK authn_model=OK merge_governance=OK pdp_model=OK ' +
          'gipa_partition=OK audit_store=OK consent_ledger=OK event_spine=OK ' +
          'policy_clocks=OK tasking_engine=OK break_glass=OK oncall_coverage=OK ' +
          'documents_model=OK documents_records=OK vendor_registry=OK rail_simulator=OK ' +
          'rail_fleet=OK rail_heartbeat=OK synthgen_corpus=OK ' +
          'dex_federation=OK cross_tenant_db_suite=OK synthetic_stack=OK',
      );
    } finally {
      insideTestLocal = false;
      testLocalSimAdmitted = false;
    }
  }

  /** ADR-003's uniform failure injection: `pnpm sim <RAIL-###> <X-##>`. */
  async function sim(railId: string | undefined, primitiveId: string | undefined): Promise<void> {
    if (railId === undefined || primitiveId === undefined) {
      throw new Error('usage: pnpm sim <RAIL-###> <X-##> (or `reset` as the rail id to roll back)');
    }
    if (railId === 'reset') {
      const reset = await simCall('/control/reset', { method: 'POST' });
      console.log(`sim reset ${JSON.stringify(reset.state)}`);
      return;
    }
    const armed = await simCall(`/scenarios/${railId}/${primitiveId}`, { method: 'POST' });
    console.log(`sim armed ${JSON.stringify(armed.armed)}`);
  }

  async function main(argv: readonly string[]): Promise<void> {
    const action = argv[0];
    switch (action) {
      case 'doctor':
        doctor();
        break;
      case 'provision':
      case 'up':
        await up();
        break;
      case 'migrate':
        await migrate();
        break;
      case 'seed':
        await seed();
        break;
      case 'test':
        await testLocal();
        break;
      case 'sim':
        await sim(argv[1], argv[2] ?? 'X-00');
        break;
      case 'down':
        throw new Error(
          'down requires a separate lifecycle grant; no containers or volumes changed',
        );
      case 'reset':
        throw new Error(
          'Reset requires a separately authorized target rebind after container recreation; no volumes were removed',
        );
      default:
        throw new Error(`Unsupported local action: ${action ?? '(missing)'}`);
    }
  }
  async function ownCommand<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await withLaneObservationContext(
        {
          workers: 4,
          readinessFailureMs: 1000,
          observationFailureMs: 1000,
          shutdownFailureMs: 1000,
          // No whole-command outer deadline exists at this API. Per-transport
          // timeoutMs and the caller's test deadline are not substitutes.
        },
        operation,
      );
    } catch (error) {
      // This reports actual owner state; active/UNKNOWN is never relabeled closed.
      console.error(`lane_observation_owner=${JSON.stringify(laneObservationOwnerState())}`);
      throw error;
    }
  }
  // Internal calls keep the same lexical owner; only public entry boundaries wrap.
  return {
    main: (argv: readonly string[]) => ownCommand(() => main(argv)),
    probeRailSimulator: () => ownCommand(probeRailSimulator),
    runLocalAcceptanceSuites: (federation = false) =>
      ownCommand(() => runLocalAcceptanceSuites(federation)),
  };
}

/** SHA pin is external authority; observed container state never creates a grant. */
export function loadMigrationBinding(
  path: string | undefined,
  expectedSha256: string | undefined,
): LocalMigrationOptions {
  if (path === undefined && expectedSha256 === undefined) return {};
  if (!path || !isAbsolute(path) || !expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256))
    throw new Error('Absolute migration binding path and SHA256 pin required');
  const bytes = readPinnedFile({ path, sha256: expectedSha256 });
  const value = JSON.parse(bytes.toString('utf8')) as {
    version?: unknown;
    target?: MigrationTarget;
    nativePaths?: Partial<WindowsSupervisorBinding>;
    localAcceptance?: LocalAcceptanceScope;
  };
  if (
    value.version !== 1 ||
    Object.keys(value).some(
      (key) => !['version', 'target', 'nativePaths', 'localAcceptance'].includes(key),
    )
  )
    throw new Error('Invalid migration binding schema');
  const nativePaths = value.nativePaths;
  if (
    !nativePaths ||
    typeof nativePaths.executablePath !== 'string' ||
    typeof nativePaths.powershellPath !== 'string' ||
    !isAbsolute(nativePaths.executablePath) ||
    !isAbsolute(nativePaths.powershellPath) ||
    nativePaths.powershellVersion !== '7.6.5' ||
    typeof nativePaths.executableSha256 !== 'string' ||
    typeof nativePaths.powershellSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(nativePaths.executableSha256) ||
    !/^[a-f0-9]{64}$/.test(nativePaths.powershellSha256) ||
    Object.keys(nativePaths).some(
      (key) =>
        ![
          'executablePath',
          'powershellPath',
          'executableSha256',
          'powershellSha256',
          'powershellVersion',
        ].includes(key),
    )
  )
    throw new Error('Pinned native executable and PowerShell paths required');
  return {
    ...(value.localAcceptance === undefined ? {} : { localAcceptance: value.localAcceptance }),
    bindingFile: { path, sha256: expectedSha256 },
    ...(value.target === undefined ? {} : { target: validateMigrationTarget(value.target) }),
    nativePaths: {
      executablePath: nativePaths.executablePath,
      powershellPath: nativePaths.powershellPath,
      executableSha256: nativePaths.executableSha256,
      powershellSha256: nativePaths.powershellSha256,
      powershellVersion: nativePaths.powershellVersion,
    },
  };
}

/** Direct executable boundary only; embedding callers retain library rejection semantics. */
export async function runLocalCliExecutable(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    process.exitCode = 1;
    console.error(error);
    console.error(`lane_observation_owner=${JSON.stringify(laneObservationOwnerState())}`);
    // Do not fatally reject the entry module or call process.exit: referenced
    // producer workers/ports retain custody until their existing actual-exit
    // cleanup settles. No new effects, retry, owner, timer or daemon starts here.
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runLocalCliExecutable(async () => {
    await createLocalCli(spawnSync, fetch, process.env['PRACTICEHUB_COMPOSE_OVERRIDE'], {
      ...loadMigrationBinding(
        process.env['PRACTICEHUB_MIGRATION_BINDING_PATH'],
        process.env['PRACTICEHUB_MIGRATION_BINDING_SHA256'],
      ),
      ...(process.env['PRACTICEHUB_LANE_PATH'] && process.env['PRACTICEHUB_LANE_SHA256']
        ? {
            laneBinding: {
              path: process.env['PRACTICEHUB_LANE_PATH'],
              sha256: process.env['PRACTICEHUB_LANE_SHA256'],
            },
          }
        : {}),
    }).main(process.argv.slice(2));
  });
}
