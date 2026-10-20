import { createHash } from 'node:crypto';
import type { spawnSync } from 'node:child_process';
import { spawnSync as launchDirectEntry } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLocalCli, loadMigrationBinding } from './cli.js';
import type { LaneConfiguration } from './compose-config.js';
import * as laneIo from './compose-config.js';
import type { MigrationTarget, MigrationTransport } from './migrations.js';

const names = [
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
];
const ledger = [
  'final_dunning',
  'final_v2',
  'migration',
  'original0071',
  'empty',
  'upgrade',
  'recovery',
  'refusal',
  'legacy_cash',
];
const roots: string[] = [];
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (/^(?:https?_proxy|all_proxy|node_use_env_proxy|DOCKER_.*|COMPOSE_.*)$/i.test(key))
      vi.stubEnv(key, '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ph-local-scope-')));
  roots.push(root);
  function file(path: string, bytes: string): string {
    const absolute = join(root, path);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, bytes);
    return absolute;
  }
  for (const path of ['modules', 'packages', 'infra/postgres', 'infra/dex', 'tools/local-tools'])
    mkdirSync(join(root, path), { recursive: true });
  for (const name of names) {
    file(
      `modules/${name}/package.json`,
      JSON.stringify({
        name: `@practicehub/${name}`,
        scripts: {
          'test:db': 'vitest run --config vitest.db.config.ts',
          ...(name === 'identity'
            ? { 'test:federation': 'vitest run --config vitest.federation.config.ts' }
            : {}),
        },
      }),
    );
    file(
      `modules/${name}/vitest.db.config.ts`,
      'export default {test:{include:["src/**/*.db.test.ts"]}};',
    );
    file(`modules/${name}/src/unit.db.test.ts`, '// synthetic routing fixture, never executed');
  }
  file('modules/identity/src/federation.ts', '// pinned synthetic federation source');
  file('modules/identity/src/dex.federation.test.ts', '// parsed callback, no listener');
  file('modules/identity/vitest.federation.config.ts', '// pinned federation config');
  file(
    'modules/payments-ledger/src/db-test-harness.ts',
    '// synthetic isolated helper, never executed',
  );
  file('infra/dex/config.yaml', 'issuer: http://127.0.0.1:5556/dex\n');
  file('infra/postgres/init/001-bootstrap.sql', 'SELECT 1;');
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
  ])
    file(path, '{}');
  const sourceFiles: { path: string; sha256: string }[] = [];
  function collect(path: string): void {
    for (const item of readdirSync(join(root, path), { withFileTypes: true })) {
      const relative = `${path}/${item.name}`;
      if (item.isDirectory()) collect(relative);
      else sourceFiles.push({ path: relative, sha256: hash(readFileSync(join(root, relative))) });
    }
  }
  for (const path of ['modules', 'packages', 'infra/postgres', 'infra/dex', 'tools/local-tools'])
    collect(path);
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
  ])
    sourceFiles.push({ path, sha256: hash(readFileSync(join(root, path))) });
  const nodePath = file('runtime/node.exe', 'synthetic-pinned-node-not-executed');
  const pnpmPath = file('runtime/pnpm.cjs', 'synthetic-pinned-pnpm-not-executed');
  const dockerConfig = file('docker/config.json', '{}');
  const pluginName = process.platform === 'win32' ? 'docker-compose.exe' : 'docker-compose';
  const plugin = file(`docker/cli-plugins/${pluginName}`, 'synthetic-plugin');
  const image = `sha256:${'c'.repeat(64)}`;
  const revision = 'd'.repeat(40);
  const serviceNames = [
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
  ];
  const services = Object.fromEntries(
    serviceNames.map((name, i) => [
      name,
      {
        containerId: (i + 1).toString(16).repeat(64),
        imageId: image,
        revision,
        ports:
          name === 'app-postgres'
            ? [{ containerPort: '5432/tcp', hostIp: '127.0.0.1' as const, hostPort: 25432 }]
            : name === 'dex'
              ? [{ containerPort: '5556/tcp', hostIp: '127.0.0.1' as const, hostPort: 5556 }]
              : name === 'vendor-simulator'
                ? [{ containerPort: '8090/tcp', hostIp: '127.0.0.1' as const, hostPort: 23090 }]
                : [],
      },
    ]),
  );
  const config = {
    name: 'synthetic-local',
    services: Object.fromEntries(
      Object.entries(services).map(([name, value]) => [
        name,
        {
          image,
          labels: { 'org.opencontainers.image.revision': revision },
          ports: value.ports.map((port) => ({
            target: Number(port.containerPort.split('/')[0]),
            protocol: 'tcp',
            published: String(port.hostPort),
            host_ip: port.hostIp,
          })),
        },
      ]),
    ),
  };
  const text = JSON.stringify(config);
  const composeFile = file('approved-compose.json', text);
  const lane: LaneConfiguration = {
    version: 1,
    grant: 'unit-local',
    mode: 'operate',
    sourceCwd: root,
    project: 'synthetic-local',
    docker: {
      endpoint: 'npipe:////./pipe/docker_engine',
      configFile: { path: dockerConfig, sha256: hash('{}') },
      composePlugin: { path: plugin, sha256: hash('synthetic-plugin') },
    },
    resolvedConfigSha256: hash(text),
    composeFiles: [{ path: composeFile, sha256: hash(text) }],
    profiles: [],
    sourceFiles: [],
    services,
    simulatorOrigin: 'http://127.0.0.1:23090',
  };
  const laneText = JSON.stringify(lane);
  const lanePin = { path: file('lane.json', laneText), sha256: hash(laneText) };
  const target: MigrationTarget = {
    containerId: '1'.repeat(64),
    clusterSystemIdentifier: '7696560484942077986',
    databaseName: 'practicehub',
    databaseUser: 'practicehub',
    grant: 'unit-local',
  };
  const scope = {
    version: 1,
    syntheticOnly: true,
    grant: 'unit-local',
    lane: lanePin,
    target: { ...target },
    sourceCwd: root,
    dockerEndpoint: lane.docker.endpoint,
    project: lane.project,
    database: {
      host: '127.0.0.1',
      port: 25432,
      name: 'practicehub',
      owner: 'practicehub',
      appRole: 'practicehub_app',
      administrativeDatabase: 'postgres',
    },
    dex: {
      issuer: 'http://127.0.0.1:5556/dex',
      clientId: 'practicehub-local',
      callback: 'http://127.0.0.1:53000/auth/callback',
    },
    ledger: {
      run: 'unit87',
      databases: ledger.map((suite) => `ph_ledger_proof_unit87_${suite}`),
      effects: [
        'create-fresh-database',
        'drop-only-invocation-created-database',
        'cluster-role-migrations',
        'alter-practicehub-app-role',
      ],
    },
    suites: names,
    sourceFiles,
    runtime: {
      node: { path: nodePath, sha256: hash(readFileSync(nodePath)) },
      pnpm: { path: pnpmPath, sha256: hash(readFileSync(pnpmPath)) },
    },
  };
  const raw = {
    version: 1,
    target,
    nativePaths: {
      executablePath: nodePath,
      powershellPath: nodePath,
      powershellVersion: '7.6.5',
      executableSha256: hash(readFileSync(nodePath)),
      powershellSha256: hash(readFileSync(nodePath)),
    },
    localAcceptance: scope,
  };
  const bindingPath = join(root, 'migration.json');
  function options() {
    const bytes = JSON.stringify(raw);
    writeFileSync(bindingPath, bytes);
    return { ...loadMigrationBinding(bindingPath, hash(bytes)), laneBinding: lanePin, transport };
  }
  const command = vi.fn<NonNullable<MigrationTransport['command']>>(async (argv) => {
    let stdout: string;
    if (argv.includes('config')) stdout = text;
    else if (argv.includes('--quiet')) stdout = services[String(argv.at(-1))]?.containerId ?? '';
    else if (argv[0] === 'inspect') {
      const pair = Object.entries(services).find(([, value]) => value.containerId === argv[1]);
      if (!pair) throw new Error('Unapproved inspected CID');
      const [name, service] = pair;
      stdout = JSON.stringify([
        {
          Id: service.containerId,
          Image: image,
          Config: {
            Labels: {
              'com.docker.compose.project': lane.project,
              'com.docker.compose.service': name,
              'com.docker.compose.project.working_dir': root,
              'com.docker.compose.project.config_files': composeFile,
              'org.opencontainers.image.revision': revision,
            },
          },
          NetworkSettings: {
            Ports: Object.fromEntries(
              service.ports.map((port) => [
                port.containerPort,
                [{ HostIp: port.hostIp, HostPort: String(port.hostPort) }],
              ]),
            ),
          },
        },
      ]);
    } else if (argv.includes('ps') && argv.at(-1) === 'vendor-simulator')
      stdout = '{"State":"exited"}';
    else
      stdout = serviceNames
        .map((Service) => JSON.stringify({ Service, State: 'running', Health: 'healthy' }))
        .join('\n');
    return { status: 0, stdout, stderr: '' };
  });
  const execute = vi.fn<MigrationTransport['execute']>(async (actual) => {
    expect(actual).toEqual(target);
    return { status: 0, stdout: '1', stderr: '' };
  });
  const preflight = vi.fn<NonNullable<MigrationTransport['preflight']>>(async () => {});
  const transport = {
    command,
    execute,
    preflight,
    bindDocker: vi.fn(),
  } satisfies MigrationTransport;
  const processCall = vi.fn(() => ({
    status: 0,
    stdout: '',
    stderr: '',
    pid: 1,
    output: [],
    signal: null,
  }));
  const http = vi.fn<typeof fetch>();
  function cli() {
    return createLocalCli(processCall as unknown as typeof spawnSync, http, undefined, options());
  }
  function change(path: string[], value: unknown): void {
    let current = raw.localAcceptance as unknown as Record<string, unknown>;
    for (const name of path.slice(0, -1)) current = current[name] as Record<string, unknown>;
    const last = path.at(-1);
    if (!last) throw new Error('Missing fixture path');
    current[last] = value;
  }
  return {
    root,
    lane,
    target,
    raw,
    options,
    cli,
    change,
    command,
    execute,
    preflight,
    processCall,
    http,
    bindingPath,
    configText: text,
    lanePin,
    bindDocker: transport.bindDocker,
  };
}

// Routing-only fake pin reader: no filesystem/native/performance claim. Real
// closure/mutation tests below do not install these mocks. This avoids making
// the full entry orchestration assertion a native filesystem benchmark.
function routingPins(f: ReturnType<typeof fixture>): void {
  const pins = new Map<string, Buffer>();
  for (const file of f.raw.localAcceptance.sourceFiles)
    pins.set(join(f.root, file.path), readFileSync(join(f.root, file.path)));
  for (const file of Object.values(f.raw.localAcceptance.runtime))
    pins.set(file.path, readFileSync(file.path));
  pins.set(f.bindingPath, readFileSync(f.bindingPath));
  vi.spyOn(laneIo, 'loadLaneConfiguration').mockImplementation(() => f.lane);
  vi.spyOn(laneIo, 'readPinnedFile').mockImplementation((pin) => {
    const bytes = pins.get(pin.path);
    if (!bytes || hash(bytes) !== pin.sha256) throw new Error('Routing fixture pin differs');
    return Buffer.from(bytes);
  });
}

it('refuses absent local scope before every replaceable transport', async () => {
  const f = fixture();
  const rest = { ...f.options() };
  delete rest.localAcceptance;
  delete rest.bindingFile;
  await expect(
    createLocalCli(f.processCall as unknown as typeof spawnSync, f.http, undefined, rest).main([
      'test',
    ]),
  ).rejects.toThrow(/scope unbound/);
  expect(f.command).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.preflight).not.toHaveBeenCalled();
  expect(f.processCall).not.toHaveBeenCalled();
  expect(f.http).not.toHaveBeenCalled();
});
it.each([
  [['dex', 'issuer'], 'http://localhost:5556/dex'],
  [['dex', 'clientId'], 'foreign'],
  [['dex', 'callback'], 'http://127.0.0.1:53001/auth/callback'],
  [['dockerEndpoint'], 'npipe:////./pipe/foreign'],
  [['project'], 'foreign'],
  [['target', 'containerId'], 'f'.repeat(64)],
  [['target', 'clusterSystemIdentifier'], '1'],
  [['database', 'name'], 'foreign'],
  [['database', 'owner'], 'postgres'],
  [['database', 'appRole'], 'postgres'],
  [['database', 'port'], 25433],
  [['suites'], names.slice(1)],
  [['suites'], [...names, 'foreign']],
  [['ledger', 'effects'], ['create-fresh-database']],
  [['ledger', 'databases'], ['preexisting']],
] as const)(
  'refuses mismatched endpoint/target/effects at %s before calls',
  async (path, value) => {
    const f = fixture();
    f.change([...path], value);
    await expect(f.cli().main(['test'])).rejects.toThrow();
    expect(f.command).not.toHaveBeenCalled();
    expect(f.preflight).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.processCall).not.toHaveBeenCalled();
    expect(f.http).not.toHaveBeenCalled();
  },
);
it.each(['changed-config', 'extra-db-test', 'changed-helper'])(
  'refuses source closure %s before calls',
  async (kind) => {
    const f = fixture();
    const path =
      kind === 'changed-config'
        ? 'modules/identity/vitest.federation.config.ts'
        : kind === 'extra-db-test'
          ? 'modules/identity/src/unapproved.db.test.ts'
          : 'modules/payments-ledger/src/db-test-harness.ts';
    writeFileSync(join(f.root, path), '// changed or added');
    await expect(f.cli().main(['test'])).rejects.toThrow(/closure|SHA256/);
    expect(f.command).not.toHaveBeenCalled();
    expect(f.processCall).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it('routes all16 ordered DB commands then federation with only the approved connection environment', async () => {
  const f = fixture();
  vi.stubEnv('PGHOST', 'foreign');
  vi.stubEnv('DATABASE_URL', 'postgres://foreign');
  vi.stubEnv('PRACTICEHUB_DB_PORT', '1');
  vi.stubEnv('npm_config_script_shell', 'foreign');
  const cli = f.cli();
  routingPins(f);
  await cli.runLocalAcceptanceSuites();
  await cli.runLocalAcceptanceSuites(true);
  expect(f.processCall.mock.calls).toHaveLength(17);
  for (const [index, call] of (
    f.processCall.mock.calls as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; cwd: string; shell: boolean },
    ][]
  ).entries()) {
    expect(call[0]).toBe(f.raw.localAcceptance.runtime.node.path);
    expect(call[1]).toEqual([
      '--no-global-search-paths',
      f.raw.localAcceptance.runtime.pnpm.path,
      '--filter',
      `@practicehub/${index === 16 ? 'identity' : names[index]}`,
      'run',
      index === 16 ? 'test:federation' : 'test:db',
    ]);
    expect(call[2].cwd).toBe(f.root);
    expect(call[2].shell).toBe(false);
    expect(call[2].env['PRACTICEHUB_DB_HOST']).toBe('127.0.0.1');
    expect(call[2].env['PRACTICEHUB_DB_PORT']).toBe('25432');
    expect(call[2].env['PRACTICEHUB_LEDGER_DB_PROOF']).toBe('synthetic-isolated');
    expect(call[2].env['PRACTICEHUB_LEDGER_DB_RUN']).toBe('unit87');
    expect(call[2].env['NODE_OPTIONS']).toBe('--no-global-search-paths');
    for (const key of ['PGHOST', 'DATABASE_URL', 'npm_config_script_shell'])
      expect(call[2].env[key]).toBeUndefined();
  }
  expect(f.http).not.toHaveBeenCalled(); // callback is parsed by federation child, no listener here.
});
it('stops at the first delegated failure and emits no whole-local success', async () => {
  const f = fixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  f.processCall.mockReturnValueOnce({
    status: 1,
    stdout: '',
    stderr: 'controlled failure',
    pid: 1,
    output: [],
    signal: null,
  });
  await expect(f.cli().runLocalAcceptanceSuites()).rejects.toThrow(
    /Delegated platform-core failed/,
  );
  expect(f.processCall).toHaveBeenCalledTimes(1);
  expect(log.mock.calls.flat().join(' ')).not.toContain('synthetic_stack=OK');
});
it('rechecks scope after a previous command callback before another effect', async () => {
  const f = fixture();
  f.command.mockImplementationOnce(async () => {
    writeFileSync(join(f.root, 'modules/identity/src/unit.db.test.ts'), '// callback mutation');
    return { status: 0, stdout: f.configText, stderr: '' };
  });
  await expect(f.cli().runLocalAcceptanceSuites()).rejects.toThrow();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.processCall).not.toHaveBeenCalled();
});

it('rejects changed external binding bytes before the first transport', async () => {
  const f = fixture();
  const cli = f.cli();
  writeFileSync(f.bindingPath, '{}');
  await expect(cli.main(['test'])).rejects.toThrow(/SHA256/);
  expect(f.preflight).not.toHaveBeenCalled();
  expect(f.command).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.processCall).not.toHaveBeenCalled();
});
it('refuses a last-bind queued Compose mutation before any local SQL executes (L1)', async () => {
  const f = fixture();
  let admissions = 0;
  // For the first delegated effect: preflight, inspect, SQL preflight,
  // SQL inspect, final SQL admission. Mutate only across that last await.
  f.bindDocker.mockImplementation(() => {
    if (++admissions === 5)
      queueMicrotask(() => writeFileSync(f.lane.composeFiles[0]?.path ?? '', '{}'));
  });
  await expect(f.cli().runLocalAcceptanceSuites()).rejects.toThrow(/SHA256|Lane changed/);
  expect(admissions).toBe(5);
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.processCall).not.toHaveBeenCalled();
});

it('main test entry propagates first delegated failure and suppresses all later effects and whole-local OK (L2)', async () => {
  const f = fixture();
  const cli = f.cli();
  routingPins(f);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  // Explicit healthy synthetic standing-proof replies, only to drive the real
  // entry to its delegated boundary. These are not DB correctness evidence.
  const scaffold = 'northwind-synthetic:scaffolded,riverbend-synthetic:disabled';
  const rows: readonly (readonly [string, string])[] = [
    ['tenants', 'northwind-synthetic:simulated\nriverbend-synthetic:disabled'],
    ['unprotected', '0'],
    ['watermark tables', 'platform_core.synthetic_tenant'],
    ['unwatermarked', '0'],
    ['required packs', '0'],
    ['incomplete packs', '0'],
    ['capability registry', 'northwind-synthetic:simulated,riverbend-synthetic:disabled'],
    ['orphan grants', '0'],
    ['orphan streams', '0'],
    ['shared endpoints', '2,2'],
    ['distinct persons', '2'],
    ['sub-MFA staff', '0'],
    ['session policies', 'northwind-synthetic:3'],
    ['authn', scaffold],
    [
      'merge cases',
      'northwind-synthetic:resolved-merged,northwind-synthetic:open,riverbend-synthetic:open',
    ],
    ['alias', 'np-sam-porter|1'],
    ['orphan cases', '0'],
    ['orphan merge events', '0'],
    ['merge capability', scaffold],
    ['role templates', 'northwind-synthetic:8'],
    ['deceased', '1'],
    ['partition', '1|0'],
    ['PDP', scaffold],
    ['GIPA', scaffold],
    ['chain breaks', '0'],
    ['audit stream', 'deny|claude-sonnet-5-synthetic'],
    ['holds', 'northwind-synthetic:active,riverbend-synthetic:released'],
    ['retention classes', '6'],
    ['audit capability', scaffold],
    ['consent capability', scaffold],
    ['STOP', 'marketing=opted_out,treatment=opted_in'],
    ['consent obligations', '1|1'],
    ['orphan consent states', '0'],
    ['orphan consent scopes', '0'],
    ['event capability', scaffold],
    ['event posture', '3|2|2|0'],
    ['policy clock capability', scaffold],
    ['clock floors', '0'],
    ['clock posture', '30|escalated|satisfied'],
    ['orphan clocks', '0'],
    ['tasking capability', scaffold],
    ['William', 'synthetic-guide:maya|high|true|true|paused|running'],
    ['unmatched', 'true|unmatched|running'],
    ['concierge', '1'],
    ['orphan work items', '0'],
    ['break glass capability', scaffold],
    ['break glass review', '2|1|1'],
    ['offboarding', 'true|3'],
    ['anomaly', '1'],
    ['recertification', '1'],
    ['on-call rotation', 'northwind-synthetic:24x7,riverbend-synthetic:business'],
    ['coverage gap', '1'],
    ['handoff', 'true|2'],
    ['documents capability', scaffold],
    ['quarantine', 'quarantined|wrong-patient'],
    ['hold timer', 'unmatched|disposed:returned'],
    ['document projection', '0'],
    ['records capability', scaffold],
    ['supersession', '2:correction|2|1'],
    ['search', '0|1'],
    ['disclosure', 'closed-with-evidence|1'],
    ['vendor capability', scaffold],
    ['vendor posture', 'suspended|false|false'],
    ['egress feed', '1|1'],
    ['vendor projection', '0'],
    ['licenses', 'cpt:active,drug-compendium:lapsed'],
    ['rail simulator capability', scaffold],
  ];
  let row = 0;
  f.execute.mockImplementation(async (target, sql) => {
    expect(target).toEqual(f.target);
    if (sql.toString() === 'SELECT 1;') return { status: 0, stdout: '1', stderr: '' };
    const next = rows[row++];
    if (!next) throw new Error('Unexpected SQL after controlled first-child failure');
    return { status: 0, stdout: next[1], stderr: '' };
  });
  const paths: string[] = [];
  let intents = 0;
  let sweeps = 0;
  f.http.mockImplementation(async (input) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(f.lane.simulatorOrigin);
    const path = url.pathname;
    paths.push(path);
    let body: unknown = {};
    if (path === '/healthz') body = { dataPolicy: 'synthetic-only', rails: 17, primitives: 18 };
    if (path === '/control/reset') body = { state: { effects: [], receipts: [], heartbeats: [] } };
    if (path === '/primitives')
      body = {
        catalog: Array.from({ length: 18 }, (_, i) => ({
          primitiveId: `X-${String(i + 1).padStart(2, '0')}`,
        })),
      };
    if (path === '/rails/RAIL-008/create-payment-intent') {
      if (++intents === 1) throw new TypeError('controlled socket death');
      body = { response: { status: 'uncertain', attempts: 2, resendsExternalEffect: false } };
    }
    if (path === '/state')
      body = {
        state: {
          effects: [
            {
              idempotencyKey: 'synthetic-local-kill-drill',
              state: 'unknown',
              receiptRef: null,
              synthetic: true,
            },
          ],
          receipts: [],
        },
      };
    if (path === '/rails')
      body = {
        rails: Array.from({ length: 17 }, (_, i) => ({
          railId: `RAIL-${String(i + 1).padStart(3, '0')}`,
          authorityId: 'AUTH-001',
          presets: [{ authorityScenarioIndex: 1 }],
        })),
      };
    if (path === '/heartbeat') {
      sweeps++;
      body = {
        heartbeat: Array.from({ length: 17 }, (_, i) => ({
          railId: `RAIL-${String(i + 1).padStart(3, '0')}`,
          verdict: sweeps > 1 && i === 15 ? 'quiet' : 'alarm',
          reasons: ['rail-dark'],
        })),
      };
    }
    return new Response(JSON.stringify(body), { status: 200 });
  });
  let sqlAtFailure = -1;
  let httpAtFailure = -1;
  let commandsAtFailure = -1;
  f.processCall.mockImplementationOnce(() => {
    sqlAtFailure = f.execute.mock.calls.length;
    httpAtFailure = f.http.mock.calls.length;
    commandsAtFailure = f.command.mock.calls.length;
    return {
      status: 1,
      stdout: '',
      stderr: 'controlled first DB child failure',
      pid: 1,
      output: [],
      signal: null,
    };
  });
  await expect(cli.main(['test'])).rejects.toThrow(/Delegated platform-core failed/);
  expect(row).toBe(rows.length);
  expect(paths).toContain('/heartbeat');
  expect(intents).toBe(2);
  expect(f.processCall).toHaveBeenCalledTimes(1);
  expect(f.processCall.mock.calls[0]).toEqual([
    f.raw.localAcceptance.runtime.node.path,
    [
      '--no-global-search-paths',
      f.raw.localAcceptance.runtime.pnpm.path,
      '--filter',
      '@practicehub/platform-core',
      'run',
      'test:db',
    ],
    expect.any(Object),
  ]);
  expect(f.execute.mock.calls.length).toBe(sqlAtFailure);
  expect(f.http.mock.calls.length).toBe(httpAtFailure);
  expect(f.command.mock.calls.length).toBe(commandsAtFailure);
  expect(log.mock.calls.flat().join(' ')).not.toContain('synthetic_stack=OK');
});

it('direct executable boundary retains a referenced controlled owner through actual fixture-worker exit on UNKNOWN (C1)', () => {
  // Uses the SAME exported boundary called by the compiled executable branch.
  // Requires the normal package build, not a surrogate catch implementation.
  // Fixture Worker is real; it models retained ownership but is not the product
  // lane observer pool, so this is not product loader/cleanup/performance proof.
  const entry = pathToFileURL(fileURLToPath(new URL('../dist/cli.js', import.meta.url))).href;
  function script(caught: boolean): string {
    return `
      import { Worker } from 'node:worker_threads';
      import { once } from 'node:events';
      import { runLocalCliExecutable } from ${JSON.stringify(entry)};
      let ownerActive = true;
      let calls = 0;
      let laterEffects = 0;
      const held = new Worker(\`const {parentPort}=require('node:worker_threads');
        parentPort.postMessage('ready');
        parentPort.once('message',()=>setTimeout(()=>parentPort.close(),100));\`, {eval:true,execArgv:[],resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:8,stackSizeMb:2}});
      await once(held, 'message');
      held.once('exit', code => {
        ownerActive = false;
        process.stdout.write('CONTROLLED_OWNER_ACTUAL_EXIT ' + JSON.stringify({
          workerExit:code, ownerActive, calls, laterEffects, failureStatus:process.exitCode
        }) + '\\n');
      });
      // Already-owned finite cleanup is scheduled before the controlled UNKNOWN.
      held.postMessage('settle-existing-owner');
      const original = new Error('ORIGINAL_DIRECT_ENTRY_FAILURE');
      const unknown = new Error('CONTROLLED_CLEANUP_UNKNOWN', {cause:original});
      unknown.disposition = 'UNKNOWN';
      const operation = async () => { calls++; if (calls > 1) laterEffects++; throw unknown; };
      ${caught ? 'await runLocalCliExecutable(operation);' : 'await operation();'}
      // No new command/effect is started after failure. Only the already-owned
      // referenced fixture thread can emit its terminal observation.
    `;
  }
  const caught = launchDirectEntry(
    process.execPath,
    ['--input-type=module', '--eval', script(true)],
    {
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true,
    },
  );
  expect(caught.error).toBeUndefined();
  expect(caught.signal).toBeNull();
  expect(caught.status).toBe(1);
  expect(caught.stderr).toContain('ORIGINAL_DIRECT_ENTRY_FAILURE');
  expect(caught.stderr).toContain('CONTROLLED_CLEANUP_UNKNOWN');
  const marker = caught.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith('CONTROLLED_OWNER_ACTUAL_EXIT '));
  expect(marker).toBeDefined();
  const terminal = JSON.parse((marker ?? '').slice('CONTROLLED_OWNER_ACTUAL_EXIT '.length)) as {
    workerExit: number;
    ownerActive: boolean;
    calls: number;
    laterEffects: number;
    failureStatus: number;
  };
  expect(terminal).toEqual({
    workerExit: 0,
    ownerActive: false,
    calls: 1,
    laterEffects: 0,
    failureStatus: 1,
  });
  // Old-shape negative control: the uncaught module await exits before the
  // already-referenced owner reaches its actual exit observation.
  const uncaught = launchDirectEntry(
    process.execPath,
    ['--input-type=module', '--eval', script(false)],
    {
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true,
    },
  );
  expect(uncaught.error).toBeUndefined();
  expect(uncaught.status).toBe(1);
  expect(uncaught.stderr).toContain('CONTROLLED_CLEANUP_UNKNOWN');
  expect(uncaught.stdout).not.toContain('CONTROLLED_OWNER_ACTUAL_EXIT ');
});
