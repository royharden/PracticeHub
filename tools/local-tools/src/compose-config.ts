import { observeLaneSourcesSync } from './lane-observation-context.ts';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, relative, sep } from 'node:path';

export interface PinnedFile {
  readonly path: string;
  readonly sha256: string;
}
export interface LocalDockerBinding {
  readonly endpoint: string;
  readonly configFile: PinnedFile;
  readonly composePlugin: PinnedFile;
}
/** Restricted public Docker config: explicit local socket, no context/home fallback. */
export function localDockerSelection(
  binding: LocalDockerBinding | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { args: string[]; env: NodeJS.ProcessEnv } {
  if (
    !binding ||
    !/^(?:npipe:\/{4}\.\/pipe\/[a-zA-Z0-9_-]+|unix:\/{3}[a-zA-Z0-9_./-]+)$/.test(
      binding.endpoint,
    ) ||
    binding.endpoint.includes('/../')
  )
    throw new Error('Approved local Docker endpoint required');
  keys(binding, ['endpoint', 'configFile', 'composePlugin']);
  for (const [key, value] of Object.entries(env))
    if (value && /^(?:DOCKER_|COMPOSE_)/i.test(key))
      throw new Error('Ambient Docker/context/Compose environment refused');
  keys(binding.configFile, ['path', 'sha256']);
  keys(binding.composePlugin, ['path', 'sha256']);
  const config = JSON.parse(readPinnedFile(binding.configFile).toString('utf8')) as unknown;
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).length)
    throw new Error('Restricted Docker config must be an empty object');
  const directory = resolve(binding.configFile.path, '..');
  const pluginDirectory = join(directory, 'cli-plugins');
  const pluginName = process.platform === 'win32' ? 'docker-compose.exe' : 'docker-compose';
  if (
    binding.configFile.path !== join(directory, 'config.json') ||
    binding.composePlugin.path !== join(pluginDirectory, pluginName) ||
    readdirSync(directory).sort().join('|') !== 'cli-plugins|config.json' ||
    readdirSync(pluginDirectory).join('|') !== pluginName
  )
    throw new Error('Controlled Docker config/plugin directory closure required');
  readPinnedFile(binding.composePlugin);
  return {
    args: ['--host', binding.endpoint, '--config', directory],
    env: { DOCKER_HOST: binding.endpoint, DOCKER_CONFIG: directory, COMPOSE_DISABLE_ENV_FILE: '1' },
  };
}

/** Expanded JSON only: unknown indirect file/device/provider inputs are not admitted. */
function restrictedCompose(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (
      [
        'configs',
        'secrets',
        'env_file',
        'label_file',
        'include',
        'extends',
        'build',
        'credential_spec',
        'develop',
        'provider',
        'devices',
        'device_cgroup_rules',
        'use_api_socket',
        'driver_opts',
      ].includes(key)
    )
      throw new Error('Unmodeled indirect Compose dependency refused');
    if (key === 'type' && item === 'bind')
      throw new Error('Indirect Compose bind dependency refused');
    restrictedCompose(item);
  }
}
export interface LaneService {
  readonly containerId?: string;
  readonly imageId: string;
  readonly revision: string;
  readonly ports: readonly {
    readonly containerPort: string;
    readonly hostIp: '127.0.0.1';
    readonly hostPort: number;
  }[];
}
export interface LaneConfiguration {
  readonly version: 1;
  readonly grant: string;
  readonly mode: 'operate' | 'provision';
  readonly sourceCwd: string;
  readonly migrationRoot?: string;
  readonly project: string;
  readonly resolvedConfigSha256: string;
  readonly composeFiles: readonly PinnedFile[];
  readonly profiles: readonly string[];
  readonly sourceFiles: readonly PinnedFile[];
  readonly services: Readonly<Record<string, LaneService>>;
  readonly simulatorOrigin: string;
  readonly docker: LocalDockerBinding;
}
export interface LaneBinding {
  readonly path: string;
  readonly sha256: string;
}
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export function readPinnedFile(file: PinnedFile): Buffer {
  if (
    !file ||
    typeof file.path !== 'string' ||
    !isAbsolute(file.path) ||
    resolve(file.path) !== file.path ||
    !/^[a-f0-9]{64}$/.test(file.sha256)
  )
    throw new Error('Absolute pinned file and SHA256 required');
  const stat = lstatSync(file.path);
  // Resolve through the OS on every read; never cache path or byte authority.
  // Exact equality still refuses redirected ancestors and noncanonical spelling.
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync.native(file.path) !== file.path)
    throw new Error('Pinned file must be regular non-link');
  const bytes = readFileSync(file.path);
  if (sha(bytes) !== file.sha256) throw new Error('Pinned file SHA256 mismatch');
  return bytes;
}
function keys(value: object, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Unknown lane configuration field');
}
export function loadLaneConfiguration(binding: LaneBinding | undefined): LaneConfiguration {
  if (!binding) throw new Error('Externally SHA-pinned approved lane configuration required');
  const lane = JSON.parse(readPinnedFile(binding).toString('utf8')) as LaneConfiguration;
  if (
    !lane ||
    lane.version !== 1 ||
    typeof lane.grant !== 'string' ||
    !lane.grant.trim() ||
    !['operate', 'provision'].includes(lane.mode) ||
    typeof lane.sourceCwd !== 'string' ||
    !isAbsolute(lane.sourceCwd) ||
    resolve(lane.sourceCwd) !== lane.sourceCwd ||
    !lstatSync(lane.sourceCwd).isDirectory() ||
    realpathSync.native(lane.sourceCwd) !== lane.sourceCwd ||
    !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(lane.project) ||
    !/^[a-f0-9]{64}$/.test(lane.resolvedConfigSha256) ||
    !Array.isArray(lane.composeFiles) ||
    !lane.composeFiles.length ||
    !Array.isArray(lane.profiles) ||
    lane.profiles.some((profile) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(profile)) ||
    new Set(lane.profiles).size !== lane.profiles.length ||
    !lane.services ||
    Array.isArray(lane.services)
  )
    throw new Error('Invalid lane configuration');
  keys(lane, [
    'version',
    'grant',
    'mode',
    'sourceCwd',
    'migrationRoot',
    'project',
    'resolvedConfigSha256',
    'composeFiles',
    'profiles',
    'sourceFiles',
    'services',
    'simulatorOrigin',
    'docker',
  ]);
  localDockerSelection(lane.docker);
  if (
    lane.migrationRoot !== undefined &&
    (typeof lane.migrationRoot !== 'string' ||
      !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(lane.migrationRoot))
  )
    throw new Error('Migration subroot must be an approved relative path');
  if (new Set(lane.composeFiles.map((file) => file.path)).size !== lane.composeFiles.length)
    throw new Error('Duplicate Compose file');
  // This first public contract requires fully expanded files. Implicit .env,
  // interpolation and indirect Compose inputs require a future closure contract.
  for (const file of lane.composeFiles) {
    keys(file, ['path', 'sha256']);
    const text = readPinnedFile(file).toString('utf8');
    if (/\$|\b(?:env_file|include|extends|build)\s*["']?\s*:/.test(text))
      throw new Error('Unresolved Compose environment/build/include dependency');
    restrictedCompose(JSON.parse(text));
    if (existsSync(join(resolve(file.path, '..'), '.env')))
      throw new Error('Implicit Compose .env refused');
  }
  if (existsSync(join(lane.sourceCwd, '.env'))) throw new Error('Implicit Compose .env refused');
  if (
    !Array.isArray(lane.sourceFiles) ||
    new Set(lane.sourceFiles.map((file) => file.path)).size !== lane.sourceFiles.length
  )
    throw new Error('Exact source file manifest required');
  observeLaneSourcesSync(
    lane.sourceFiles.map((file) => () => laneSourcePin(lane, file.path)),
    readPinnedFile,
  );
  for (const [name, service] of Object.entries(lane.services)) {
    if (
      !/^[a-z0-9][a-z0-9_-]*$/.test(name) ||
      !service ||
      (lane.mode === 'operate'
        ? !/^[a-f0-9]{64}$/.test(service.containerId ?? '')
        : service.containerId !== undefined) ||
      !/^sha256:[a-f0-9]{64}$/.test(service.imageId) ||
      !/^[a-f0-9]{40,64}$/.test(service.revision) ||
      !Array.isArray(service.ports)
    )
      throw new Error('Exact service image/revision/container binding required');
    keys(service, ['containerId', 'imageId', 'revision', 'ports']);
    for (const port of service.ports) {
      keys(port, ['containerPort', 'hostIp', 'hostPort']);
      if (
        !/^[1-9][0-9]{0,4}\/(tcp|udp)$/.test(port.containerPort) ||
        port.hostIp !== '127.0.0.1' ||
        !Number.isSafeInteger(port.hostPort) ||
        port.hostPort < 1024 ||
        port.hostPort > 65535
      )
        throw new Error('Bounded loopback service port required');
    }
  }
  if (!lane.services['app-postgres'] || !lane.services['vendor-simulator'])
    throw new Error('Database and simulator service bindings required');
  const origin = new URL(lane.simulatorOrigin);
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.origin !== lane.simulatorOrigin ||
    !lane.services['vendor-simulator'].ports.some(
      (port) => port.containerPort.endsWith('/tcp') && port.hostPort === Number(origin.port),
    )
  )
    throw new Error('Simulator origin must match approved loopback container port');
  return lane;
}
function laneSourcePin(lane: LaneConfiguration, path: string): PinnedFile {
  if (
    typeof path !== 'string' ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Source path must be relative beneath approved cwd');
  const absolute = resolve(lane.sourceCwd, path);
  const within = relative(lane.sourceCwd, absolute);
  if (within.startsWith(`..${sep}`) || isAbsolute(within))
    throw new Error('Source path escapes approved cwd');
  const entry = lane.sourceFiles.find((file) => file.path === path);
  if (!entry) throw new Error(`Unlisted approved source: ${path}`);
  keys(entry, ['path', 'sha256']);
  return { path: absolute, sha256: entry.sha256 };
}

export function readLaneSource(lane: LaneConfiguration, path: string): Buffer {
  return readPinnedFile(laneSourcePin(lane, path));
}

export function laneComposeArguments(lane: LaneConfiguration): string[] {
  return [
    'compose',
    '--project-directory',
    lane.sourceCwd,
    '--project-name',
    lane.project,
    ...lane.composeFiles.flatMap((file) => ['--file', file.path]),
    ...lane.profiles.flatMap((profile) => ['--profile', profile]),
  ];
}
/** Approval pins the full effective configuration, not just selected fields. */
export function verifyResolvedLaneConfiguration(lane: LaneConfiguration, raw: string): void {
  restrictedCompose(JSON.parse(raw));
  const config = JSON.parse(raw) as {
    name: string;
    services: Record<
      string,
      {
        image: string;
        labels?: Record<string, string>;
        build?: unknown;
        env_file?: unknown;
        volumes?: { type: string }[];
        ports?: { target: number; published: string; host_ip: string; protocol: string }[];
      }
    >;
  };
  if (
    sha(Buffer.from(JSON.stringify(config))) !== lane.resolvedConfigSha256 ||
    config.name !== lane.project ||
    JSON.stringify(Object.keys(config.services).sort()) !==
      JSON.stringify(Object.keys(lane.services).sort())
  )
    throw new Error('Resolved Compose configuration/project/service scope mismatch');
  for (const [name, expected] of Object.entries(lane.services)) {
    const actual = config.services[name];
    if (actual === null || actual === undefined)
      throw new Error(
        'Resolved service image/revision/ports or indirect build/mount input mismatch',
      );
    const ports = (actual.ports ?? [])
      .map((port) => `${port.target}/${port.protocol}|${port.host_ip}|${port.published}`)
      .sort();
    const approved = expected.ports
      .map((port) => `${port.containerPort}|${port.hostIp}|${port.hostPort}`)
      .sort();
    if (
      actual.image !== expected.imageId ||
      actual.labels?.['org.opencontainers.image.revision'] !== expected.revision ||
      actual.build !== undefined ||
      actual.env_file !== undefined ||
      actual.volumes?.some((volume) => volume.type !== 'volume') ||
      JSON.stringify(ports) !== JSON.stringify(approved)
    )
      throw new Error(
        'Resolved service image/revision/ports or indirect build/mount input mismatch',
      );
  }
}

/** Full inspect identity, including exact published-port set; observed state grants nothing. */
export function verifyLaneService(lane: LaneConfiguration, serviceName: string, raw: string): void {
  const expected = lane.services[serviceName];
  if (!expected?.containerId || lane.mode !== 'operate')
    throw new Error('Fresh external service binding required');
  const rows = JSON.parse(raw) as {
    Id: string;
    Image: string;
    Config: { Labels: Record<string, string> };
    NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> };
  }[];
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Expected one inspected service');
  const row = rows[0];
  if (row === null || row === undefined) throw new Error('Expected one inspected service');
  const labels = row.Config?.Labels;
  const actualPorts = Object.entries(row.NetworkSettings?.Ports ?? {})
    .flatMap(([containerPort, ports]) =>
      (ports ?? []).map((port) => `${containerPort}|${port.HostIp}|${port.HostPort}`),
    )
    .sort();
  const expectedPorts = expected.ports
    .map((port) => `${port.containerPort}|${port.hostIp}|${port.hostPort}`)
    .sort();
  if (
    row.Id !== expected.containerId ||
    row.Image !== expected.imageId ||
    labels?.['com.docker.compose.project'] !== lane.project ||
    labels['com.docker.compose.service'] !== serviceName ||
    labels['com.docker.compose.project.working_dir'] !== lane.sourceCwd ||
    labels['com.docker.compose.project.config_files'] !==
      lane.composeFiles.map((file) => file.path).join(',') ||
    labels['org.opencontainers.image.revision'] !== expected.revision ||
    JSON.stringify(actualPorts) !== JSON.stringify(expectedPorts)
  )
    throw new Error('Lane service container/project/files/image/revision/ports identity mismatch');
}

/** Harmless legacy configuration preview only; never supplies effect authority. */
export function composeArguments(root: string, override?: string): string[] {
  const args = ['compose', '--project-name', 'practicehub', '--file', join(root, 'compose.yaml')];
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new Error('PRACTICEHUB_COMPOSE_OVERRIDE must be absolute');
    const stat = lstatSync(override);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      realpathSync.native(override) !== resolve(override)
    )
      throw new Error('Compose override must be a regular non-link file');
    const data: unknown = JSON.parse(readFileSync(override, 'utf8'));
    if (data === null || typeof data !== 'object' || Array.isArray(data))
      throw new Error('Compose override must be a JSON object');
    args.push('--file', override);
  }
  return args;
}
