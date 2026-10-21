import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from 'pg';

import {
  attempt,
  connectProof,
  forward,
  migration,
  original,
  recoveryCatalog,
  rollback,
  snapshot,
} from './db-test-harness.js';

const tables = [
  'lab_order',
  'lab_result',
  'critical_closure',
  'expected_result_age',
  'device_calibration',
  'device_recall',
] as const;
const tenants = ['northwind-synthetic', 'riverbend-synthetic'] as const;
const order = (tenant: string, id = 'o') => `INSERT INTO labs.lab_order
  (tenant_id,order_id,subject_ref,loinc_code,loinc_display,ordered_at,expected_result_by,status,service_request_id,synthetic)
  VALUES ('${tenant}','${id}','subject','123','Synthetic','2026-01-01','2026-01-02','awaiting-result','sr',true);`;
const result = (
  tenant: string,
  id = 'r',
  source = 'electronic',
  state = 'not-applicable',
  provisional = false,
  readback = "'7'",
) =>
  `INSERT INTO labs.lab_result (tenant_id,result_id,order_id,value_text,critical,recorded_at,source,provisional,reconciliation,read_back_by,read_back_at,read_back_value,observation_id,report_id,synthetic)
   VALUES ('${tenant}','${id}','o','7',true,'2026-01-01','${source}',${provisional},'${state}','actor','2026-01-01',${readback},'obs','report',true);`;
const closure = (tenant: string) => `INSERT INTO labs.critical_closure
  (tenant_id,closure_id,order_id,result_id,phase,paged_at,work_item_id,synthetic)
  VALUES ('${tenant}','c','o','r','paged','2026-01-01','work',true);`;
const seed = (tenant: string) =>
  order(tenant) +
  result(tenant) +
  closure(tenant) +
  `
  INSERT INTO labs.expected_result_age VALUES ('${tenant}','o','2026-01-03','2026-01-02','age',true);
  INSERT INTO labs.device_calibration VALUES ('${tenant}','r','device','lot','2025-12-31','synthetic',true);
  INSERT INTO labs.device_recall VALUES ('${tenant}','recall','device','lot','r','2026-01-04',true);`;
const supersede = `UPDATE labs.critical_closure SET phase='superseded',superseded_at='2026-01-02',superseded_by='actor',superseded_reason='synthetic adjudication';`;

describe('0073 real PostgreSQL storage and recovery proof', () => {
  let db: Client;
  beforeAll(async () => {
    db = await connectProof();
  });
  beforeEach(async () => {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await original(db);
    // Every mutation starts from a schema that has actually passed both DO bodies.
    // Restore the original catalog before the individual test creates its mutant.
    await db.query('SAVEPOINT labs_positive_baseline');
    await db.query(forward);
    await db.query(forward);
    await db.query(rollback);
    await db.query('ROLLBACK TO SAVEPOINT labs_positive_baseline');
    await db.query('RELEASE SAVEPOINT labs_positive_baseline');
  });
  afterEach(async () => {
    if (db) await db.query('ROLLBACK');
  });
  afterAll(async () => {
    if (db) await db.end();
  });

  async function rejected(sql: string, constraint?: string, code = '23514') {
    const error = await attempt(db, sql);
    expect(error).toMatchObject({ code, ...(constraint ? { constraint } : {}) });
  }

  async function unchangedFailure(
    sql: string,
    diagnostic: { code: string; message?: string; constraint?: string },
  ) {
    const before = await snapshot(db);
    expect(await attempt(db, sql)).toMatchObject(diagnostic);
    expect(await snapshot(db)).toEqual(before);
  }

  async function storedRows() {
    const rows: Record<string, unknown> = {};
    for (const table of tables) {
      rows[table] = (
        await db.query(`SELECT to_jsonb(x) -
        ARRAY['superseded_at','superseded_by','superseded_reason'] AS row
        FROM labs.${table} x ORDER BY to_jsonb(x)::text`)
      ).rows;
    }
    return rows;
  }

  it('denies all six tenant tables with an actually absent tenant setting', async () => {
    // Runs before any case sets this custom GUC; NULL is distinct from the empty binding below.
    expect(
      (await db.query("SELECT current_setting('practicehub.tenant_id',true) AS tenant")).rows,
    ).toEqual([{ tenant: null }]);
    for (const tenant of tenants) await db.query(seed(tenant));
    await db.query(forward);
    const fixtures = new Map<string, Record<string, unknown>>();
    for (const table of tables) {
      const fixture = await db.query<{ row: Record<string, unknown> }>(
        `SELECT to_jsonb(x) AS row FROM labs.${table} x WHERE tenant_id=$1`,
        [tenants[0]],
      );
      const row = fixture.rows[0]?.row;
      if (!row) throw new Error(`Missing absent-binding fixture for ${table}`);
      fixtures.set(table, row);
    }
    await db.query('SET LOCAL ROLE practicehub_app');
    for (const table of tables) {
      const row = fixtures.get(table);
      if (!row) throw new Error(`Missing absent-binding fixture for ${table}`);
      expect((await db.query(`SELECT count(*)::int n FROM labs.${table}`)).rows).toEqual([
        { n: 0 },
      ]);
      await rejected(
        `INSERT INTO labs.${table} SELECT (jsonb_populate_record(NULL::labs.${table}, '${JSON.stringify(row).replaceAll("'", "''")}'::jsonb)).*`,
        undefined,
        '42501',
      );
    }
    await db.query('RESET ROLE');
  });

  it('observes proof-database app settings drift and preserves unrelated settings through recovery', async () => {
    // what_bug_this_catches: pg_roles alone omits per-database role settings.
    // Only this proof DB is changed; the outer transaction restores its exact prior row.
    const target = (await db.query<{ name: string }>('SELECT current_database() AS name')).rows[0];
    if (!target) throw new Error('Missing proof database name');
    const database = `"${target.name.replaceAll('"', '""')}"`;
    const before = await recoveryCatalog(db);
    await db.query('SAVEPOINT labs_settings_observer');
    await db.query(`ALTER ROLE practicehub_app IN DATABASE ${database}
      SET practicehub.observer_probe = 'synthetic baseline'`);
    const baseline = await recoveryCatalog(db);
    expect(baseline).not.toEqual(before);
    expect(baseline).toMatchObject({
      role_settings: expect.arrayContaining([
        {
          database_binding: 'current-database',
          database: target.name,
          role_binding: 'named-role',
          role: 'practicehub_app',
          setconfig: expect.arrayContaining(['practicehub.observer_probe=synthetic baseline']),
        },
      ]),
    });
    await db.query('SAVEPOINT labs_settings_drift');
    await db.query(`ALTER ROLE practicehub_app IN DATABASE ${database}
      SET practicehub.observer_probe = 'synthetic drift'`);
    expect(await recoveryCatalog(db)).not.toEqual(baseline);
    await db.query('ROLLBACK TO SAVEPOINT labs_settings_drift');
    await db.query('RELEASE SAVEPOINT labs_settings_drift');
    expect(await recoveryCatalog(db)).toEqual(baseline);
    await preservesRecoveryBaseline(baseline);
    await db.query('ROLLBACK TO SAVEPOINT labs_settings_observer');
    await db.query('RELEASE SAVEPOINT labs_settings_observer');
    expect(await recoveryCatalog(db)).toEqual(before);
  });

  it('observes unrelated app membership edges, grantor and options and preserves them through recovery', async () => {
    // what_bug_this_catches: module-only edges omit incoming/outgoing app edges
    // and app-granted edges whose endpoints are both unrelated synthetic roles.
    // PostgreSQL records ordinary superuser membership grants under the bootstrap role.
    const grantor = (
      await db.query<{ name: string }>('SELECT rolname AS name FROM pg_roles WHERE oid=10')
    ).rows[0];
    if (!grantor) throw new Error('Missing bootstrap membership grantor');
    const before = await recoveryCatalog(db);
    await db.query('SAVEPOINT labs_members_observer');
    await db.query(`CREATE ROLE labs_proof_observer_parent NOLOGIN;
      CREATE ROLE labs_proof_observer_guest NOLOGIN;
      GRANT labs_proof_observer_parent TO practicehub_app
        WITH ADMIN TRUE, INHERIT FALSE, SET TRUE;
      GRANT practicehub_app TO labs_proof_observer_guest
        WITH ADMIN FALSE, INHERIT FALSE, SET FALSE;
      GRANT labs_proof_observer_parent TO labs_proof_observer_guest
        WITH ADMIN FALSE, INHERIT FALSE, SET FALSE GRANTED BY practicehub_app;`);
    const baseline = await recoveryCatalog(db);
    expect(baseline).not.toEqual(before);
    expect(baseline).toMatchObject({
      members: expect.arrayContaining([
        ['labs_proof_observer_parent', 'practicehub_app', grantor.name, true, false, true],
        ['practicehub_app', 'labs_proof_observer_guest', grantor.name, false, false, false],
        [
          'labs_proof_observer_parent',
          'labs_proof_observer_guest',
          'practicehub_app',
          false,
          false,
          false,
        ],
      ]),
    });
    for (const change of [
      'GRANT practicehub_app TO labs_proof_observer_guest WITH ADMIN TRUE',
      'GRANT practicehub_app TO labs_proof_observer_guest WITH INHERIT TRUE',
      'GRANT practicehub_app TO labs_proof_observer_guest WITH SET TRUE',
      `REVOKE labs_proof_observer_parent FROM labs_proof_observer_guest GRANTED BY practicehub_app;
       GRANT labs_proof_observer_parent TO labs_proof_observer_guest WITH ADMIN FALSE, INHERIT FALSE, SET FALSE`,
    ]) {
      await db.query('SAVEPOINT labs_members_drift');
      await db.query(change);
      expect(await recoveryCatalog(db)).not.toEqual(baseline);
      await db.query('ROLLBACK TO SAVEPOINT labs_members_drift');
      await db.query('RELEASE SAVEPOINT labs_members_drift');
      expect(await recoveryCatalog(db)).toEqual(baseline);
    }
    await preservesRecoveryBaseline(baseline);
    await db.query('ROLLBACK TO SAVEPOINT labs_members_observer');
    await db.query('RELEASE SAVEPOINT labs_members_observer');
    expect(await recoveryCatalog(db)).toEqual(before);
  });

  async function preservesRecoveryBaseline(baseline: unknown) {
    await db.query(forward);
    const hardened = await recoveryCatalog(db);
    const hardenedRaw = await snapshot(db);
    await db.query(forward);
    expect(await snapshot(db)).toEqual(hardenedRaw);
    await db.query(rollback);
    expect(await recoveryCatalog(db)).toEqual(baseline);
    const originalRaw = await snapshot(db);
    await db.query(rollback);
    expect(await snapshot(db)).toEqual(originalRaw);
    await db.query(forward);
    expect(await recoveryCatalog(db)).toEqual(hardened);
    await db.query(rollback);
    expect(await recoveryCatalog(db)).toEqual(baseline);
  }

  it.each(['pg_temp', 'labs'] as const)(
    'detects the actual inverse audit-column drop-order regression in %s independently',
    async (schema) => {
      // what_bug_this_catches: the temporary failure must not mask the same live defect.
      // Mutate exactly one ALTER prefix in the actual candidate, leaving the other correct.
      const constraints =
        '  DROP CONSTRAINT critical_closure_phase_check, DROP CONSTRAINT critical_closure_steps,';
      const columns =
        '  DROP COLUMN superseded_at, DROP COLUMN superseded_by, DROP COLUMN superseded_reason,';
      const prefix = `ALTER TABLE ${schema}.critical_closure
  DROP CONSTRAINT critical_closure_superseded_only_when_superseded,
`;
      const correct = `${prefix}${constraints}\n${columns}`;
      const broken = `${prefix}${columns}\n${constraints}`;
      expect(rollback.split(correct).length - 1).toBe(1);
      expect(rollback.split(broken).length - 1).toBe(0);
      const mutant = rollback.replace(correct, broken);
      expect(mutant.split(broken).length - 1).toBe(1);
      expect(mutant.split(correct).length - 1).toBe(0);
      const other = schema === 'pg_temp' ? 'labs' : 'pg_temp';
      const otherCorrect = correct.replace(`ALTER TABLE ${schema}.`, `ALTER TABLE ${other}.`);
      expect(mutant.split(otherCorrect).length - 1).toBe(1);

      for (const tenant of tenants) await db.query(seed(tenant));
      await db.query(forward);
      const hardened = await snapshot(db);
      await db.query(forward);
      expect(await snapshot(db)).toEqual(hardened);
      const error = await attempt(db, mutant);
      expect(error).toMatchObject({
        code: '42704',
        message:
          'constraint "critical_closure_steps" of relation "critical_closure" does not exist',
        where: expect.stringContaining(`SQL statement "${broken}`),
      });
      expect(await snapshot(db)).toEqual(hardened);
    },
  );

  it('fresh original prefix upgrades, replays exactly, and preserves six forced-RLS tables', async () => {
    await db.query(forward);
    const before = await snapshot(db);
    await db.query(forward);
    expect(await snapshot(db)).toEqual(before);
    await db.query(migration('0064-labs.sql'));
    await db.query(migration('0065-labs-device.sql'));
    // Historical files recreate policies; then forward validation must still accept them.
    await db.query(forward);
    const count = await db.query<{ n: number }>(`SELECT count(*)::int n FROM pg_class
      WHERE relnamespace='labs'::regnamespace AND relkind='r' AND relrowsecurity AND relforcerowsecurity`);
    expect(count.rows[0]?.n).toBe(6);
  });

  it('original rejects a final manual result while 0073 accepts its explicit adjudicated shape', async () => {
    await db.query(order(tenants[0]));
    await rejected(result(tenants[0], 'r', 'manual', 'adjudicated-manual', false));
    await db.query(forward);
    await db.query(result(tenants[0], 'r', 'manual', 'adjudicated-manual', false));
  });

  it('preserves compatible prior data, device relationships and null supersession audit', async () => {
    for (const tenant of tenants) await db.query(seed(tenant));
    const before = await storedRows();
    await db.query(forward);
    expect(await storedRows()).toEqual(before);
    for (const table of tables)
      expect((await db.query(`SELECT count(*)::int n FROM labs.${table}`)).rows).toEqual([
        { n: 2 },
      ]);
    expect(
      (
        await db.query(
          'SELECT count(*)::int n FROM labs.critical_closure WHERE superseded_at IS NULL AND superseded_by IS NULL AND superseded_reason IS NULL',
        )
      ).rows,
    ).toEqual([{ n: 2 }]);
  });

  it.each(['manual', 'electronic', 'device'])(
    'refuses original-valid incompatible %s adjudication without backfill',
    async (source) => {
      await db.query(
        order(tenants[0]) +
          result(tenants[0], 'r', source, 'adjudicated-manual', source === 'manual'),
      );
      await unchangedFailure(forward, {
        code: '23514',
        constraint: 'lab_result_provisional_shape',
      });
    },
  );

  it('proves original SQL UNKNOWN allows null read-back; upgrade refuses it, final check rejects it', async () => {
    await db.query(order(tenants[0]) + result(tenants[0], 'r', 'manual', 'pending', true, 'NULL'));
    expect((await db.query('SELECT read_back_value FROM labs.lab_result')).rows).toEqual([
      { read_back_value: null },
    ]);
    await unchangedFailure(forward, { code: '23514', constraint: 'lab_result_manual_read_back' });
    await db.query("DELETE FROM labs.lab_result WHERE result_id='r'");
    await db.query(forward);
    await rejected(
      result(tenants[0], 'r', 'manual', 'pending', true, 'NULL'),
      'lab_result_manual_read_back',
    );
    await db.query(result(tenants[0], 'r', 'manual', 'pending', true));
  });

  it.each(['manual', 'electronic', 'device'])(
    'enforces every %s provisional state with positive and negative controls',
    async (source) => {
      await db.query(order(tenants[0]));
      await db.query(forward);
      const states = [
        'not-applicable',
        'pending',
        'matched',
        'conflict',
        'adjudicated-manual',
        'adjudicated-electronic',
      ];
      for (const [index, state] of states.entries()) {
        const provisional =
          source === 'manual'
            ? state !== 'adjudicated-manual'
            : ['conflict', 'adjudicated-manual'].includes(state);
        await db.query(result(tenants[0], `good${index}`, source, state, provisional));
        await rejected(
          result(tenants[0], `bad${index}`, source, state, !provisional),
          'lab_result_provisional_shape',
        );
      }
    },
  );

  it('rejects missing and mismatched manual read-back components independently', async () => {
    await db.query(order(tenants[0]));
    await db.query(forward);
    await db.query(result(tenants[0], 'r', 'manual', 'pending', true));
    for (const change of [
      'read_back_by=NULL',
      'read_back_at=NULL',
      'read_back_value=NULL',
      "read_back_value='8'",
    ]) {
      await rejected(`UPDATE labs.lab_result SET ${change}`, 'lab_result_manual_read_back');
    }
  });

  it('original rejects superseded phase; final accepts complete audit and rejects each malformed shape', async () => {
    await db.query(seed(tenants[0]));
    await rejected("UPDATE labs.critical_closure SET phase='superseded'");
    await db.query(forward);
    await db.query(supersede);
    for (const change of [
      'superseded_at=NULL',
      'superseded_by=NULL',
      'superseded_reason=NULL',
      "closed_at='2026-01-03'",
    ]) {
      await rejected(`UPDATE labs.critical_closure SET ${change}`, 'critical_closure_steps');
    }
    await rejected(
      "UPDATE labs.critical_closure SET superseded_by='BAD ACTOR'",
      'critical_closure_superseded_by_check',
    );
    await rejected(
      "UPDATE labs.critical_closure SET superseded_reason=''",
      'critical_closure_superseded_reason_check',
    );
    await rejected(
      "UPDATE labs.critical_closure SET phase='paged'",
      'critical_closure_superseded_only_when_superseded',
    );
    await unchangedFailure(rollback, {
      code: 'P0001',
      message: '0073 rollback refuses supersession audit',
    });
  });

  it('retains original closure step checks and forbids audit on non-superseded rows', async () => {
    await db.query(seed(tenants[0]));
    await db.query(forward);
    await rejected("UPDATE labs.critical_closure SET phase='unknown'");
    for (const change of [
      "superseded_at='2026-01-02'",
      "superseded_by='actor'",
      "superseded_reason='reason'",
    ]) {
      await rejected(
        `UPDATE labs.critical_closure SET ${change}`,
        'critical_closure_superseded_only_when_superseded',
      );
    }
    await rejected(
      "UPDATE labs.critical_closure SET phase='acknowledged'",
      'critical_closure_steps',
    );
    await db.query(
      "UPDATE labs.critical_closure SET phase='acknowledged',acknowledged_at='2026-01-02',acknowledged_by='actor'",
    );
    await rejected("UPDATE labs.critical_closure SET phase='contacted'", 'critical_closure_steps');
    await db.query(
      "UPDATE labs.critical_closure SET phase='contacted',contacted_at='2026-01-02',contact_evidence='call'",
    );
    await rejected("UPDATE labs.critical_closure SET phase='closed'", 'critical_closure_steps');
    await db.query(
      "UPDATE labs.critical_closure SET phase='closed',closed_at='2026-01-02',closed_by='actor'",
    );
  });

  it.each(tables)(
    'enforces tenant reads/writes, empty-binding access and least-privilege ACL on %s',
    async (table) => {
      for (const tenant of tenants) await db.query(seed(tenant));
      await db.query(forward);
      const fixture = await db.query<{ row: Record<string, unknown> }>(
        `SELECT to_jsonb(x) AS row FROM labs.${table} x WHERE tenant_id=$1`,
        [tenants[0]],
      );
      const row = fixture.rows[0]?.row;
      if (!row) throw new Error(`Missing positive fixture for ${table}`);
      const insertRow = (value: Record<string, unknown>) =>
        `INSERT INTO labs.${table} SELECT (jsonb_populate_record(NULL::labs.${table}, '${JSON.stringify(value).replaceAll("'", "''")}'::jsonb)).*`;
      await db.query('SET LOCAL ROLE practicehub_app');
      await db.query("SELECT set_config('practicehub.tenant_id','',true)");
      expect((await db.query(`SELECT count(*)::int n FROM labs.${table}`)).rows).toEqual([
        { n: 0 },
      ]);
      await rejected(insertRow(row), undefined, '42501');
      await db.query(`SELECT set_config('practicehub.tenant_id','${tenants[0]}',true)`);
      expect((await db.query(`SELECT tenant_id FROM labs.${table}`)).rows).toEqual([
        { tenant_id: tenants[0] },
      ]);
      await rejected(insertRow({ ...row, synthetic: false }), `${table}_synthetic_check`);
      // The source row is visible and valid; changing only its tenant must fail RLS.
      await rejected(insertRow({ ...row, tenant_id: 'forbidden-tenant' }), undefined, '42501');
      await rejected(`DELETE FROM labs.${table}`, undefined, '42501');
      await rejected(`TRUNCATE labs.${table}`, undefined, '42501');
      if (table.startsWith('device_')) {
        await rejected(`UPDATE labs.${table} SET synthetic=true`, undefined, '42501');
      } else {
        expect(
          (
            await db.query(
              `UPDATE labs.${table} SET synthetic=true WHERE tenant_id='${tenants[1]}'`,
            )
          ).rowCount,
        ).toBe(0);
        expect((await db.query(`UPDATE labs.${table} SET synthetic=true`)).rowCount).toBe(1);
      }
      await rejected('CREATE TABLE labs.forbidden (id int)', undefined, '42501');
      await db.query('RESET ROLE');
    },
  );

  it('grants positive app inserts on all six tables and module role cannot cross schemas', async () => {
    await db.query(forward);
    await db.query('CREATE SCHEMA labs_proof_other; CREATE TABLE labs_proof_other.item(id int)');
    await db.query('SET LOCAL ROLE practicehub_app');
    await db.query(`SELECT set_config('practicehub.tenant_id','${tenants[0]}',true)`);
    await db.query(seed(tenants[0]));
    await db.query('SET LOCAL ROLE module_labs');
    await rejected('INSERT INTO labs_proof_other.item VALUES (1)', undefined, '42501');
    await db.query('RESET ROLE');
  });

  it('rolls back compatible prior data, revokes only migration role effects, and reapplies', async () => {
    for (const tenant of tenants) await db.query(seed(tenant));
    const before = await storedRows();
    const originalCatalog = await recoveryCatalog(db);
    await db.query(forward);
    const hardenedCatalog = await recoveryCatalog(db);
    expect(
      (
        await db.query(`SELECT conname FROM pg_constraint
        WHERE conrelid='labs.critical_closure'::regclass AND conname IN
        ('critical_closure_steps','critical_closure_superseded_by_check',
         'critical_closure_superseded_only_when_superseded','critical_closure_superseded_reason_check')
        ORDER BY conname`)
      ).rows,
    ).toEqual([
      { conname: 'critical_closure_steps' },
      { conname: 'critical_closure_superseded_by_check' },
      { conname: 'critical_closure_superseded_only_when_superseded' },
      { conname: 'critical_closure_superseded_reason_check' },
    ]);
    await db.query(rollback);
    expect(await recoveryCatalog(db)).toEqual(originalCatalog);
    expect(await storedRows()).toEqual(before);
    expect(
      (await db.query("SELECT rolname FROM pg_roles WHERE rolname='module_labs'")).rows,
    ).toEqual([]);
    for (const table of tables)
      expect((await db.query(`SELECT count(*)::int n FROM labs.${table}`)).rows).toEqual([
        { n: 2 },
      ]);
    const old = await snapshot(db);
    await db.query(rollback);
    expect(await snapshot(db)).toEqual(old);
    await db.query(forward);
    expect(await recoveryCatalog(db)).toEqual(hardenedCatalog);
    const reapplied = await snapshot(db);
    await db.query(forward);
    expect(await snapshot(db)).toEqual(reapplied);
    expect(await storedRows()).toEqual(before);
    expect(
      (
        await db.query(`SELECT count(*)::int n FROM labs.critical_closure
        WHERE superseded_at IS NULL AND superseded_by IS NULL AND superseded_reason IS NULL`)
      ).rows,
    ).toEqual([{ n: 2 }]);
  });

  it.each(['manual', 'electronic', 'device'])(
    'refuses downgrade of final %s adjudication atomically',
    async (source) => {
      await db.query(order(tenants[0]));
      await db.query(forward);
      await db.query(result(tenants[0], 'r', source, 'adjudicated-manual', source !== 'manual'));
      await unchangedFailure(rollback, {
        code: '23514',
        constraint:
          source === 'manual' ? 'lab_result_manual_read_back' : 'lab_result_provisional_shape',
      });
    },
  );

  it.each([
    [
      'ALTER TABLE labs.critical_closure ADD COLUMN superseded_by text',
      '0073 unknown/partial column schema: critical_closure',
    ],
    [
      'ALTER TABLE labs.critical_closure ADD COLUMN superseded_at text',
      '0073 unknown role origin/attributes/membership/external dependency',
    ],
    [
      'ALTER TABLE labs.lab_result DROP CONSTRAINT lab_result_provisional_shape',
      '0073 unknown constraint schema: lab_result',
    ],
    [
      'ALTER TABLE labs.lab_result DROP CONSTRAINT lab_result_provisional_shape; ALTER TABLE labs.lab_result ADD CONSTRAINT lab_result_provisional_shape CHECK (true)',
      '0073 unknown constraint schema: lab_result',
    ],
    [
      'ALTER TABLE labs.lab_order ALTER COLUMN loinc_code TYPE varchar(200)',
      '0073 unknown/partial column schema: lab_order',
    ],
    [
      'ALTER TABLE labs.device_recall DISABLE ROW LEVEL SECURITY',
      '0073 unexpected table/RLS/owner: device_recall',
    ],
    ['GRANT SELECT ON labs.lab_order TO PUBLIC', '0073 unexpected table ACL: lab_order'],
    ['GRANT USAGE ON SCHEMA labs TO PUBLIC', '0073 unexpected schema ACL'],
    [
      'ALTER DEFAULT PRIVILEGES IN SCHEMA labs GRANT SELECT ON TABLES TO PUBLIC',
      '0073 requires exact six-table labs schema/owner/default ACL',
    ],
    [
      'CREATE INDEX unexpected ON labs.lab_result(recorded_at)',
      '0073 unexpected index schema: lab_result',
    ],
    ['CREATE ROLE module_labs NOLOGIN', '0073 refuses preexisting module_labs role'],
    [
      'ALTER TABLE labs.device_calibration DROP CONSTRAINT device_calibration_result_id_check',
      '0073 unknown constraint schema: device_calibration',
    ],
    [
      "ALTER TABLE labs.lab_order DROP CONSTRAINT lab_order_status_check; ALTER TABLE labs.lab_order ADD CONSTRAINT lab_order_status_check CHECK (status IN ('awaiting-result','resulted')) NOT VALID",
      '0073 unknown constraint schema: lab_order',
    ],
    [
      'ALTER TABLE labs.lab_result DROP CONSTRAINT lab_result_tenant_id_order_id_fkey; ALTER TABLE labs.lab_result ADD CONSTRAINT lab_result_tenant_id_order_id_fkey FOREIGN KEY (tenant_id,order_id) REFERENCES labs.lab_order(tenant_id,order_id) ON DELETE CASCADE',
      '0073 unknown constraint schema: lab_result',
    ],
    [
      'ALTER TABLE labs.lab_result DROP CONSTRAINT lab_result_tenant_id_order_id_fkey; ALTER TABLE labs.lab_result ADD CONSTRAINT lab_result_tenant_id_order_id_fkey FOREIGN KEY (order_id,tenant_id) REFERENCES labs.lab_order(tenant_id,order_id)',
      '0073 unknown constraint schema: lab_result',
    ],
    [
      'ALTER POLICY tenant_isolation ON labs.lab_order USING (true)',
      '0073 unexpected tenant policy: lab_order',
    ],
    [
      'ALTER TABLE labs.lab_order OWNER TO practicehub_app',
      '0073 unexpected table/RLS/owner: lab_order',
    ],
    [
      'ALTER TABLE labs.lab_order ALTER COLUMN loinc_code TYPE text COLLATE "C"',
      '0073 unknown/partial column schema: lab_order',
    ],
  ])('refuses unknown catalog/role input: %s', async (change, message) => {
    await db.query(change);
    await unchangedFailure(forward, { code: 'P0001', message });
  });

  it.each([false, true])(
    'rejects schema-looking status literals with hardened=%s',
    async (hardened) => {
      if (hardened) await db.query(forward);
      await db.query(`ALTER TABLE labs.lab_order DROP CONSTRAINT lab_order_status_check;
      ALTER TABLE labs.lab_order ADD CONSTRAINT lab_order_status_check
      CHECK (status IN ('labs.awaiting-result','labs.resulted'))`);
      const diagnostic = { code: 'P0001', message: '0073 unknown constraint schema: lab_order' };
      await unchangedFailure(forward, diagnostic);
      await unchangedFailure(rollback, diagnostic);
    },
  );

  it('refuses a missing prerequisite without creating replacement tables', async () => {
    await db.query('DROP TABLE labs.device_calibration');
    const before = (
      await db.query(
        "SELECT relname FROM pg_class WHERE relnamespace='labs'::regnamespace ORDER BY relname",
      )
    ).rows;
    expect(await attempt(db, forward)).toMatchObject({
      code: 'P0001',
      message: '0073 requires exact six-table labs schema/owner/default ACL',
    });
    expect(
      (
        await db.query(
          "SELECT relname FROM pg_class WHERE relnamespace='labs'::regnamespace ORDER BY relname",
        )
      ).rows,
    ).toEqual(before);
    expect(
      (await db.query("SELECT to_regclass('labs.device_calibration') AS missing")).rows,
    ).toEqual([{ missing: null }]);
  });

  it.each([
    [
      "COMMENT ON ROLE module_labs IS 'unproven'",
      '0073 unknown role origin/attributes/membership/external dependency',
    ],
    [
      'ALTER ROLE module_labs BYPASSRLS',
      '0073 unknown role origin/attributes/membership/external dependency',
    ],
    ['GRANT DELETE ON labs.lab_result TO module_labs', '0073 unexpected table ACL: lab_result'],
    ['GRANT CREATE ON SCHEMA labs TO module_labs', '0073 unexpected schema ACL'],
    [
      'CREATE SCHEMA labs_proof_external; GRANT USAGE ON SCHEMA labs_proof_external TO module_labs',
      '0073 unknown role origin/attributes/membership/external dependency',
    ],
    [
      'CREATE ROLE labs_proof_guest; GRANT module_labs TO labs_proof_guest',
      '0073 unknown role origin/attributes/membership/external dependency',
    ],
    [
      'CREATE ROLE labs_proof_parent; GRANT labs_proof_parent TO module_labs',
      '0073 unknown role origin/attributes/membership/external dependency',
    ],
    [
      "ALTER ROLE module_labs SET statement_timeout='1s'",
      '0073 unknown role origin/attributes/membership/external dependency',
    ],
    [
      'GRANT module_labs TO practicehub_app WITH ADMIN OPTION',
      '0073 unknown role origin/attributes/membership/external dependency',
    ],
    [
      'GRANT SELECT ON labs.lab_order TO module_labs WITH GRANT OPTION',
      '0073 unexpected table ACL: lab_order',
    ],
  ])(
    'refuses reapply and inverse after origin/ACL/dependency drift: %s',
    async (change, message) => {
      await db.query(forward);
      await db.query(change);
      await unchangedFailure(forward, { code: 'P0001', message });
      await unchangedFailure(rollback, { code: 'P0001', message });
    },
  );

  it('caller transaction rolls back forced errors after forward and inverse DDL', async () => {
    await db.query(seed(tenants[0]));
    await unchangedFailure(`${forward}\nSELECT 1/0;`, {
      code: '22012',
      message: 'division by zero',
    });
    await db.query(forward);
    await unchangedFailure(`${rollback}\nSELECT 1/0;`, {
      code: '22012',
      message: 'division by zero',
    });
  });
});
