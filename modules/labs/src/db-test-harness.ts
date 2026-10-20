import { readFileSync } from 'node:fs';

import { Client } from 'pg';

export const migration = (name: string): string =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
export const forward = migration('0073-labs-hardening.sql');
export const rollback = migration('0073-labs-hardening.rollback.sql');

/** No default target, database creation, reset, or destructive teardown.
 * The operator provisions a pristine synthetic proof DB and explicitly grants
 * transactional cluster-role effects. Each case ends in ROLLBACK, even on failure.
 * Pins are independent of connection fields and checked before the first write.
 */
export async function connectProof(): Promise<Client> {
  const env = process.env;
  const host = env['PRACTICEHUB_LABS_DB_HOST'];
  const port = Number(env['PRACTICEHUB_LABS_DB_PORT']);
  const permittedPort =
    (port >= 20000 && port <= 29999) ||
    (port === 55432 && env['PRACTICEHUB_LABS_DB_LEGACY_PORT_PIN'] === '55432');
  const database = env['PRACTICEHUB_LABS_DB_NAME'];
  const oid = env['PRACTICEHUB_LABS_DB_OID'];
  const system = env['PRACTICEHUB_LABS_DB_SYSTEM_ID'];
  const user = env['PRACTICEHUB_LABS_DB_USER'];
  const password = env['PRACTICEHUB_LABS_DB_PASSWORD'];
  if (
    env['PRACTICEHUB_LABS_DB_GRANT'] !== 'synthetic-rollback-only-with-role-effects' ||
    !host ||
    !['127.0.0.1', '::1'].includes(host) ||
    !Number.isInteger(port) ||
    !permittedPort ||
    !database ||
    !/^ph_labs_proof_[a-z0-9_]{1,32}$/.test(database) ||
    !oid ||
    !/^[1-9][0-9]*$/.test(oid) ||
    !system ||
    !/^[1-9][0-9]*$/.test(system) ||
    !user ||
    !password
  ) {
    throw new Error('Labs DB proof requires explicit synthetic grant and complete target pins');
  }
  const client = new Client({
    host,
    port,
    database,
    user,
    password,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    application_name: 'practicehub-labs-0073-proof',
  });
  try {
    await client.connect();
    const pin = await client.query<{
      database: string;
      oid: string;
      system: string;
      superuser: boolean;
      labs_absent: boolean;
      role_absent: boolean;
    }>(`SELECT current_database() AS database,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,
      (SELECT system_identifier::text FROM pg_control_system()) AS system,
      (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS superuser,
      to_regnamespace('labs') IS NULL AS labs_absent,
      NOT EXISTS (SELECT FROM pg_roles WHERE rolname='module_labs') AS role_absent`);
    const row = pin.rows[0];
    if (
      !row ||
      row.database !== database ||
      row.oid !== oid ||
      row.system !== system ||
      !row.superuser ||
      !row.labs_absent ||
      !row.role_absent
    ) {
      throw new Error('Labs DB target mismatch or non-pristine schema/cluster role');
    }
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(730064,74) AS locked',
    );
    if (!lock.rows[0]?.locked) throw new Error('Another labs proof owns this target');
    return client;
  } catch (error) {
    await client.end();
    throw error;
  }
}

export async function original(client: Client): Promise<void> {
  await client.query(`DO $proof$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='practicehub_app') THEN
      CREATE ROLE practicehub_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT;
    END IF;
  END $proof$;`);
  const app = await client.query<{ safe: boolean }>(`SELECT
    NOT rolsuper AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole
    AND NOT rolreplication AND rolinherit AND rolname<>current_user AS safe
    FROM pg_roles WHERE rolname='practicehub_app'`);
  if (app.rows.length !== 1 || !app.rows[0]?.safe) {
    throw new Error('Labs proof requires a distinct non-owner app role without RLS bypass');
  }
  await client.query(migration('0064-labs.sql'));
  await client.query(migration('0065-labs-device.sql'));
}

/** Failed real SQL is rolled back to a savepoint so its aftermath remains inspectable. */
export async function attempt(client: Client, sql: string): Promise<unknown> {
  await client.query('SAVEPOINT labs_probe');
  try {
    await client.query(sql);
    await client.query('RELEASE SAVEPOINT labs_probe');
    return undefined;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT labs_probe');
    await client.query('RELEASE SAVEPOINT labs_probe');
    return error;
  }
}

export async function snapshot(client: Client): Promise<unknown> {
  const result = await client.query<{ state: unknown }>(`SELECT jsonb_build_object(
    'columns', (SELECT jsonb_agg(to_jsonb(a) ORDER BY attrelid,attnum)
      FROM pg_attribute a WHERE attrelid IN (SELECT oid FROM pg_class WHERE relnamespace='labs'::regnamespace)),
    'constraints', (SELECT jsonb_agg(to_jsonb(c) ORDER BY oid) FROM pg_constraint c WHERE connamespace='labs'::regnamespace),
    'tables', (SELECT jsonb_agg(to_jsonb(c) ORDER BY oid) FROM pg_class c WHERE relnamespace='labs'::regnamespace),
    'policies', (SELECT jsonb_agg(to_jsonb(p) ORDER BY oid) FROM pg_policy p WHERE polrelid IN (SELECT oid FROM pg_class WHERE relnamespace='labs'::regnamespace)),
    'schema', (SELECT to_jsonb(n) FROM pg_namespace n WHERE nspname='labs'),
    'role', (SELECT to_jsonb(r) FROM pg_roles r WHERE rolname='module_labs'),
    'origin', (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname='module_labs'),
    'members', (SELECT jsonb_agg(to_jsonb(m) ORDER BY roleid,member,grantor) FROM pg_auth_members m
      WHERE roleid=(SELECT oid FROM pg_roles WHERE rolname='module_labs')
        OR member=(SELECT oid FROM pg_roles WHERE rolname='module_labs')),
    'role_settings', (SELECT jsonb_agg(to_jsonb(s) ORDER BY setdatabase,setrole) FROM pg_db_role_setting s
      WHERE setrole IN (SELECT oid FROM pg_roles WHERE rolname IN ('module_labs','practicehub_app') OR rolname LIKE 'labs_proof_%')),
    'shared_dependencies', (SELECT jsonb_agg(to_jsonb(d) ORDER BY dbid,classid,objid,objsubid,refclassid,refobjid,deptype)
      FROM pg_shdepend d WHERE refclassid='pg_authid'::regclass
        AND refobjid=(SELECT oid FROM pg_roles WHERE rolname='module_labs')),
    'related_roles', (SELECT jsonb_agg(to_jsonb(r) ORDER BY oid) FROM pg_roles r
      WHERE rolname='practicehub_app' OR rolname LIKE 'labs_proof_%'),
    'external_schemas', (SELECT jsonb_agg(to_jsonb(n) ORDER BY oid) FROM pg_namespace n WHERE nspname LIKE 'labs_proof_%'),
    'default_acls', (SELECT jsonb_agg(to_jsonb(a) ORDER BY oid) FROM pg_default_acl a WHERE defaclnamespace='labs'::regnamespace),
    'orders', (SELECT jsonb_agg(to_jsonb(x) ORDER BY tenant_id,order_id) FROM labs.lab_order x),
    'results', (SELECT jsonb_agg(to_jsonb(x) ORDER BY tenant_id,result_id) FROM labs.lab_result x),
    'closures', (SELECT jsonb_agg(to_jsonb(x) ORDER BY tenant_id,closure_id) FROM labs.critical_closure x),
    'ages', (SELECT jsonb_agg(to_jsonb(x) ORDER BY tenant_id,order_id) FROM labs.expected_result_age x),
    'calibrations', (SELECT jsonb_agg(to_jsonb(x) ORDER BY tenant_id,result_id) FROM labs.device_calibration x),
    'recalls', (SELECT jsonb_agg(to_jsonb(x) ORDER BY tenant_id,recall_id,result_id) FROM labs.device_recall x)
  ) AS state`);
  return result.rows[0]?.state;
}

/** Compare logical catalogs across successful DROP/recreate cycles; raw snapshot()
 * remains the stricter OID-inclusive oracle for failed SQL and exact replays.
 * NULL ACLs mean owner defaults; REVOKE can leave the equivalent explicit ACL.
 */
export async function recoveryCatalog(client: Client): Promise<unknown> {
  const result = await client.query<{ state: unknown }>(`SELECT jsonb_build_object(
    'columns', (SELECT jsonb_agg(jsonb_build_array(c.relname,a.attname,
      format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,
      a.attcollation::regcollation::text,pg_get_expr(d.adbin,d.adrelid),a.attacl)
      ORDER BY c.relname,a.attname)
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE c.relnamespace='labs'::regnamespace AND c.relkind='r'
        AND a.attnum>0 AND NOT a.attisdropped),
    'constraints', (SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,k.contype,
      pg_get_constraintdef(k.oid),k.convalidated,k.condeferrable,k.condeferred)
      ORDER BY c.relname,k.conname)
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
      WHERE k.connamespace='labs'::regnamespace),
    'indexes', (SELECT jsonb_agg(jsonb_build_array(tablename,indexname,indexdef)
      ORDER BY tablename,indexname) FROM pg_indexes WHERE schemaname='labs'),
    'tables', (SELECT jsonb_agg(jsonb_build_array(relname,relkind,
      pg_get_userbyid(relowner),relrowsecurity,relforcerowsecurity,
      coalesce(relacl,acldefault('r',relowner)))
      ORDER BY relname) FROM pg_class WHERE relnamespace='labs'::regnamespace),
    'policies', (SELECT jsonb_agg(to_jsonb(p) ORDER BY tablename,policyname)
      FROM pg_policies p WHERE schemaname='labs'),
    'schema', (SELECT jsonb_build_array(nspname,pg_get_userbyid(nspowner),
      coalesce(nspacl,acldefault('n',nspowner)))
      FROM pg_namespace WHERE nspname='labs'),
    'role', (SELECT to_jsonb(r)-'oid' FROM pg_roles r WHERE rolname='module_labs'),
    'origin', (SELECT shobj_description(oid,'pg_authid') FROM pg_roles WHERE rolname='module_labs'),
    'members', (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(roleid),
      pg_get_userbyid(member),pg_get_userbyid(grantor),admin_option,inherit_option,set_option)
      ORDER BY pg_get_userbyid(roleid),pg_get_userbyid(member),pg_get_userbyid(grantor))
      FROM pg_auth_members WHERE EXISTS (SELECT FROM pg_roles r
        WHERE r.rolname IN ('module_labs','practicehub_app')
          AND r.oid IN (roleid,member,grantor))),
    'role_settings', (SELECT jsonb_agg(jsonb_build_object(
      'database_binding', CASE WHEN s.setdatabase=0 THEN 'all-databases'
        WHEN d.datname=current_database() THEN 'current-database' ELSE 'other-database' END,
      'database', d.datname,
      'role_binding', CASE WHEN s.setrole=0 THEN 'all-roles' ELSE 'named-role' END,
      'role', r.rolname, 'setconfig', s.setconfig)
      ORDER BY s.setdatabase=0,d.datname,s.setrole=0,r.rolname)
      FROM pg_db_role_setting s
      LEFT JOIN pg_database d ON d.oid=s.setdatabase
      LEFT JOIN pg_roles r ON r.oid=s.setrole
      WHERE r.rolname IN ('module_labs','practicehub_app')
        OR (s.setrole=0 AND (s.setdatabase=0 OR d.datname=current_database()))),
    'app_role', (SELECT to_jsonb(r)-'oid' FROM pg_roles r WHERE rolname='practicehub_app'),
    'default_acls', (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(defaclrole),
      defaclobjtype,defaclacl) ORDER BY pg_get_userbyid(defaclrole),defaclobjtype)
      FROM pg_default_acl WHERE defaclnamespace='labs'::regnamespace)
  ) AS state`);
  return result.rows[0]?.state;
}
