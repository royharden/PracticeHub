import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const composeArgs = [
  'compose',
  '--project-name',
  'practicehub',
  '--file',
  join(repoRoot, 'compose.yaml'),
];

function invocation(command: string, args: readonly string[]): { command: string; args: string[] } {
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
  const result = spawnSync(resolved.command, resolved.args, {
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

function psqlStdin(sql: string): void {
  run(
    'docker',
    [
      ...composeArgs,
      'exec',
      '--no-TTY',
      'app-postgres',
      'psql',
      '--username',
      'practicehub',
      '--dbname',
      'practicehub',
      '--quiet',
      '--set=ON_ERROR_STOP=1',
      '--file',
      '-',
    ],
    { input: sql },
  );
}

/**
 * Module migrations excluding rollback files (WP-010 pattern), ordered by the
 * numbered file name ACROSS modules (WP-013): the migration number is the
 * global apply order, so a module whose directory sorts before another
 * (identity < platform-core) still applies after the migrations it depends
 * on. Path order breaks ties for deterministic output.
 */
function moduleMigrationFiles(): string[] {
  const modulesDir = join(repoRoot, 'modules');
  const files: string[] = [];
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const migrationsDir = join(modulesDir, entry.name, 'migrations');
    if (!existsSync(migrationsDir)) {
      continue;
    }
    for (const file of readdirSync(migrationsDir).sort()) {
      if (file.endsWith('.sql') && !file.endsWith('.rollback.sql')) {
        files.push(join(migrationsDir, file));
      }
    }
  }
  return files.sort((left, right) => {
    const byName = basename(left).localeCompare(basename(right));
    return byName !== 0 ? byName : left.localeCompare(right);
  });
}

function migrate(): void {
  for (const file of moduleMigrationFiles()) {
    psqlStdin(readFileSync(file, 'utf8'));
    console.log(`migrated ${relative(repoRoot, file).split(sep).join('/')}`);
  }
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

function up(): void {
  run('pnpm', ['--filter', '@practicehub/vendor-simulator', 'build'], { stdio: 'inherit' });
  compose(['--profile', 'observability', 'up', '--detach', '--build', '--wait']);
  migrate();
}

function seed(): void {
  migrate();
  compose([
    'exec',
    '--no-TTY',
    'app-postgres',
    'psql',
    '--username',
    'practicehub',
    '--dbname',
    'practicehub',
    '--file',
    '/docker-entrypoint-initdb.d/002-seed.sql',
  ]);
  psqlStdin(readFileSync(join(repoRoot, 'infra/postgres/seed/003-tenancy-seed.sql'), 'utf8'));
  console.log('seeded infra/postgres/seed/003-tenancy-seed.sql');
  psqlStdin(readFileSync(join(repoRoot, 'infra/postgres/seed/004-jurisdiction-seed.sql'), 'utf8'));
  console.log('seeded infra/postgres/seed/004-jurisdiction-seed.sql');
  psqlStdin(readFileSync(join(repoRoot, 'infra/postgres/seed/005-capability-seed.sql'), 'utf8'));
  console.log('seeded infra/postgres/seed/005-capability-seed.sql');
  psqlStdin(readFileSync(join(repoRoot, 'infra/postgres/seed/006-identity-seed.sql'), 'utf8'));
  console.log('seeded infra/postgres/seed/006-identity-seed.sql');
  psqlStdin(readFileSync(join(repoRoot, 'infra/postgres/seed/007-authn-seed.sql'), 'utf8'));
  console.log('seeded infra/postgres/seed/007-authn-seed.sql');
  psqlStdin(readFileSync(join(repoRoot, 'infra/postgres/seed/008-merge-seed.sql'), 'utf8'));
  console.log('seeded infra/postgres/seed/008-merge-seed.sql');
  psqlStdin(readFileSync(join(repoRoot, 'infra/postgres/seed/009-audit-seed.sql'), 'utf8'));
  console.log('seeded infra/postgres/seed/009-audit-seed.sql');
  psqlStdin(readFileSync(join(repoRoot, 'infra/postgres/seed/010-pdp-seed.sql'), 'utf8'));
  console.log('seeded infra/postgres/seed/010-pdp-seed.sql');
}

function testLocal(): void {
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
    compose(['--profile', 'observability', 'ps', '--format', 'json'], 'pipe')
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

  const tenantRows = compose(
    [
      'exec',
      '--no-TTY',
      'app-postgres',
      'psql',
      '--username',
      'practicehub',
      '--dbname',
      'practicehub',
      '--tuples-only',
      '--no-align',
      '--command',
      "SELECT tenant_id || ':' || bootstrap_capability_state FROM platform_core.synthetic_tenant ORDER BY tenant_id;",
    ],
    'pipe',
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const expectedTenantRows = ['northwind-synthetic:simulated', 'riverbend-synthetic:disabled'];
  if (tenantRows.join('|') !== expectedTenantRows.join('|')) {
    throw new Error(`synthetic tenant states differ: ${tenantRows.join(', ')}`);
  }

  const scalar = (query: string): string =>
    compose(
      [
        'exec',
        '--no-TTY',
        'app-postgres',
        'psql',
        '--username',
        'practicehub',
        '--dbname',
        'practicehub',
        '--tuples-only',
        '--no-align',
        '--command',
        query,
      ],
      'pipe',
    ).trim();

  // WP-010/WP-013/WP-020: RLS on every module-schema table (live coverage probe).
  const unprotected = scalar(
    'SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
      "WHERE n.nspname IN ('platform_core', 'identity', 'audit_evidence') AND c.relkind = 'r' " +
      'AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);',
  );
  if (unprotected !== '0') {
    throw new Error(`module schemas have ${unprotected} table(s) without forced RLS`);
  }

  // WP-010/WP-011: synthetic watermark on every seeded platform_core row.
  const unwatermarked = scalar(
    'SELECT (SELECT count(*) FROM platform_core.tenant WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM platform_core.legal_entity WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM platform_core.location WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM platform_core.tenant_config WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM platform_core.jurisdiction_rule_pack WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM platform_core.jurisdiction_rule WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM platform_core.location_capture WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM platform_core.capability_event WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM platform_core.capability_grant WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.person WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.person_name WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.patient_record WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.staff_account WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.guarantor_role WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.proxy_grant WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.channel_endpoint WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.endpoint_association WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.source_identifier WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.identity_timeline WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.auth_credential WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.auth_device WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.auth_session WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.auth_challenge WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.account_lockdown WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.merge_case WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.merge_case_person WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.merge_event WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.merge_lineage WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.role_template WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.role_assignment WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.access_override WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.authority_record WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.person_flag WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.partition_tag WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM identity.gipa_authorization WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM audit_evidence.audit_event WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM audit_evidence.retention_schedule WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM audit_evidence.legal_hold WHERE synthetic IS DISTINCT FROM true) + ' +
      '(SELECT count(*) FROM audit_evidence.destruction_evidence WHERE synthetic IS DISTINCT FROM true);',
  );
  if (unwatermarked !== '0') {
    throw new Error(`module schemas hold ${unwatermarked} row(s) without the synthetic watermark`);
  }

  // WP-011: the jurisdiction registry is seeded and complete — the floor and
  // unknown packs present, and every pack covering all 12 topics.
  const missingRequiredPacks = scalar(
    "SELECT count(*) FROM (VALUES ('floor'), ('unknown')) AS required(jurisdiction) " +
      'WHERE NOT EXISTS (SELECT FROM platform_core.jurisdiction_rule_pack p ' +
      'WHERE p.jurisdiction = required.jurisdiction);',
  );
  if (missingRequiredPacks !== '0') {
    throw new Error('jurisdiction registry is missing the floor and/or unknown safe-default pack');
  }
  const incompletePacks = scalar(
    'SELECT count(*) FROM platform_core.jurisdiction_rule_pack p ' +
      'WHERE (SELECT count(*) FROM platform_core.jurisdiction_rule r ' +
      'WHERE r.jurisdiction = p.jurisdiction AND r.pack_version = p.version) <> 12;',
  );
  if (incompletePacks !== '0') {
    throw new Error(`${incompletePacks} jurisdiction pack(s) do not cover all 12 topics`);
  }

  // WP-012: capability registry seeded with the opposite-state tenant proof.
  const capabilityStates = scalar(
    "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
      "FROM platform_core.capability_grant WHERE capability_id = 'platform.capability-registry';",
  );
  const expectedCapabilityStates = 'northwind-synthetic:simulated,riverbend-synthetic:disabled';
  if (capabilityStates !== expectedCapabilityStates) {
    throw new Error(`capability registry tenant states differ: ${capabilityStates}`);
  }

  // WP-012: the grant projection matches the append-only event log both ways.
  const orphanGrants = scalar(
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
  const orphanStreams = scalar(
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
  const sharedEndpointPersons = scalar(
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
  const sharedEndpointDistinctPersons = scalar(
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
  const subMfaStaffSessions = scalar(
    "SELECT count(*) FROM identity.auth_session WHERE principal = 'staff' AND assurance <> 'aal2';",
  );
  if (subMfaStaffSessions !== '0') {
    throw new Error(`${subMfaStaffSessions} staff session(s) below aal2 — staff MFA is mandatory`);
  }

  // WP-014: per-role session policies are seeded for tenant 1 while tenant 2
  // deliberately carries none — the fail-to-stricter default is Riverbend's
  // posture (REQ-ID-024 exception 3), the standing opposite-config proof.
  const sessionPolicyRows = scalar(
    "SELECT string_agg(tenant_id || ':' || cnt, ',' ORDER BY tenant_id) FROM (" +
      'SELECT tenant_id, count(*) AS cnt FROM platform_core.tenant_config ' +
      "WHERE namespace = 'policy' AND key LIKE 'session-policy:%' GROUP BY tenant_id) p;",
  );
  if (sessionPolicyRows !== 'northwind-synthetic:3') {
    throw new Error(`session-policy config posture differs: ${sessionPolicyRows}`);
  }

  // WP-014: the authn capability sits at the package ceiling with the
  // opposite-state tenant proof (northwind scaffolded, riverbend disabled).
  const authnCapabilityStates = scalar(
    "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
      "FROM platform_core.capability_grant WHERE capability_id = 'identity.authn';",
  );
  if (authnCapabilityStates !== 'northwind-synthetic:scaffolded,riverbend-synthetic:disabled') {
    throw new Error(`authn capability tenant states differ: ${authnCapabilityStates}`);
  }

  // WP-016: merge governance standing proofs. Case posture — one resolved
  // acquisition merge plus one open specialized-pattern collision on tenant 1,
  // one open Riverbend case for the cross-tenant negatives.
  const mergeCaseStates = scalar(
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
  const aliasProof = scalar(
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
  const orphanMergedCases = scalar(
    'SELECT count(*) FROM identity.merge_case c ' +
      "WHERE c.status = 'resolved-merged' AND NOT EXISTS (" +
      'SELECT FROM identity.merge_event e ' +
      'WHERE e.tenant_id = c.tenant_id AND e.event_id = c.merge_event_id ' +
      "AND e.kind = 'merge' AND e.case_id = c.case_id);",
  );
  const orphanMergeEvents = scalar(
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
  const mergeCapabilityStates = scalar(
    "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
      "FROM platform_core.capability_grant WHERE capability_id = 'identity.merge-governance';",
  );
  if (mergeCapabilityStates !== 'northwind-synthetic:scaffolded,riverbend-synthetic:disabled') {
    throw new Error(`merge capability tenant states differ: ${mergeCapabilityStates}`);
  }

  // WP-015: PDP posture — Northwind carries the 8 canonical v1 role
  // templates while Riverbend deliberately carries NONE (an unresolvable
  // template is a deny; tenant 2 is the standing deny-by-default proof).
  const roleTemplatePosture = scalar(
    "SELECT string_agg(tenant_id || ':' || cnt, ',' ORDER BY tenant_id) FROM (" +
      'SELECT tenant_id, count(*) AS cnt FROM identity.role_template GROUP BY tenant_id) t;',
  );
  if (roleTemplatePosture !== 'northwind-synthetic:8') {
    throw new Error(`role-template posture differs: ${roleTemplatePosture}`);
  }

  // WP-015: the deceased chart-lock standing proof — the flag is SET with a
  // recorded confirmation source and no correction (REQ-ID-021 AC-3).
  const deceasedProof = scalar(
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
  const partitionProof = scalar(
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
    const states = scalar(
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
  const chainBreaks = scalar(
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
  const auditStreamProof = scalar(
    "SELECT (SELECT decision FROM audit_evidence.audit_event WHERE tenant_id = 'northwind-synthetic' AND audit_id = 'nae-0002') " +
      "|| '|' || (SELECT model_version FROM audit_evidence.audit_event WHERE tenant_id = 'northwind-synthetic' AND audit_id = 'nae-0003');",
  );
  if (auditStreamProof !== 'deny|claude-sonnet-5-synthetic') {
    throw new Error(`audit stream standing proof broken: ${auditStreamProof}`);
  }

  // WP-020: legal-hold posture — Northwind carries the ACTIVE hold (destruction
  // suspended), Riverbend the RELEASED hold retaining its evidence.
  const holdPosture = scalar(
    "SELECT string_agg(tenant_id || ':' || status, ',' ORDER BY tenant_id) " +
      'FROM audit_evidence.legal_hold;',
  );
  if (holdPosture !== 'northwind-synthetic:active,riverbend-synthetic:released') {
    throw new Error(`legal-hold posture differs: ${holdPosture}`);
  }

  // WP-020: the counsel-owned retention registry is seeded complete — every
  // record class carries its v1 entry.
  const retentionClasses = scalar(
    'SELECT count(*) FROM audit_evidence.retention_schedule WHERE version = 1;',
  );
  if (retentionClasses !== '6') {
    throw new Error(`retention schedule covers ${retentionClasses} of 6 record classes`);
  }

  // WP-020: the audit-store capability sits at the package ceiling with the
  // opposite-state tenant proof (northwind scaffolded, riverbend disabled).
  const auditCapabilityStates = scalar(
    "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
      "FROM platform_core.capability_grant WHERE capability_id = 'platform.audit-store';",
  );
  if (auditCapabilityStates !== 'northwind-synthetic:scaffolded,riverbend-synthetic:disabled') {
    throw new Error(`audit capability tenant states differ: ${auditCapabilityStates}`);
  }

  // WP-010: the DB-level cross-tenant negative suite runs against the live stack.
  run('pnpm', ['--filter', '@practicehub/platform-core', 'run', 'test:db'], {
    stdio: 'inherit',
  });

  // WP-013: the identity-schema DB suite (cross-tenant negatives, append-only
  // timeline, crosswalk uniqueness, opaque payment refs) runs the same way.
  run('pnpm', ['--filter', '@practicehub/identity', 'run', 'test:db'], {
    stdio: 'inherit',
  });

  // WP-020: the audit-evidence DB suite (append-only postures, per-stream
  // CHECKs, same-commit crash test, chain recompute) runs the same way.
  run('pnpm', ['--filter', '@practicehub/audit-evidence', 'run', 'test:db'], {
    stdio: 'inherit',
  });

  // WP-014: the dex federation e2e runs against the live compose dex —
  // discovery, mock-connector code flow, crosswalk mapping, and the
  // dark-by-registry denial proof.
  run('pnpm', ['--filter', '@practicehub/identity', 'run', 'test:federation'], {
    stdio: 'inherit',
  });

  console.log(
    `services_healthy=${services.size} tenants=${tenantRows.join(',')} ` +
      'rls_coverage=OK watermark=OK jurisdiction_packs=OK capability_registry=OK ' +
      'identity_model=OK authn_model=OK merge_governance=OK pdp_model=OK ' +
      'gipa_partition=OK audit_store=OK ' +
      'dex_federation=OK cross_tenant_db_suite=OK synthetic_stack=OK',
  );
}

const action = process.argv[2];
switch (action) {
  case 'doctor':
    doctor();
    break;
  case 'up':
    up();
    break;
  case 'migrate':
    migrate();
    break;
  case 'seed':
    seed();
    break;
  case 'test':
    testLocal();
    break;
  case 'down':
    compose(['--profile', 'observability', 'down']);
    break;
  case 'reset':
    compose(['--profile', 'observability', 'down', '--volumes', '--remove-orphans']);
    up();
    seed();
    break;
  default:
    throw new Error(`Unsupported local action: ${action ?? '(missing)'}`);
}
