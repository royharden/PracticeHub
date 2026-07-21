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
  psqlStdin(readFileSync(join(repoRoot, 'infra/postgres/seed/011-consent-seed.sql'), 'utf8'));
  console.log('seeded infra/postgres/seed/011-consent-seed.sql');
  psqlStdin(readFileSync(join(repoRoot, 'infra/postgres/seed/012-events-seed.sql'), 'utf8'));
  console.log('seeded infra/postgres/seed/012-events-seed.sql');
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
  const unprotected = scalar(
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
  const watermarkTables = scalar(
    "SELECT string_agg(quote_ident(n.nspname) || '.' || quote_ident(c.relname), '|' " +
      'ORDER BY n.nspname, c.relname) ' +
      'FROM pg_attribute a ' +
      'JOIN pg_class c ON c.oid = a.attrelid ' +
      'JOIN pg_namespace n ON n.oid = c.relnamespace ' +
      "WHERE a.attname = 'synthetic' AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r';",
  )
    .split('|')
    .filter(Boolean);
  if (watermarkTables.length === 0) {
    throw new Error('watermark probe found no synthetic-carrying module tables');
  }
  const unwatermarked = scalar(
    `SELECT ${watermarkTables
      .map((table) => `(SELECT count(*) FROM ${table} WHERE synthetic IS DISTINCT FROM true)`)
      .join(' + ')};`,
  );
  if (unwatermarked !== '0') {
    throw new Error(`module schemas hold ${unwatermarked} row(s) without the synthetic watermark`);
  }

  // WP-011: the jurisdiction registry is seeded and complete — the floor and
  // unknown packs present AND effective (ADR-ADJ-002 semantics 3: the
  // fail-closed substrate must be effective at every queriable as-of, so a
  // future-dated-only floor/unknown is a failure, not a fallback), and every
  // pack covering all 12 topics.
  const missingRequiredPacks = scalar(
    "SELECT count(*) FROM (VALUES ('floor'), ('unknown')) AS required(jurisdiction) " +
      'WHERE NOT EXISTS (SELECT FROM platform_core.jurisdiction_rule_pack p ' +
      'WHERE p.jurisdiction = required.jurisdiction AND p.effective_on <= current_date);',
  );
  if (missingRequiredPacks !== '0') {
    throw new Error(
      'jurisdiction registry is missing an effective floor and/or unknown safe-default pack',
    );
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

  // WP-018: the consent-operational capability sits at the package ceiling with
  // the opposite-state tenant proof (northwind scaffolded, riverbend disabled).
  const consentCapabilityStates = scalar(
    "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
      "FROM platform_core.capability_grant WHERE capability_id = 'consent.operational';",
  );
  if (consentCapabilityStates !== 'northwind-synthetic:scaffolded,riverbend-synthetic:disabled') {
    throw new Error(`consent capability tenant states differ: ${consentCapabilityStates}`);
  }

  // WP-018: STOP standing proof — the seeded sms/marketing consent is opted_out
  // by a STOP keyword (R6-REQ-072 / REQ-COMM-005), while sms/treatment stays
  // opted_in (care is not dropped).
  const stopPosture = scalar(
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
  const consentObligationProof = scalar(
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
  const orphanConsentStates = scalar(
    'SELECT count(*) FROM consent.consent_state s WHERE NOT EXISTS (' +
      'SELECT FROM consent.consent_event e WHERE e.tenant_id = s.tenant_id ' +
      'AND e.consent_event_id = s.last_event_id AND e.person_ref = s.person_ref ' +
      'AND e.scope_key = s.scope_key AND e.resulting_state = s.current_state ' +
      'AND e.effective_at = (SELECT max(e2.effective_at) FROM consent.consent_event e2 ' +
      'WHERE e2.tenant_id = s.tenant_id AND e2.person_ref = s.person_ref ' +
      'AND e2.scope_key = s.scope_key));',
  );
  const orphanConsentScopes = scalar(
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
  const eventSpineCapabilityStates = scalar(
    "SELECT string_agg(tenant_id || ':' || state, ',' ORDER BY tenant_id) " +
      "FROM platform_core.capability_grant WHERE capability_id = 'platform.event-spine';",
  );
  if (
    eventSpineCapabilityStates !== 'northwind-synthetic:scaffolded,riverbend-synthetic:disabled'
  ) {
    throw new Error(`event-spine capability tenant states differ: ${eventSpineCapabilityStates}`);
  }

  // WP-021: the seeded outbox posture holds at rest — three outbox events, two
  // published deliveries, two inbox dedup rows, and every outbox event carries a
  // delivery row (projection completeness; a published delivery is delivered
  // exactly once and never re-sent on replay).
  const eventSpinePosture = scalar(
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

  // WP-018: the consent DB suite (cross-tenant negatives, append-only event
  // log, structural scope/action CHECKs, projection sync) runs the same way.
  run('pnpm', ['--filter', '@practicehub/consent', 'run', 'test:db'], {
    stdio: 'inherit',
  });

  // WP-021: the event-spine DB suite (same-commit crash over the outbox,
  // exactly-once across a crash, inbox dedup, drain capability re-check,
  // append-only postures + cross-tenant negatives) runs the same way.
  run('pnpm', ['--filter', '@practicehub/events', 'run', 'test:db'], {
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
      'gipa_partition=OK audit_store=OK consent_ledger=OK event_spine=OK ' +
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
