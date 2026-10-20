import { createHash } from 'node:crypto';
import type { spawnSync } from 'node:child_process';
import { createLocalCli, ProvisioningIncompleteError, loadMigrationBinding } from './cli.js';
import type { MigrationTransport, MigrationTarget } from './migrations.js';
import { createDockerMigrationTransport } from './migrations.js';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  composeArguments,
  loadLaneConfiguration,
  localDockerSelection,
  readPinnedFile,
  readLaneSource,
  verifyResolvedLaneConfiguration,
  type LaneConfiguration,
} from './compose-config.js';
it('rejects a real junction ancestor without trusting its regular target file', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ph-compose-link-')));
  try {
    const actual = join(root, 'actual');
    const link = join(root, 'link');
    mkdirSync(actual);
    writeFileSync(join(actual, 'override.json'), '{}');
    symlinkSync(actual, link, 'junction');
    expect(() => composeArguments(root, join(link, 'override.json'))).toThrow(/non-link/);
    rmSync(link);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('preserves base configuration by default', () =>
  expect(composeArguments('/repo')).toEqual([
    'compose',
    '--project-name',
    'practicehub',
    '--file',
    join('/repo', 'compose.yaml'),
  ]));
it('appends an explicit JSON override as an argv value even when its path has spaces', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ph-compose-')));
  try {
    const path = join(root, 'override file.json');
    writeFileSync(path, '{"services":{}}');
    expect(composeArguments(root, path)).toEqual([
      'compose',
      '--project-name',
      'practicehub',
      '--file',
      join(root, 'compose.yaml'),
      '--file',
      path,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it.each(['relative.json', ''])('rejects nonabsolute override %s', (path) =>
  expect(() => composeArguments('/repo', path)).toThrow(/absolute/),
);
it('rejects absent, directory, malformed and non-object overrides before Docker', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ph-compose-')));
  try {
    expect(() => composeArguments(root, join(root, 'missing.json'))).toThrow();
    expect(() => composeArguments(root, root)).toThrow(/regular/);
    for (const value of ['broken', '[]', 'null', '1']) {
      const path = join(root, 'override.json');
      writeFileSync(path, value);
      expect(() => composeArguments(root, path)).toThrow();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Actual dispatcher tests use explicit file pins and controlled transports only.
const scratchRoots: string[] = [];
beforeEach(() => {
  for (const key of Object.keys(process.env))
    if (/^(?:https?_proxy|all_proxy|node_use_env_proxy|DOCKER_.*|COMPOSE_.*)$/i.test(key))
      vi.stubEnv(key, '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
function requiredFixtureValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing required fixture value');
  return value;
}
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ph-lane-')));
  scratchRoots.push(root);
  const project = 'synthetic-isolated';
  const composePath = join(root, 'approved config.json');
  const lanePath = join(root, 'lane.json');
  const image = `sha256:${'c'.repeat(64)}`;
  const revision = 'd'.repeat(40);
  const config = {
    name: project,
    services: {
      'app-postgres': {
        image,
        labels: { 'org.opencontainers.image.revision': revision },
        ports: [],
      },
      'vendor-simulator': {
        image,
        labels: { 'org.opencontainers.image.revision': revision },
        ports: [{ target: 8090, published: '23090', host_ip: '127.0.0.1', protocol: 'tcp' }],
      },
    },
  };
  const configText = JSON.stringify(config);
  writeFileSync(composePath, configText);
  const dockerRoot = join(root, 'docker');
  mkdirSync(join(dockerRoot, 'cli-plugins'), { recursive: true });
  const configFile = join(dockerRoot, 'config.json');
  writeFileSync(configFile, '{}');
  const plugin = join(
    dockerRoot,
    'cli-plugins',
    process.platform === 'win32' ? 'docker-compose.exe' : 'docker-compose',
  );
  writeFileSync(plugin, 'synthetic-plugin-not-executable');
  const lane: LaneConfiguration = {
    version: 1,
    grant: 'unit-only',
    mode: 'operate',
    sourceCwd: root,
    docker: {
      endpoint: 'npipe:////./pipe/docker_engine',
      configFile: { path: configFile, sha256: digest('{}') },
      composePlugin: { path: plugin, sha256: digest('synthetic-plugin-not-executable') },
    },
    project,
    resolvedConfigSha256: digest(configText),
    composeFiles: [{ path: composePath, sha256: digest(configText) }],
    profiles: [],
    sourceFiles: [],
    services: {
      'app-postgres': { containerId: 'a'.repeat(64), imageId: image, revision, ports: [] },
      'vendor-simulator': {
        containerId: 'b'.repeat(64),
        imageId: image,
        revision,
        ports: [{ containerPort: '8090/tcp', hostIp: '127.0.0.1', hostPort: 23090 }],
      },
    },
    simulatorOrigin: 'http://127.0.0.1:23090',
  };
  const target: MigrationTarget = {
    containerId: 'a'.repeat(64),
    clusterSystemIdentifier: '7696560484942077986',
    databaseName: 'ph_cli_synthetic_unit',
    databaseUser: 'practicehub',
    grant: 'unit-only',
  };
  const calls = vi.fn(() => {
    throw new Error('Unexpected synchronous effect');
  });
  const transport = calls as unknown as typeof spawnSync;
  function inspect(name: string) {
    const service = requiredFixtureValue(lane.services[name]);
    return [
      {
        Id: service.containerId,
        Image: service.imageId,
        Config: {
          Labels: {
            'com.docker.compose.project': project,
            'com.docker.compose.service': name,
            'com.docker.compose.project.working_dir': root,
            'com.docker.compose.project.config_files': composePath,
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
    ];
  }
  // Model the fake daemon independently of the application admission checks.
  let mockProjectMode = lane.mode;
  const command = vi.fn<NonNullable<MigrationTransport['command']>>(async (argv) => {
    let stdout = '';
    if (argv.includes('config')) stdout = configText;
    else if (argv.includes('ps'))
      stdout = argv.includes('--quiet')
        ? mockProjectMode === 'provision'
          ? ''
          : requiredFixtureValue(
              requiredFixtureValue(lane.services[requiredFixtureValue(argv.at(-1))]).containerId,
            )
        : '{"State":"exited"}';
    else if (argv[0] === 'inspect')
      stdout = JSON.stringify(
        inspect(argv[1] === target.containerId ? 'app-postgres' : 'vendor-simulator'),
      );
    return { status: 0, stdout, stderr: '' };
  });
  const execute = vi.fn<MigrationTransport['execute']>(async (_target, sql) => {
    const text = sql.toString();
    const marker = /PH_MIGRATIONS_[0-9a-f-]+/.exec(text)?.[0];
    const hash = /\|([a-f0-9]{64})' FROM/.exec(text)?.[1];
    const count = (text.match(/INSERT INTO pg_temp.manifest VALUES/g) ?? []).length;
    return { status: 0, stdout: marker ? `${marker}|${count}|0|${hash}` : '', stderr: '' };
  });
  const bindDocker = vi.fn<NonNullable<MigrationTransport['bindDocker']>>((binding) => {
    localDockerSelection(binding);
  });
  const migration = { command, execute, bindDocker } satisfies MigrationTransport;
  const binding = { path: lanePath, sha256: '' };
  function pin(value: LaneConfiguration = lane) {
    const text = JSON.stringify(value);
    writeFileSync(lanePath, text);
    binding.sha256 = digest(text);
    mockProjectMode = value.mode;
  }
  // One genuine discoverable migration and all original seed inputs in exact source cwd.
  mkdirSync(join(root, 'modules/unit/migrations'), { recursive: true });
  writeFileSync(join(root, 'modules/unit/migrations/0001-unit.sql'), 'SELECT 1;');
  mkdirSync(join(root, 'infra/postgres/init'), { recursive: true });
  mkdirSync(join(root, 'infra/postgres/seed'), { recursive: true });
  writeFileSync(join(root, 'infra/postgres/init/002-seed.sql'), 'SELECT 2;');
  const seedNames = [
    '003-tenancy',
    '004-jurisdiction',
    '005-capability',
    '034-voice',
    '006-identity',
    '007-authn',
    '008-merge',
    '009-audit',
    '010-pdp',
    '011-consent',
    '012-events',
    '013-policy-clocks',
    '014-workitems',
    '015-elevation',
    '016-oncall',
    '017-documents',
    '018-documents-records',
    '019-vendor-registry',
    '020-synthgen-corpus',
    '021-threads',
    '022-paid-service-loop',
    '024-ai-gateway',
    '025-portal-intake',
    '027-analytics',
    '028-migration',
    '029-breach-case',
  ];
  for (const name of seedNames)
    writeFileSync(join(root, `infra/postgres/seed/${name}-seed.sql`), `SELECT '${name}';`);
  const sourceFiles = [
    { path: 'modules/unit/migrations/0001-unit.sql', sha256: digest('SELECT 1;') },
    { path: 'infra/postgres/init/002-seed.sql', sha256: digest('SELECT 2;') },
    ...seedNames.map((name) => ({
      path: `infra/postgres/seed/${name}-seed.sql`,
      sha256: digest(`SELECT '${name}';`),
    })),
  ];
  Object.assign(lane, { sourceFiles });
  pin();
  const options = { laneBinding: binding, target, transport: migration };
  return {
    root,
    lane,
    config,
    configText,
    binding,
    pin,
    options,
    target,
    calls,
    transport,
    command,
    execute,
    inspect,
    seedNames,
    bindDocker,
  };
}
it.each(['migrate', 'seed'])(
  'routes %s through exact approved source/container/database',
  async (action) => {
    const f = fixture();
    await createLocalCli(f.transport, undefined, undefined, f.options).main([action]);
    expect(f.execute).toHaveBeenCalled();
    expect(requiredFixtureValue(f.execute.mock.calls[0])[1].toString()).toContain(
      'CREATE TEMP TABLE manifest',
    );
    for (const [target] of f.execute.mock.calls) expect(target).toEqual(f.target);
    if (action === 'seed') {
      expect(f.execute).toHaveBeenCalledTimes(2 + f.seedNames.length);
      expect(f.execute.mock.calls.slice(1).map((call) => call[1].toString())).toEqual([
        'SELECT 2;',
        ...f.seedNames.map((name) => `SELECT '${name}';`),
      ]);
    }
    expect(f.calls).not.toHaveBeenCalled();
  },
);
it.each(['migrate', 'seed', 'up', 'sim'])(
  'refuses %s without lane before effects',
  async (action) => {
    const f = fixture();
    await expect(createLocalCli(f.transport).main([action, 'reset'])).rejects.toThrow(/lane/);
    expect(f.calls).not.toHaveBeenCalled();
    expect(f.command).not.toHaveBeenCalled();
  },
);
it.each(['reset', 'down', 'test'])(
  'preserves state on intentional %s scope refusal',
  async (action) => {
    const f = fixture();
    await expect(
      createLocalCli(f.transport, undefined, undefined, f.options).main([action]),
    ).rejects.toThrow(/grant|rebind|scope/i);
    expect(f.calls).not.toHaveBeenCalled();
    expect(f.command).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it.each(['project', 'files', 'cwd', 'image', 'revision', 'ports', 'cid'])(
  'rejects actual foreign %s identity before SQL',
  async (field) => {
    const f = fixture();
    const original = requiredFixtureValue(f.command.getMockImplementation());
    f.command.mockImplementation(async (argv, limits) => {
      if (argv[0] !== 'inspect') return original(argv, limits);
      const row = requiredFixtureValue(f.inspect('app-postgres')[0]);
      if (field === 'cid') row.Id = 'e'.repeat(64);
      else if (field === 'image') row.Image = `sha256:${'e'.repeat(64)}`;
      else if (field === 'ports')
        row.NetworkSettings.Ports['5432/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '55432' }];
      else {
        const labelKeys: Record<string, string> = {
          project: 'com.docker.compose.project',
          files: 'com.docker.compose.project.config_files',
          cwd: 'com.docker.compose.project.working_dir',
          revision: 'org.opencontainers.image.revision',
        };
        const key = requiredFixtureValue(labelKeys[field]);
        Object.assign(row.Config.Labels, { [key]: 'foreign' });
      }
      return { status: 0, stdout: JSON.stringify([row]), stderr: '' };
    });
    await expect(
      createLocalCli(f.transport, undefined, undefined, f.options).main(['migrate']),
    ).rejects.toThrow(/identity mismatch/);
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it.each(['pin', 'compose hash', 'origin', 'source', 'database'])(
  'rejects wrong %s before command or SQL',
  async (which) => {
    const f = fixture();
    if (which === 'pin') writeFileSync(f.binding.path, '{}');
    if (which === 'compose hash')
      writeFileSync(requiredFixtureValue(f.lane.composeFiles[0]).path, '{}');
    if (which === 'origin') f.pin({ ...f.lane, simulatorOrigin: 'http://127.0.0.1:58090' });
    const options = {
      ...f.options,
      ...(which === 'source' ? { root: resolve(f.root, '..') } : {}),
      ...(which === 'database'
        ? { target: { ...f.target, databaseUser: 'foreign' } as unknown as MigrationTarget }
        : {}),
    };
    await expect(
      createLocalCli(f.transport, undefined, undefined, options).main(['migrate']),
    ).rejects.toThrow();
    expect(f.command).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it.each(['${HOST_PORT}', 'env_file: unsafe.env', 'include: other.yaml', 'build: .'])(
  'refuses unresolved Compose input %s',
  (value) => {
    const f = fixture();
    writeFileSync(requiredFixtureValue(f.lane.composeFiles[0]).path, value);
    f.pin({
      ...f.lane,
      composeFiles: [
        { path: requiredFixtureValue(f.lane.composeFiles[0]).path, sha256: digest(value) },
      ],
    });
    expect(() => loadLaneConfiguration(f.binding)).toThrow(/dependency/);
  },
);
it('preserves partial provision failure and never migrates or creates a replacement binding', async () => {
  const f = fixture();
  const services = Object.fromEntries(
    Object.entries(f.lane.services).map(([name, service]) => {
      const rest = { ...service };
      delete rest.containerId;
      return [name, rest];
    }),
  );
  f.pin({ ...f.lane, mode: 'provision', services });
  const original = requiredFixtureValue(f.command.getMockImplementation());
  f.command.mockImplementation(async (argv, limits) =>
    argv.includes('up')
      ? { status: 17, stdout: 'one container started', stderr: 'second failed' }
      : original(argv, limits),
  );
  await expect(
    createLocalCli(f.transport, undefined, undefined, f.options).main(['up']),
  ).rejects.toBeInstanceOf(ProvisioningIncompleteError);
  expect(requiredFixtureValue(f.command.mock.calls.at(-1))[0]).toContain('--no-recreate');
  expect(f.execute).not.toHaveBeenCalled();
  expect(loadLaneConfiguration(f.binding).mode).toBe('provision');
});
it('provisions prebuilt approved services without requiring old CIDs or issuing migration authority', async () => {
  const f = fixture();
  const services = Object.fromEntries(
    Object.entries(f.lane.services).map(([name, service]) => {
      const rest = { ...service };
      delete rest.containerId;
      return [name, rest];
    }),
  );
  f.pin({ ...f.lane, mode: 'provision', services });
  await createLocalCli(f.transport, undefined, undefined, f.options).main(['provision']);
  expect(requiredFixtureValue(f.command.mock.calls.at(-1))[0]).toEqual(
    expect.arrayContaining(['up', '--no-build', '--pull', 'never', '--no-deps', '--no-recreate']),
  );
  expect(f.execute).not.toHaveBeenCalled();
  await expect(
    createLocalCli(f.transport, undefined, undefined, f.options).main(['migrate']),
  ).rejects.toThrow(/mode/);
});
it('refuses resolved configuration drift before provisioning', async () => {
  const f = fixture();
  const services = Object.fromEntries(
    Object.entries(f.lane.services).map(([name, service]) => {
      const rest = { ...service };
      delete rest.containerId;
      return [name, rest];
    }),
  );
  f.pin({ ...f.lane, mode: 'provision', services });
  f.command.mockResolvedValue({
    status: 0,
    stdout: JSON.stringify({ ...f.config, name: 'foreign' }),
    stderr: '',
  });
  await expect(
    createLocalCli(f.transport, undefined, undefined, f.options).main(['up']),
  ).rejects.toThrow(/configuration/);
  expect(f.command).toHaveBeenCalledOnce();
  expect(f.execute).not.toHaveBeenCalled();
});
it('stops seed after rejected or invalid migration readback', async () => {
  const f = fixture();
  f.execute.mockResolvedValue({ status: 0, stdout: 'unbound success', stderr: '' });
  await expect(
    createLocalCli(f.transport, undefined, undefined, f.options).main(['seed']),
  ).rejects.toThrow(/journal readback/);
  expect(f.execute).toHaveBeenCalledOnce();
});
it('does not continue seed while migration cleanup is pending', async () => {
  const f = fixture();
  let reject!: (reason: Error) => void;
  f.execute.mockImplementation(
    () =>
      new Promise((_, refusal) => {
        reject = refusal;
      }),
  );
  let settled = false;
  const result = createLocalCli(f.transport, undefined, undefined, f.options)
    .main(['seed'])
    .finally(() => {
      settled = true;
    });
  // Wait for dispatch after asynchronous batch validation; cleanup must still block seed.
  await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
  expect(f.execute).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  reject(new Error('backend release UNKNOWN'));
  await expect(result).rejects.toThrow(/UNKNOWN/);
  expect(f.execute).toHaveBeenCalledOnce();
});
it('refuses unsupervised commands for default process dispatcher', async () => {
  const f = fixture();
  await expect(
    createLocalCli(undefined, undefined, undefined, {
      ...f.options,
      transport: { execute: f.execute },
    }).main(['migrate']),
  ).rejects.toThrow(/Supervised/);
  expect(f.execute).not.toHaveBeenCalled();
});
it('refuses foreign simulator identity before any HTTP call, including direct probe', async () => {
  const f = fixture();
  const http = vi.fn<typeof fetch>();
  const original = requiredFixtureValue(f.command.getMockImplementation());
  f.command.mockImplementation(async (argv, limits) =>
    argv[0] === 'inspect'
      ? { status: 0, stdout: JSON.stringify(f.inspect('app-postgres')), stderr: '' }
      : original(argv, limits),
  );
  await expect(
    createLocalCli(f.transport, http, undefined, f.options).probeRailSimulator(),
  ).rejects.toThrow(/identity/);
  expect(http).not.toHaveBeenCalled();
});
it('rejects unknown argv without transports', async () => {
  const f = fixture();
  await expect(createLocalCli(f.transport).main(['typo'])).rejects.toThrow(/Unsupported/);
  expect(f.calls).not.toHaveBeenCalled();
});
it.each([false, true])(
  'executes the actual simulator recovery probe through controlled transports (bad replay=%s)',
  async (badReplay) => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ph-cli-recovery-')));
    try {
      const f = fixture();
      const { calls, transport } = f;
      let dispatches = 0;
      let sweeps = 0;
      const requests: string[] = [];
      const http: typeof fetch = async (input, options) => {
        expect(new URL(String(input)).origin).toBe(f.lane.simulatorOrigin);
        expect(options?.redirect).toBe('error');
        const path = new URL(String(input)).pathname;
        requests.push(path);
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        let body: unknown = {};
        if (path === '/healthz') body = { dataPolicy: 'synthetic-only', rails: 17, primitives: 18 };
        if (path === '/control/reset')
          body = { state: { effects: [], receipts: [], heartbeats: [] } };
        if (path === '/primitives')
          body = {
            catalog: Array.from({ length: 18 }, (_, i) => ({
              primitiveId: `X-${String(i + 1).padStart(2, '0')}`,
            })),
          };
        if (path === '/rails/RAIL-008/create-payment-intent') {
          dispatches++;
          if (dispatches === 1) throw new TypeError('controlled socket death');
          body = {
            response: { status: 'uncertain', attempts: 2, resendsExternalEffect: badReplay },
          };
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
      };
      const execution = createLocalCli(transport, http, undefined, f.options).probeRailSimulator();
      if (badReplay) await expect(execution).rejects.toThrow('did not reconcile');
      else await execution;
      expect(
        f.command.mock.calls.some(
          ([argv]) =>
            argv[0] === 'start' &&
            argv[1] === requiredFixtureValue(f.lane.services['vendor-simulator']).containerId,
        ),
      ).toBe(true);
      expect(calls).not.toHaveBeenCalled();
      expect(dispatches).toBe(2);
      expect(requests).toContain('/state');
      if (!badReplay) expect(requests).toContain('/heartbeat/RAIL-016');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each(['missing', 'changed', 'unlisted'])(
  'refuses %s source before migration SQL',
  async (mode) => {
    const f = fixture();
    if (mode === 'missing') rmSync(join(f.root, 'modules/unit/migrations/0001-unit.sql'));
    if (mode === 'changed')
      writeFileSync(join(f.root, 'modules/unit/migrations/0001-unit.sql'), 'SELECT 99;');
    if (mode === 'unlisted')
      writeFileSync(join(f.root, 'modules/unit/migrations/0002-extra.sql'), 'SELECT 2;');
    await expect(
      createLocalCli(f.transport, undefined, undefined, f.options).main(['migrate']),
    ).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
  },
);
it('refuses unlisted seed before any migration SQL', async () => {
  const f = fixture();
  f.pin({
    ...f.lane,
    sourceFiles: f.lane.sourceFiles.filter(
      (file) => !file.path.endsWith('029-breach-case-seed.sql'),
    ),
  });
  await expect(
    createLocalCli(f.transport, undefined, undefined, f.options).main(['seed']),
  ).rejects.toThrow(/Unlisted/);
  expect(f.execute).not.toHaveBeenCalled();
});
it('refuses ambient proxy before direct simulator effect', async () => {
  const f = fixture();
  vi.stubEnv('HTTP_PROXY', 'http://foreign.invalid');
  const http = vi.fn<typeof fetch>();
  await expect(
    createLocalCli(f.transport, http, undefined, f.options).main(['sim', 'reset']),
  ).rejects.toThrow(/proxy/);
  expect(http).not.toHaveBeenCalled();
  expect(f.command).not.toHaveBeenCalled();
});

it('loads a native-only first provision binding without inventing a target', async () => {
  const f = fixture();
  const path = join(f.root, 'native.json');
  const raw = JSON.stringify({
    version: 1,
    nativePaths: {
      executablePath: join(f.root, 'docker.exe'),
      powershellPath: join(f.root, 'pwsh.exe'),
      executableSha256: 'a'.repeat(64),
      powershellSha256: 'b'.repeat(64),
      powershellVersion: '7.6.5',
    },
  });
  writeFileSync(path, raw);
  const loaded = loadMigrationBinding(path, digest(raw));
  expect(loaded.target).toBeUndefined();
  expect(loaded.nativePaths?.powershellVersion).toBe('7.6.5');
  await expect(
    createLocalCli(f.transport, undefined, undefined, {
      ...loaded,
      laneBinding: f.binding,
      transport: f.options.transport,
    }).main(['migrate']),
  ).rejects.toThrow(/target/);
  expect(f.command).not.toHaveBeenCalled();
  expect(() => loadMigrationBinding(path, '0'.repeat(64))).toThrow(/SHA256/);
});

it('refuses provisioning existing service state rather than trusting an observed CID', async () => {
  const f = fixture();
  const services = Object.fromEntries(
    Object.entries(f.lane.services).map(([name, service]) => {
      const rest = { ...service };
      delete rest.containerId;
      return [name, rest];
    }),
  );
  f.pin({ ...f.lane, mode: 'provision', services });
  const original = requiredFixtureValue(f.command.getMockImplementation());
  f.command.mockImplementation(async (argv, limits) =>
    argv.includes('ps')
      ? { status: 0, stdout: 'a'.repeat(64), stderr: '' }
      : original(argv, limits),
  );
  await expect(
    createLocalCli(f.transport, undefined, undefined, f.options).main(['up']),
  ).rejects.toThrow(/existing service/);
  expect(f.command.mock.calls.some(([argv]) => argv.includes('up'))).toBe(false);
  expect(f.execute).not.toHaveBeenCalled();
});

it.each(['configs', 'secrets'])(
  'rejects referenced-only %s byte drift before up/SQL/HTTP',
  async (field) => {
    const f = fixture();
    const http = vi.fn<typeof fetch>();
    const indirect = join(f.root, 'synthetic-indirect.txt');
    writeFileSync(indirect, 'synthetic-before');
    const config = { ...f.config, [field]: { synthetic: { file: indirect } } };
    const text = JSON.stringify(config);
    writeFileSync(requiredFixtureValue(f.lane.composeFiles[0]).path, text);
    const services = Object.fromEntries(
      Object.entries(f.lane.services).map(([name, service]) => {
        const rest = { ...service };
        delete rest.containerId;
        return [name, rest];
      }),
    );
    f.pin({
      ...f.lane,
      mode: 'provision',
      services,
      resolvedConfigSha256: digest(text),
      composeFiles: [
        { path: requiredFixtureValue(f.lane.composeFiles[0]).path, sha256: digest(text) },
      ],
    });
    // Restricted v1 refuses the otherwise pinned reference before and after changing only its bytes.
    await expect(
      createLocalCli(f.transport, http, undefined, f.options).main(['up']),
    ).rejects.toThrow(/indirect/);
    writeFileSync(indirect, 'synthetic-after');
    await expect(
      createLocalCli(f.transport, http, undefined, f.options).main(['up']),
    ).rejects.toThrow(/indirect/);
    expect(() =>
      verifyResolvedLaneConfiguration({ ...f.lane, resolvedConfigSha256: digest(text) }, text),
    ).toThrow(/indirect/);
    expect(f.command).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
  },
);
it('admits expanded JSON with no indirect inputs', async () => {
  const f = fixture();
  expect(() => verifyResolvedLaneConfiguration(f.lane, f.configText)).not.toThrow();
  await createLocalCli(f.transport, undefined, undefined, f.options).main(['seed']);
  expect(f.execute).toHaveBeenCalledTimes(28);
});
it.each([
  String.raw`SELECT 1; \connect foreign`,
  String.raw`SELECT 1; \i foreign.sql`,
  String.raw`SELECT 1; \! echo foreign`,
  "SELECT :'foreign';",
  'SELECT :foreign;',
  'SELECT :"foreign";',
])('rejects active inline seed syntax across the complete batch: %s', async (sql) => {
  const f = fixture();
  const path = 'infra/postgres/seed/029-breach-case-seed.sql';
  writeFileSync(join(f.root, path), sql);
  f.pin({
    ...f.lane,
    sourceFiles: f.lane.sourceFiles.map((entry) =>
      entry.path === path ? { path, sha256: digest(sql) } : entry,
    ),
  });
  await expect(
    createLocalCli(f.transport, undefined, undefined, f.options).main(['seed']),
  ).rejects.toThrow(/psql/);
  expect(f.command).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
});
it('preserves seed SET/transaction, quoted backslashes, dollar bodies and comments', async () => {
  const f = fixture();
  const path = 'infra/postgres/seed/029-breach-case-seed.sql';
  const sql = String.raw`SET standard_conforming_strings=on; BEGIN; SELECT '\connect', E'\\i', 1::int; DO $body$ BEGIN RAISE NOTICE '\!'; END $body$; /* \connect */ -- \i
COMMIT;`;
  writeFileSync(join(f.root, path), sql);
  f.pin({
    ...f.lane,
    sourceFiles: f.lane.sourceFiles.map((entry) =>
      entry.path === path ? { path, sha256: digest(sql) } : entry,
    ),
  });
  await createLocalCli(f.transport, undefined, undefined, f.options).main(['seed']);
  expect(requiredFixtureValue(f.execute.mock.calls.at(-1))[1].toString()).toBe(sql);
});
it.each([
  'default context',
  'host',
  'config bytes',
  'plugin bytes',
  'extra plugin',
  'remote endpoint',
])('refuses Docker %s drift before empty-project provisioning', async (which) => {
  const f = fixture();
  const http = vi.fn<typeof fetch>();
  const services = Object.fromEntries(
    Object.entries(f.lane.services).map(([name, service]) => {
      const rest = { ...service };
      delete rest.containerId;
      return [name, rest];
    }),
  );
  f.pin({ ...f.lane, mode: 'provision', services });
  if (which === 'default context') vi.stubEnv('DOCKER_CONTEXT', 'wrong-empty-daemon');
  if (which === 'host') vi.stubEnv('DOCKER_HOST', 'tcp://foreign:2375');
  if (which === 'config bytes')
    writeFileSync(f.lane.docker.configFile.path, '{"currentContext":"foreign"}');
  if (which === 'plugin bytes') writeFileSync(f.lane.docker.composePlugin.path, 'foreign-plugin');
  if (which === 'extra plugin')
    writeFileSync(join(f.lane.docker.composePlugin.path, '..', 'docker-other'), 'foreign');
  if (which === 'remote endpoint')
    f.pin({
      ...f.lane,
      mode: 'provision',
      services,
      docker: { ...f.lane.docker, endpoint: 'tcp://foreign:2375' },
    });
  await expect(
    createLocalCli(f.transport, http, undefined, f.options).main(['provision']),
  ).rejects.toThrow();
  expect(f.command).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
  expect(http).not.toHaveBeenCalled();
});
it('uses explicit approved endpoint/config regardless of user-home default context', () => {
  const f = fixture();
  const selection = localDockerSelection(f.lane.docker, {
    USERPROFILE: 'unapproved-home',
    APPDATA: 'unapproved-home',
  });
  expect(selection.args).toEqual([
    '--host',
    f.lane.docker.endpoint,
    '--config',
    resolve(f.lane.docker.configFile.path, '..'),
  ]);
  expect(selection.env).toEqual({
    DOCKER_HOST: f.lane.docker.endpoint,
    DOCKER_CONFIG: resolve(f.lane.docker.configFile.path, '..'),
    COMPOSE_DISABLE_ENV_FILE: '1',
  });
});
it('refuses selector changes and rechecks plugin bytes after binding before a command spawn', async () => {
  const f = fixture();
  const spawn = vi.fn();
  const transport = createDockerMigrationTransport({
    supervisor: { admit: async () => {}, spawn, release: async () => {} },
  });
  requiredFixtureValue(transport.bindDocker).call(transport, f.lane.docker);
  expect(() =>
    requiredFixtureValue(transport.bindDocker).call(transport, {
      ...f.lane.docker,
      endpoint: 'npipe:////./pipe/foreign',
    }),
  ).toThrow(/selection changed/);
  writeFileSync(f.lane.docker.composePlugin.path, 'changed-after-admission');
  await expect(
    requiredFixtureValue(transport.command).call(transport, ['compose', 'up'], {
      timeoutMs: 10,
      cleanupMs: 10,
    }),
  ).rejects.toThrow(/SHA256/);
  expect(spawn).not.toHaveBeenCalled();
});

it('admits canonical regular files and refuses missing, directory, relative and normalized aliases', () => {
  const f = fixture();
  const path = join(f.root, 'CaseSensitive-pin.json');
  writeFileSync(path, '{}');
  const pinned = { path, sha256: digest('{}') };
  expect(readPinnedFile(pinned).toString()).toBe('{}');
  for (const invalid of [
    join(f.root, 'absent.json'),
    f.root,
    'CaseSensitive-pin.json',
    `${f.root}/./CaseSensitive-pin.json`,
    `${f.root}/missing/../CaseSensitive-pin.json`,
    join(f.root, 'casesensitive-pin.json'),
  ])
    expect(() => readPinnedFile({ ...pinned, path: invalid })).toThrow();
  expect(() => readPinnedFile({ ...pinned, sha256: digest('[]') })).toThrow(/SHA256/);
  for (const invalid of ['../escape.sql', './source.sql', 'a//b.sql', 'a/../b.sql', 'a\\b.sql'])
    expect(() => readLaneSource(f.lane, invalid)).toThrow(/relative/);
});

it('refuses an actual file symlink while preserving its regular target and foreign sentinel', () => {
  const f = fixture();
  const target = join(f.root, 'actual.json');
  const link = join(f.root, 'linked.json');
  const sentinel = join(f.root, 'foreign-sentinel.txt');
  writeFileSync(target, '{}');
  writeFileSync(sentinel, 'foreign-owned');
  expect(readPinnedFile({ path: target, sha256: digest('{}') }).toString()).toBe('{}');
  // A host without file-symlink privileges must report a failed control, not skip it.
  symlinkSync(target, link, 'file');
  try {
    expect(() => readPinnedFile({ path: link, sha256: digest('{}') })).toThrow(/non-link/);
    expect(readFileSync(target, 'utf8')).toBe('{}');
    expect(readFileSync(sentinel, 'utf8')).toBe('foreign-owned');
  } finally {
    rmSync(link);
  }
});

it('refuses ancestor replacement by a real junction even when target bytes and pins match', () => {
  const f = fixture();
  const original = join(f.root, 'ordinary');
  const moved = join(f.root, 'moved');
  mkdirSync(original);
  writeFileSync(join(original, 'pinned.json'), '{}');
  const pinned = { path: join(original, 'pinned.json'), sha256: digest('{}') };
  expect(readPinnedFile(pinned).toString()).toBe('{}');
  renameSync(original, moved);
  symlinkSync(moved, original, 'junction');
  try {
    expect(() => readPinnedFile(pinned)).toThrow(/non-link/);
    expect(readPinnedFile({ ...pinned, path: join(moved, 'pinned.json') }).toString()).toBe('{}');
    f.pin({ ...f.lane, sourceCwd: original });
    expect(() => loadLaneConfiguration(f.binding)).toThrow(/lane configuration/);
    expect(readFileSync(join(moved, 'pinned.json'), 'utf8')).toBe('{}');
  } finally {
    rmSync(original);
  }
});

it.each(['source', 'config', 'plugin'] as const)(
  'refuses same-size restored-mtime %s mutation between commands',
  async (kind) => {
    const f = fixture();
    const path =
      kind === 'source'
        ? join(f.root, 'infra/postgres/init/002-seed.sql')
        : kind === 'config'
          ? f.lane.docker.configFile.path
          : f.lane.docker.composePlugin.path;
    const original = readFileSync(path);
    const changed = Buffer.from(original);
    changed[0] = changed[0] === 88 ? 89 : 88;
    const fixedTime = new Date('2020-01-01T00:00:00Z');
    utimesSync(path, fixedTime, fixedTime);
    const before = statSync(path);
    const sentinel = join(f.root, 'foreign-sentinel.txt');
    writeFileSync(sentinel, 'foreign-owned');
    const command = requiredFixtureValue(f.command.getMockImplementation());
    f.command.mockImplementationOnce(async (...args) => {
      const result = await command(...args);
      writeFileSync(path, changed);
      utimesSync(path, before.atime, before.mtime);
      return result;
    });
    await expect(
      createLocalCli(f.transport, undefined, undefined, f.options).main(['seed']),
    ).rejects.toThrow(/SHA256/);
    expect(f.command).toHaveBeenCalledTimes(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(statSync(path).size).toBe(before.size);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(sentinel, 'utf8')).toBe('foreign-owned');
  },
);

it.each(['source', 'config', 'plugin'] as const)(
  'refuses same-size restored-mtime %s mutation between SQL effects',
  async (kind) => {
    const f = fixture();
    const path =
      kind === 'source'
        ? join(f.root, 'infra/postgres/init/002-seed.sql')
        : kind === 'config'
          ? f.lane.docker.configFile.path
          : f.lane.docker.composePlugin.path;
    const original = readFileSync(path);
    const changed = Buffer.from(original);
    changed[0] = changed[0] === 88 ? 89 : 88;
    const fixedTime = new Date('2020-01-01T00:00:00Z');
    utimesSync(path, fixedTime, fixedTime);
    const before = statSync(path);
    const sentinel = join(f.root, 'foreign-sentinel.txt');
    writeFileSync(sentinel, 'foreign-owned');
    const execute = requiredFixtureValue(f.execute.getMockImplementation());
    f.execute.mockImplementationOnce(async (...args) => {
      const result = await execute(...args);
      writeFileSync(path, changed);
      utimesSync(path, before.atime, before.mtime);
      return result;
    });
    await expect(
      createLocalCli(f.transport, undefined, undefined, f.options).main(['seed']),
    ).rejects.toThrow(/SHA256/);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(statSync(path).size).toBe(before.size);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(readFileSync(sentinel, 'utf8')).toBe('foreign-owned');
  },
);

it.each(['project', 'endpoint', 'mode'] as const)(
  'refuses a freshly repinned %s change between commands before using old argv',
  async (kind) => {
    const f = fixture();
    const command = requiredFixtureValue(f.command.getMockImplementation());
    f.command.mockImplementationOnce(async (...args) => {
      const result = await command(...args);
      if (kind === 'project') f.pin({ ...f.lane, project: 'different-project' });
      else if (kind === 'endpoint')
        f.pin({ ...f.lane, docker: { ...f.lane.docker, endpoint: 'npipe:////./pipe/foreign' } });
      else
        f.pin({
          ...f.lane,
          mode: 'provision',
          services: Object.fromEntries(
            Object.entries(f.lane.services).map(([name, service]) => {
              const rest = { ...service };
              delete rest.containerId;
              return [name, rest];
            }),
          ),
        });
      return result;
    });
    await expect(
      createLocalCli(f.transport, undefined, undefined, f.options).main(['seed']),
    ).rejects.toThrow(/Lane changed/);
    expect(f.command).toHaveBeenCalledTimes(1);
    expect(f.execute).not.toHaveBeenCalled();
  },
);

it('refuses bindDocker callback mutation of the admitted selector even with a fresh file pin', async () => {
  const f = fixture();
  f.bindDocker.mockImplementationOnce((binding) => {
    Object.assign(binding, { endpoint: 'npipe:////./pipe/foreign' });
    f.pin({ ...f.lane, docker: binding });
  });
  await expect(
    createLocalCli(f.transport, undefined, undefined, f.options).main(['seed']),
  ).rejects.toThrow(/Lane changed/);
  expect(f.command).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
});

it('refuses a repinned origin after final inspect before HTTP even at a fresh admission', async () => {
  const f = fixture();
  const http = vi.fn<typeof fetch>();
  const command = requiredFixtureValue(f.command.getMockImplementation());
  f.command.mockImplementation(async (...args) => {
    const result = await command(...args);
    if (
      args[0][0] === 'inspect' &&
      args[0][1] === requiredFixtureValue(f.lane.services['vendor-simulator']).containerId
    )
      f.pin({
        ...f.lane,
        simulatorOrigin: 'http://127.0.0.1:23091',
        services: {
          ...f.lane.services,
          'vendor-simulator': {
            ...requiredFixtureValue(f.lane.services['vendor-simulator']),
            ports: [{ containerPort: '8090/tcp', hostIp: '127.0.0.1', hostPort: 23091 }],
          },
        },
      });
    return result;
  });
  await expect(
    createLocalCli(f.transport, http, undefined, f.options).probeRailSimulator(),
  ).rejects.toThrow(/Lane changed/);
  expect(f.command).toHaveBeenCalledTimes(3);
  expect(http).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
});
