import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

import { tenantBindingSql } from '@practicehub/platform-core';
import { Client } from 'pg';

export const tenants = ['northwind-synthetic', 'riverbend-synthetic'] as const;
export const historical = '0066-wp075-inventory.sql';
export const forward = '0074-inventory-recall-events.sql';
export const rollback = '0074-inventory-recall-events.rollback.sql';
export const readMigration = (name: string): string =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');

/** A savepoint models per-migration atomicity inside the disposable fixture transaction.
 * Production journal/lifecycle evidence remains a separate integration gate. */
export async function atomicSql(client: Client, sql: string): Promise<void> {
  await client.query('SAVEPOINT inventory_migration');
  try {
    await client.query(sql);
    await client.query('RELEASE SAVEPOINT inventory_migration');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT inventory_migration');
    await client.query('RELEASE SAVEPOINT inventory_migration');
    throw error;
  }
}

export async function moduleSql(
  client: Client,
  tenant: string | undefined,
  sql: string,
  values: readonly unknown[] = [],
): Promise<readonly Record<string, unknown>[]> {
  return principalSql(client, 'module_inventory', tenant, sql, values);
}

/** Effective app/module role proof on the granted admin connection, not a login proof.
 * Undefined means genuinely absent: observe NULL and never SET/RESET that GUC.
 * Empty string explicitly binds empty and is a separate negative control. */
export async function principalSql(
  client: Client,
  principal: 'module_inventory' | 'practicehub_app',
  tenant: string | undefined,
  sql: string,
  values: readonly unknown[] = [],
): Promise<readonly Record<string, unknown>[]> {
  await client.query('SAVEPOINT inventory_module');
  try {
    await client.query(
      principal === 'module_inventory'
        ? 'SET LOCAL ROLE module_inventory'
        : 'SET LOCAL ROLE practicehub_app',
    );
    if (tenant !== undefined) {
      await client.query(
        tenant === '' ? "SET LOCAL practicehub.tenant_id = ''" : tenantBindingSql(tenant),
      );
    }
    const binding = await client.query<{ value: string | null }>(
      "SELECT current_setting('practicehub.tenant_id', true) value",
    );
    if (binding.rows[0]?.value !== (tenant === undefined ? null : tenant)) {
      throw new Error('Tenant control does not match the actual NULL/empty/bound GUC');
    }
    const result = await client.query(sql, [...values]);
    await client.query('RESET ROLE');
    await client.query('RELEASE SAVEPOINT inventory_module');
    return result.rows as Record<string, unknown>[];
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT inventory_module');
    await client.query('RELEASE SAVEPOINT inventory_module');
    throw error;
  }
}

/** Isolate row constraints from RLS using the already granted fixture owner.
 * No role/GUC changes; failures roll back only this statement's savepoint. */
export async function ownerSql(
  client: Client,
  sql: string,
  values: readonly unknown[] = [],
): Promise<readonly Record<string, unknown>[]> {
  await client.query('SAVEPOINT inventory_owner');
  try {
    const result = await client.query(sql, [...values]);
    await client.query('RELEASE SAVEPOINT inventory_owner');
    return result.rows as Record<string, unknown>[];
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT inventory_owner');
    await client.query('RELEASE SAVEPOINT inventory_owner');
    throw error;
  }
}

/** No default target, CREATE/DROP DATABASE, schema reset, role creation or credentials.
 * INT must provision an empty, explicitly marked disposable DB and existing safe roles.
 * All fixtures roll back. The advisory lock refuses another suite on the same target. */
export async function connectDisposable(): Promise<Client> {
  const host = process.env['PRACTICEHUB_DB_HOST'];
  const port = Number(process.env['PRACTICEHUB_DB_PORT']);
  const database = process.env['PRACTICEHUB_INVENTORY_DB_NAME'];
  const run = process.env['PRACTICEHUB_INVENTORY_DB_RUN'];
  const user = process.env['PRACTICEHUB_INVENTORY_DB_USER'];
  const password = process.env['PRACTICEHUB_INVENTORY_DB_PASSWORD'];
  if (
    process.env['PRACTICEHUB_INVENTORY_DB_PROOF'] !== 'synthetic-isolated' ||
    !host ||
    !['127.0.0.1', '::1'].includes(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !run ||
    !/^[a-z0-9]{1,16}$/.test(run) ||
    database !== `ph_inventory_proof_${run}` ||
    !user ||
    !password
  ) {
    throw new Error(
      'Inventory DB proof requires explicit synthetic-isolated grant, loopback host/port, run, exact disposable name and owner credentials',
    );
  }
  const client = new Client({
    host,
    port,
    database,
    user,
    password,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  try {
    await client.connect();
    const target = await client.query<{ name: string; marker: string; owner_safe: boolean }>(`
      SELECT current_database() name, shobj_description(d.oid,'pg_database') marker,
        (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) owner_safe
      FROM pg_database d WHERE datname=current_database()`);
    if (
      target.rows[0]?.name !== database ||
      target.rows[0]?.marker !== `PracticeHub inventory disposable proof: ${run}` ||
      target.rows[0]?.owner_safe !== true
    ) {
      throw new Error('Refusing unmarked/non-disposable target or non-admin fixture owner');
    }
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext(current_database()), 74) locked',
    );
    if (!lock.rows[0]?.locked)
      throw new Error('Disposable inventory proof target is already in use');
    const schemas = await client.query(
      "SELECT 1 FROM pg_namespace WHERE nspname IN ('inventory','platform_core')",
    );
    if (schemas.rows.length) throw new Error('Refusing populated target; no reset is permitted');
    const roles = await client.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('module_inventory','practicehub_app')",
    );
    if (roles.rows.length !== 2 || roles.rows.some((role) => role.rolsuper || role.rolbypassrls)) {
      throw new Error('Both pre-provisioned module/app roles must be NOSUPERUSER NOBYPASSRLS');
    }
    const membership = await client.query<{ member: boolean }>(
      "SELECT pg_has_role('practicehub_app','module_inventory','MEMBER') member",
    );
    if (!membership.rows[0]?.member)
      throw new Error(
        'Existing app/module membership required; suite may not provision cluster roles',
      );
    const binding = await client.query<{ value: string | null }>(
      "SELECT current_setting('practicehub.tenant_id', true) value",
    );
    if (binding.rows[0]?.value !== null) {
      throw new Error('Fresh proof connection must start with an actually absent tenant GUC');
    }
    const bound = proofBindingFromGrant();
    validateBinding(bound, await observeProofTarget(client));
    const posture = process.env['PRACTICEHUB_INVENTORY_ROLE_POSTURE'];
    requireProof(posture, 'explicit root role posture');
    const provenance = await roleProvenance(client);
    validateRolePosture(provenance, JSON.parse(posture) as unknown);
    fixtureProvenance.set(client, [{ phase: 'before-beginFixture', value: provenance }]);
    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}

/** Exact tenant prerequisite shape from 0001; bounded storage proof, not platform bootstrap. */
export async function beginFixture(client: Client): Promise<void> {
  await client.query('BEGIN');
  await client.query(`CREATE SCHEMA platform_core;
    CREATE TABLE platform_core.tenant (
      tenant_id text PRIMARY KEY CHECK (tenant_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
      display_name text NOT NULL,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
      synthetic boolean NOT NULL);
    INSERT INTO platform_core.tenant (tenant_id,display_name,synthetic)
      VALUES ('northwind-synthetic','Northwind Synthetic',true),
             ('riverbend-synthetic','Riverbend Synthetic',true);`);
  await recordRolePhase(client, 'before-original0066');
  await atomicSql(client, readMigration(historical));
  await recordRolePhase(client, 'after-original0066');
}

export async function seedHistorical(client: Client, asOwner = false): Promise<void> {
  for (const tenant of tenants) {
    for (const sql of [
      "INSERT INTO inventory.product VALUES ($1,'product:synthetic01',true)",
      "INSERT INTO inventory.lot VALUES ($1,'lot:synthetic01','product:synthetic01','2030-01-01',true)",
      "INSERT INTO inventory.unit VALUES ($1,'unit:synthetic01','lot:synthetic01',true)",
      "INSERT INTO inventory.dispense VALUES ($1,'dispense:synthetic01','2029-01-01',true)",
      "INSERT INTO inventory.dispense_unit VALUES ($1,'dispense:synthetic01','unit:synthetic01',true)",
      "INSERT INTO inventory.recall_unit VALUES ($1,'drill:synthetic01','lot:synthetic01','unit:synthetic01','dispense:synthetic01',true)",
    ])
      if (asOwner) await ownerSql(client, sql, [tenant]);
      else await moduleSql(client, tenant, sql, [tenant]);
  }
}

export async function snapshot(client: Client, tables: readonly string[]) {
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    if (!/^[a-z_]+$/.test(table)) throw new Error('Invalid fixture table');
    const rows = await client.query(
      `SELECT to_jsonb(t) value FROM inventory.${table} t ORDER BY to_jsonb(t)::text`,
    );
    const catalog = await client.query(
      `SELECT c.relname,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity,
      pg_get_userbyid(c.relowner) owner FROM pg_class c WHERE c.oid=$1::regclass`,
      [`inventory.${table}`],
    );
    const policies = await client.query(
      `SELECT polname,polcmd,polpermissive,polroles::text,
      pg_get_expr(polqual,polrelid) qual,pg_get_expr(polwithcheck,polrelid) check_expr
      FROM pg_policy WHERE polrelid=$1::regclass ORDER BY polname`,
      [`inventory.${table}`],
    );
    result[table] = {
      rows: rows.rows as unknown[],
      catalog: catalog.rows as unknown[],
      policies: policies.rows as unknown[],
    };
  }
  const memberships =
    await client.query(`SELECT roleid::regrole::text,member::regrole::text,grantor::regrole::text,admin_option,
    to_jsonb(pg_auth_members)->'inherit_option' inherit_option,
    to_jsonb(pg_auth_members)->'set_option' set_option
    FROM pg_auth_members WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('module_inventory','practicehub_app'))
      OR member IN (SELECT oid FROM pg_roles WHERE rolname IN ('module_inventory','practicehub_app')) ORDER BY roleid,member`);
  result['memberships'] = memberships.rows as unknown[];
  return result;
}

/** Proof-only identities are supplied by the separate physical grant. CID is
 * attested by the root's container observation; PostgreSQL supplies SID/OID.
 * This does not replace or weaken the shared two-cluster admission API. */
export interface ProofTarget {
  cid: string;
  sid: string;
  oid: string;
  database: string;
  marker: string;
  owner: string;
  pgVersion: string;
}
export interface ProofBinding {
  target: ProofTarget;
  sourceSha256: string;
  ownedRoot: string;
  artifactOwner: string;
  sourceEpoch: 'inventory-0074-seven';
  targetEpoch: 'inventory-0066-six';
  consumer: { mode: 'synthetic-proof'; version: 'inventory-0066-six'; compatible: true };
}
export interface EventDescriptor {
  path: string;
  sha256: string;
  bytes: number;
  count: number;
  binding: ProofBinding;
}
export const eventKeys = [
  'tenant_id',
  'recall_ref',
  'kind',
  'lot_ref',
  'actor',
  'reason',
  'event_on',
  'synthetic',
] as const;
export interface ProofEvent {
  tenant_id: string;
  recall_ref: string;
  kind: 'recalled' | 'released';
  lot_ref: string;
  actor: string;
  reason: string;
  event_on: string;
  synthetic: true;
}
const digestBytes = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b);
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function requireProof(ok: unknown, name: string): asserts ok {
  if (!ok) throw new Error(`Inventory proof refused: ${name}`);
}

/** Fail closed on directories, symlinks/junctions and any symlink ancestor.
 * The root already exists and is allocated to this proof; never create or adopt it here. */
function ownedPath(root: string, path: string): void {
  requireProof(isAbsolute(root) && isAbsolute(path), 'owned absolute path');
  requireProof(
    resolve(root) === root && resolve(path) === path && dirname(path) === root,
    'owned direct child path',
  );
  let cursor = root;
  for (;;) {
    const info = lstatSync(cursor);
    requireProof(info.isDirectory() && !info.isSymbolicLink(), 'owned nonsymlink root');
    if (cursor === parse(cursor).root) break;
    cursor = dirname(cursor);
  }
  requireProof(realpathSync(root) === root, 'owned canonical root');
}
export function validateBinding(expected: ProofBinding, observed: ProofTarget): void {
  requireProof(
    /^[a-f0-9]{64}$/.test(expected.target.cid) &&
      /^\d+$/.test(expected.target.sid) &&
      /^\d+$/.test(expected.target.oid) &&
      /^\d+$/.test(expected.target.pgVersion),
    'target identity shape',
  );
  requireProof(
    expected.target.database.startsWith('ph_inventory_proof_') &&
      expected.target.marker ===
        `PracticeHub inventory disposable proof: ${expected.target.database.slice(19)}` &&
      expected.target.owner.length > 0,
    'target marker',
  );
  requireProof(same(expected.target, observed), 'target identity');
  requireProof(
    /^[a-f0-9]{64}$/.test(expected.sourceSha256) && expected.artifactOwner.length > 0,
    'source identity',
  );
  requireProof(
    expected.sourceEpoch === 'inventory-0074-seven' &&
      expected.targetEpoch === 'inventory-0066-six',
    'source/target epoch',
  );
  requireProof(
    expected.consumer?.mode === 'synthetic-proof' &&
      expected.consumer.version === 'inventory-0066-six' &&
      expected.consumer.compatible === true,
    'compatible consumer posture',
  );
}
export function validateEventRows(input: unknown): ProofEvent[] {
  requireProof(Array.isArray(input) && input.length === 4, 'exact four mixed events');
  const seen = new Set<string>();
  for (const value of input) {
    requireProof(
      value !== null && typeof value === 'object' && !Array.isArray(value),
      'event object',
    );
    const row = value as Record<string, unknown>;
    requireProof(same(Object.keys(row).sort(), [...eventKeys].sort()), 'exact event keys');
    requireProof(
      tenants.some((tenant) => tenant === row['tenant_id']) && row['synthetic'] === true,
      'synthetic tenant/row',
    );
    requireProof(
      typeof row['recall_ref'] === 'string' &&
        /^recall:[a-z0-9][a-z0-9-]{7,63}$/.test(row['recall_ref']) &&
        typeof row['lot_ref'] === 'string' &&
        /^lot:[a-z0-9][a-z0-9-]{7,63}$/.test(row['lot_ref']),
      'event tokens',
    );
    requireProof(row['kind'] === 'recalled' || row['kind'] === 'released', 'event kind');
    requireProof(
      typeof row['actor'] === 'string' &&
        /^[a-z][a-z0-9-]{1,31}:[a-z0-9][a-z0-9-]{1,63}$/.test(row['actor']) &&
        (row['kind'] !== 'released' || row['actor'].startsWith('human:')),
      'event actor',
    );
    requireProof(
      typeof row['reason'] === 'string' && row['reason'].trim().length > 0,
      'event reason',
    );
    const date = row['event_on'];
    requireProof(
      typeof date === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        Number.isFinite(Date.parse(`${date}T00:00:00Z`)) &&
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date,
      'event date',
    );
    const key = `${String(row['tenant_id'])}/${String(row['kind'])}`;
    requireProof(!seen.has(key), 'one event kind per tenant');
    seen.add(key);
  }
  for (const tenant of tenants) {
    const pair = input.filter((row: ProofEvent) => row.tenant_id === tenant) as ProofEvent[];
    requireProof(
      pair.length === 2 &&
        pair[0]?.recall_ref === pair[1]?.recall_ref &&
        pair[0]?.lot_ref === pair[1]?.lot_ref,
      'paired tenant events',
    );
  }
  return input as ProofEvent[];
}
export function readEventArtifact(
  descriptor: EventDescriptor,
  expected: ProofBinding,
): ProofEvent[] {
  requireProof(same(descriptor.binding, expected), 'artifact binding');
  requireProof(/^[a-f0-9]{64}$/.test(descriptor.sha256), 'artifact digest shape');
  ownedPath(expected.ownedRoot, descriptor.path);
  requireProof(
    descriptor.path === join(expected.ownedRoot, `events-${descriptor.sha256}.json`),
    'content address',
  );
  validateOwnedRoot(expected);
  const stat = lstatSync(descriptor.path);
  requireProof(stat.isFile() && !stat.isSymbolicLink(), 'regular nonsymlink artifact');
  const bytes = readFileSync(descriptor.path);
  requireProof(
    bytes.length === descriptor.bytes && stat.size === descriptor.bytes,
    'artifact byte count',
  );
  requireProof(digestBytes(bytes) === descriptor.sha256, 'artifact digest');
  const rows = validateEventRows(JSON.parse(bytes.toString('utf8')) as unknown);
  requireProof(rows.length === descriptor.count, 'artifact row count');
  return rows;
}
export async function preserveEvents(
  client: Client,
  binding: ProofBinding,
): Promise<EventDescriptor> {
  requireProof(binding.sourceSha256 === inventorySourceSha256(), 'pinned source bytes');
  validateBinding(binding, await observeProofTarget(client));
  const result = await client.query<{ value: ProofEvent }>(
    'SELECT to_jsonb(t) value FROM inventory.lot_recall_event t ORDER BY tenant_id,recall_ref,kind',
  );
  const rows = validateEventRows(result.rows.map(({ value }) => value));
  const bytes = Buffer.from(`${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  const sha256 = digestBytes(bytes);
  const path = join(binding.ownedRoot, `events-${sha256}.json`);
  ownedPath(binding.ownedRoot, path);
  validateOwnedRoot(binding);
  try {
    writeFileSync(path, bytes, { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const descriptor = { path, sha256, bytes: bytes.length, count: rows.length, binding };
  readEventArtifact(descriptor, binding);
  return descriptor;
}
export function proofBindingFromGrant(): ProofBinding {
  const raw = process.env['PRACTICEHUB_INVENTORY_PROOF_BINDING'];
  requireProof(raw, 'explicit root proof binding');
  const binding = JSON.parse(raw) as ProofBinding;
  requireProof(binding.sourceSha256 === inventorySourceSha256(), 'pinned source bytes');
  return binding;
}
export async function observeProofTarget(client: Client): Promise<ProofTarget> {
  const cid = process.env['PRACTICEHUB_INVENTORY_ATTESTED_CID'];
  requireProof(cid && /^[a-f0-9]{64}$/.test(cid), 'root attested CID');
  const result = await client.query<Omit<ProofTarget, 'cid'>>(`
    SELECT system_identifier::text sid,d.oid::text oid,current_database() database,
      shobj_description(d.oid,'pg_database') marker,current_user::text owner,
      current_setting('server_version_num') "pgVersion"
    FROM pg_control_system(),pg_database d WHERE d.datname=current_database()`);
  const row = result.rows[0];
  requireProof(row, 'observed target');
  return { cid, ...row };
}

/** No password fields, including the masked pg_roles.rolpassword, are selected.
 * to_jsonb membership access is portable: pre-PG16 options are explicitly null. */
export async function roleProvenance(client: Client) {
  const roles = await client.query(`SELECT oid::text,rolname,rolsuper,rolinherit,rolcreaterole,
    rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil::text,
    rolconfig,shobj_description(oid,'pg_authid') comment FROM pg_roles
    WHERE rolname IN ('module_inventory','practicehub_app','inventory_proof_donor') ORDER BY rolname`);
  const memberships =
    await client.query(`SELECT roleid::regrole::text role,member::regrole::text member,
    grantor::regrole::text grantor,admin_option,to_jsonb(m)->'inherit_option' inherit_option,
    to_jsonb(m)->'set_option' set_option FROM pg_auth_members m
    WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('module_inventory','practicehub_app','inventory_proof_donor'))
       OR member IN (SELECT oid FROM pg_roles WHERE rolname IN ('module_inventory','practicehub_app','inventory_proof_donor'))
    ORDER BY roleid,member,grantor`);
  const settings = await client.query(`SELECT setdatabase::text,setrole::regrole::text,setconfig
    FROM pg_db_role_setting WHERE setrole IN
    (SELECT oid FROM pg_roles WHERE rolname IN ('module_inventory','practicehub_app','inventory_proof_donor'))
    ORDER BY setdatabase,setrole`);
  const dependencies =
    await client.query(`SELECT dbid::text,classid::regclass::text,objid::text,objsubid,
    refclassid::regclass::text,refobjid::regrole::text,deptype FROM pg_shdepend
    WHERE refclassid='pg_authid'::regclass AND refobjid IN
    (SELECT oid FROM pg_roles WHERE rolname IN ('module_inventory','practicehub_app','inventory_proof_donor'))
    ORDER BY dbid,classid,objid,objsubid,refobjid,deptype`);
  const acl = await client.query(`SELECT n.nspname,c.relname,c.oid::text oid,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) dbid,
    c.relkind,c.relowner::regrole::text owner,c.relacl::text,
    (SELECT pn.nspname || '.' || pc.relname FROM pg_index i
      JOIN pg_class pc ON pc.oid=i.indrelid JOIN pg_namespace pn ON pn.oid=pc.relnamespace
      WHERE i.indexrelid=c.oid) index_of,
    (SELECT jsonb_agg(jsonb_build_array(attnum,attacl::text) ORDER BY attnum)
      FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped) column_acl
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='inventory' ORDER BY c.relname`);
  const namespaceAcl = await client.query(`SELECT nspname,nspowner::regrole::text,nspacl::text
    FROM pg_namespace WHERE nspname='inventory'`);
  const defaultAcl = await client.query(`SELECT defaclrole::regrole::text,defaclnamespace::text,
    defaclobjtype,defaclacl::text FROM pg_default_acl ORDER BY defaclrole,defaclnamespace,defaclobjtype`);
  const version = await client.query("SELECT current_setting('server_version_num') version");
  return {
    origin: 'preprovisioned-controlled-fixture' as const,
    version: version.rows,
    roles: roles.rows,
    memberships: memberships.rows,
    settings: settings.rows,
    dependencies: dependencies.rows,
    acl: acl.rows,
    namespaceAcl: namespaceAcl.rows,
    defaultAcl: defaultAcl.rows,
  };
}
/** Only the exact event table and its one immutable primary index may vanish or
 * receive new OIDs. No blanket dependency/ACL omission: even an unexpected
 * event dependency remains in the comparison and therefore fails on removal.
 * Full raw witnesses stay in fixtureProvenance; this is a comparison projection. */
export function validateEventRoleTransition(
  before: Awaited<ReturnType<typeof roleProvenance>>,
  after: Awaited<ReturnType<typeof roleProvenance>>,
  phase: 'inverse' | 'reapply',
): void {
  type Witness = Record<string, unknown>;
  const isEvent = (row: Witness) =>
    row['nspname'] === 'inventory' &&
    ['lot_recall_event', 'lot_recall_event_pkey'].includes(String(row['relname']));
  const identities = (value: typeof before) => {
    const relations = value.acl.filter(isEvent) as Witness[];
    requireProof(
      relations.length === 2 &&
        relations.some(
          (row) =>
            row['relname'] === 'lot_recall_event' &&
            row['relkind'] === 'r' &&
            row['index_of'] === null,
        ) &&
        relations.some(
          (row) =>
            row['relname'] === 'lot_recall_event_pkey' &&
            row['relkind'] === 'i' &&
            row['index_of'] === 'inventory.lot_recall_event',
        ) &&
        relations.every(
          (row) => /^\d+$/.test(String(row['oid'])) && /^\d+$/.test(String(row['dbid'])),
        ) &&
        relations[0]?.['oid'] !== relations[1]?.['oid'],
      'exact event relation identities',
    );
    return relations;
  };
  const original = identities(before);
  const replacement = phase === 'reapply' ? identities(after) : [];
  if (phase === 'inverse')
    requireProof(!after.acl.some(isEvent), 'removed event relation identities');
  const project = (value: typeof before, relations: Witness[], remove: boolean) => {
    const allowedDependency = (row: Witness): Witness | undefined => {
      const relation = relations.find(
        (item) => item['oid'] === row['objid'] && item['dbid'] === row['dbid'],
      );
      if (
        !relation ||
        row['classid'] !== 'pg_class' ||
        row['refclassid'] !== 'pg_authid' ||
        row['objsubid'] !== 0
      )
        return undefined;
      // Only ownership of these exact relations and the table's module ACL.
      if (
        (row['deptype'] === 'o' && row['refobjid'] === relation['owner']) ||
        (row['deptype'] === 'a' &&
          relation['relname'] === 'lot_recall_event' &&
          row['refobjid'] === 'module_inventory')
      )
        return relation;
      return undefined;
    };
    return {
      ...value,
      acl: value.acl
        .flatMap((row: Witness) => {
          const relation = relations.find((item) => same(item, row));
          if (!relation) return [row];
          return remove ? [] : [{ ...row, oid: `event:${String(row['relname'])}` }];
        })
        .sort((a: Witness, b: Witness) => stable(a).localeCompare(stable(b))),
      dependencies: value.dependencies
        .flatMap((row: Witness) => {
          const relation = allowedDependency(row);
          if (!relation) return [row];
          return remove ? [] : [{ ...row, objid: `event:${String(relation['relname'])}` }];
        })
        .sort((a: Witness, b: Witness) => stable(a).localeCompare(stable(b))),
    };
  };
  requireProof(
    same(project(before, original, phase === 'inverse'), project(after, replacement, false)),
    'event-only role provenance transition',
  );
}

export function validateRolePosture(
  actual: Awaited<ReturnType<typeof roleProvenance>>,
  expected: unknown,
): void {
  requireProof(same(actual, expected), 'root-bound role posture');
  requireProof(
    actual.roles.length >= 2 &&
      actual.roles.length <= 3 &&
      ['module_inventory', 'practicehub_app'].every((name) =>
        actual.roles.some((role: Record<string, unknown>) => role['rolname'] === name),
      ) &&
      actual.roles.every(
        (role: Record<string, unknown>) =>
          role['rolsuper'] === false &&
          role['rolbypassrls'] === false &&
          role['rolcreaterole'] === false &&
          role['rolcreatedb'] === false &&
          role['rolreplication'] === false,
      ),
    'safe fixture roles',
  );
}

export async function eventCatalog(client: Client) {
  const result = await client.query(`SELECT jsonb_build_object(
    'schema',n.nspname,'owner',pg_get_userbyid(c.relowner),'kind',c.relkind,
    'persistence',c.relpersistence,'partition',c.relispartition,
    'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'acl',c.relacl::text,
    'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),
      a.attnotnull,a.attidentity,a.attgenerated,a.attcollation::text,pg_get_expr(d.adbin,d.adrelid),a.attacl::text)
      ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(contype,pg_get_constraintdef(oid),convalidated,
      condeferrable,condeferred) ORDER BY contype,pg_get_constraintdef(oid)) FROM pg_constraint WHERE conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(pg_get_indexdef(indexrelid) ORDER BY pg_get_indexdef(indexrelid)) FROM pg_index WHERE indrelid=c.oid),
    'policies',(SELECT jsonb_agg(jsonb_build_array(polname,polcmd,polpermissive,polroles::text,
      pg_get_expr(polqual,polrelid),pg_get_expr(polwithcheck,polrelid)) ORDER BY polname) FROM pg_policy WHERE polrelid=c.oid),
    'triggers',(SELECT count(*) FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal),
    'rules',(SELECT count(*) FROM pg_rewrite WHERE ev_class=c.oid),
    'inherits',(SELECT count(*) FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)) value
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='inventory' AND c.relname='lot_recall_event'`);
  return result.rows[0]?.value as Record<string, unknown> | undefined;
}
export interface InverseObservation {
  target: ProofTarget;
  epoch: 'inventory-0074-seven' | 'inventory-0066-six';
  catalog: Record<string, unknown> | undefined;
  roles: unknown;
}
export interface InverseExpectation {
  binding: ProofBinding;
  catalog: Record<string, unknown>;
  roles: unknown;
}
export function validateInverseObservation(
  observed: InverseObservation,
  expected: InverseExpectation,
): void {
  validateBinding(expected.binding, observed.target);
  requireProof(observed.epoch === 'inventory-0074-seven', 'inverse epoch');
  requireProof(
    expected.catalog['schema'] === 'inventory' &&
      expected.catalog['owner'] === expected.binding.target.owner,
    'event owner/schema',
  );
  requireProof(same(observed.catalog, expected.catalog), 'event catalog');
  requireProof(same(observed.roles, expected.roles), 'inverse role posture');
}
/** The action seam is intentionally small so pure tests can prove zero invocations.
 * The real adapter below observes first, then rereads disk immediately before SQL. */
export async function guardedInverse(
  descriptor: EventDescriptor,
  expected: InverseExpectation,
  observe: () => Promise<InverseObservation>,
  destructiveSql: () => Promise<void>,
): Promise<void> {
  validateInverseObservation(await observe(), expected);
  readEventArtifact(descriptor, expected.binding);
  await destructiveSql();
}
export async function observedEpoch(client: Client): Promise<InverseObservation['epoch']> {
  const result = await client.query<{
    relname: string;
    relkind: string;
    relrowsecurity: boolean;
    relforcerowsecurity: boolean;
  }>(
    `SELECT relname,relkind,relrowsecurity,relforcerowsecurity FROM pg_class c
     JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='inventory'
     AND relkind IN ('r','p','f') ORDER BY relname`,
  );
  const six = ['dispense', 'dispense_unit', 'lot', 'product', 'recall_unit', 'unit'];
  const names = result.rows.map(({ relname }) => relname);
  requireProof(
    result.rows.every(
      (row) => row.relkind === 'r' && row.relrowsecurity && row.relforcerowsecurity,
    ),
    'exact protected epoch',
  );
  if (same(names, six)) return 'inventory-0066-six';
  requireProof(same(names, [...six, 'lot_recall_event'].sort()), 'exact table epoch');
  return 'inventory-0074-seven';
}
export async function inverseFromArtifact(
  client: Client,
  descriptor: EventDescriptor,
  expected: InverseExpectation,
): Promise<void> {
  requireProof(expected.binding.sourceSha256 === inventorySourceSha256(), 'pinned source bytes');
  await guardedInverse(
    descriptor,
    expected,
    async () => ({
      target: await observeProofTarget(client),
      epoch: await observedEpoch(client),
      catalog: await eventCatalog(client),
      roles: await roleProvenance(client),
    }),
    async () => atomicSql(client, readMigration(rollback)),
  );
}
/** Restore has its own guard: inverse sentinels cannot stand in for this path.
 * Observation completes before a fresh disk read; rows are passed only to the
 * restore action. The real adapter and pure INSERT sentinels share this path. */
export async function guardedRestore(
  descriptor: EventDescriptor,
  expected: InverseExpectation,
  observe: () => Promise<InverseObservation>,
  insertRows: (rows: ProofEvent[]) => Promise<void>,
): Promise<void> {
  validateInverseObservation(await observe(), expected);
  const rows = readEventArtifact(descriptor, expected.binding);
  await insertRows(rows);
}
/** Test-only fault/sentinel hooks, requiring separate future fixture authority.
 * They cannot supply cached rows or replace the guard/action in the adapter. */
export interface RestoreProbe {
  afterObservation?: (observed: InverseObservation) => void | Promise<void>;
  beforeInsert?: () => void;
}
export async function restoreFromArtifact(
  client: Client,
  descriptor: EventDescriptor,
  expected: InverseExpectation,
  failAfterFirst = false,
  probe: RestoreProbe = {},
): Promise<void> {
  requireProof(expected.binding.sourceSha256 === inventorySourceSha256(), 'pinned source bytes');
  await guardedRestore(
    descriptor,
    expected,
    async () => {
      const observed = {
        target: await observeProofTarget(client),
        epoch: await observedEpoch(client),
        catalog: await eventCatalog(client),
        roles: await roleProvenance(client),
      };
      await probe.afterObservation?.(observed);
      return observed;
    },
    async (rows) => {
      await client.query('SAVEPOINT inventory_restore');
      try {
        const count = await client.query(
          'SELECT count(*)::int count FROM inventory.lot_recall_event',
        );
        requireProof(count.rows[0]?.count === 0, 'empty restore destination');
        for (const [index, row] of rows.entries()) {
          probe.beforeInsert?.();
          await moduleSql(
            client,
            row.tenant_id,
            `INSERT INTO inventory.lot_recall_event
          (${eventKeys.join(',')}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            eventKeys.map((key) => row[key]),
          );
          if (failAfterFirst && index === 0) throw new Error('Injected inventory restore failure');
        }
        await client.query('RELEASE SAVEPOINT inventory_restore');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT inventory_restore');
        await client.query('RELEASE SAVEPOINT inventory_restore');
        throw error;
      }
    },
  );
}

export const fixtureProvenance = new WeakMap<
  Client,
  { phase: string; value: Awaited<ReturnType<typeof roleProvenance>> }[]
>();
export async function recordRolePhase(client: Client, phase: string): Promise<void> {
  const entries = fixtureProvenance.get(client);
  requireProof(entries, 'admitted fixture provenance');
  entries.push({ phase, value: await roleProvenance(client) });
}

function validateOwnedRoot(binding: ProofBinding): void {
  const ownerFile = join(binding.ownedRoot, 'inventory-proof-owner.json');
  const ownerStat = lstatSync(ownerFile);
  requireProof(ownerStat.isFile() && !ownerStat.isSymbolicLink(), 'root ownership file');
  requireProof(
    same(JSON.parse(readFileSync(ownerFile, 'utf8')) as unknown, binding),
    'owned root binding',
  );
}

/** Root binds this exact ordered tuple of raw immutable SQL file digests. */
export function inventorySourceSha256(): string {
  return digestBytes(
    JSON.stringify(
      [historical, forward, rollback].map((name) => [
        name,
        digestBytes(readFileSync(new URL(`../migrations/${name}`, import.meta.url))),
      ]),
    ),
  );
}
export async function repeatInverseFromArtifact(
  client: Client,
  descriptor: EventDescriptor,
  binding: ProofBinding,
  expectedSixRoles: unknown,
): Promise<void> {
  requireProof(binding.sourceSha256 === inventorySourceSha256(), 'pinned source bytes');
  validateBinding(binding, await observeProofTarget(client));
  requireProof(
    (await observedEpoch(client)) === 'inventory-0066-six',
    'repeat inverse six-table epoch',
  );
  requireProof((await eventCatalog(client)) === undefined, 'repeat inverse absent event');
  requireProof(same(await roleProvenance(client), expectedSixRoles), 'repeat inverse role posture');
  readEventArtifact(descriptor, binding);
  await atomicSql(client, readMigration(rollback));
}
