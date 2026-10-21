import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { generateRlsCoverageGuard } from '@practicehub/platform-core';
import type { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  atomicSql,
  eventCatalog,
  type EventDescriptor,
  fixtureProvenance,
  historical,
  inverseFromArtifact,
  observedEpoch,
  proofBindingFromGrant,
  readEventArtifact,
  recordRolePhase,
  restoreFromArtifact,
  repeatInverseFromArtifact,
  roleProvenance,
  validateEventRoleTransition,
  beginFixture,
  connectDisposable,
  forward,
  moduleSql,
  ownerSql,
  principalSql,
  preserveEvents,
  readMigration,
  rollback,
  seedHistorical,
  snapshot,
  tenants,
} from './db-test-harness.js';
import { inventoryHistoricalRlsSpecs, inventoryRlsSpecs } from './rls-specs.js';

let db: Client;
let connected = false;
const oldTables = inventoryHistoricalRlsSpecs.map(({ table }) => table);
const eventTable = 'lot_recall_event';
const insert = `INSERT INTO inventory.lot_recall_event
  (tenant_id,recall_ref,kind,lot_ref,actor,reason,event_on,synthetic)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
const event = (tenant: string, ref = 'recall:synthetic01'): unknown[] => [
  tenant,
  ref,
  'recalled',
  'lot:synthetic01',
  'human:synthetic01',
  'Synthetic recall proof',
  '2029-01-02',
  true,
];

beforeEach(async () => {
  // A fresh connection is essential: RESET of a custom GUC can leave an empty
  // placeholder after first SET, which is not the true NULL/missing control.
  db = await connectDisposable();
  connected = true;
  await beginFixture(db);
});
afterEach(async () => {
  if (connected) {
    try {
      await db.query('ROLLBACK');
    } finally {
      await db.end();
      connected = false;
    }
  }
});

async function upgrade() {
  await seedHistorical(db);
  await recordRolePhase(db, 'before-forward');
  await atomicSql(db, readMigration(forward));
  await recordRolePhase(db, 'after-forward');
}
async function seedEvents() {
  for (const tenant of tenants) await moduleSql(db, tenant, insert, event(tenant));
}
async function rejected(sql: string, pattern: RegExp) {
  const refusal = atomicSql(db, sql);
  await expect(refusal).rejects.toMatchObject({ code: 'P0001' });
  await expect(refusal).rejects.toThrow(pattern);
}

describe('0074 real disposable PostgreSQL storage proof', () => {
  it('fresh original schema upgrades; prior populated two-tenant schema preserves all six tables and memberships', async () => {
    const empty = await snapshot(db, oldTables);
    await atomicSql(db, readMigration(forward));
    expect(await snapshot(db, oldTables)).toEqual(empty);
    await seedHistorical(db);
    const populated = await snapshot(db, oldTables);
    await atomicSql(db, readMigration(forward));
    expect(await snapshot(db, oldTables)).toEqual(populated);
    await seedEvents();
    for (const tenant of tenants) {
      const rows = await moduleSql(db, tenant, 'SELECT tenant_id FROM inventory.lot_recall_event');
      expect(rows).toEqual([{ tenant_id: tenant }]);
    }
  });

  it('upgrades a genuinely prior-original populated schema before any forward application', async () => {
    await seedHistorical(db);
    const before = await snapshot(db, oldTables);
    expect(
      (await db.query("SELECT to_regclass('inventory.lot_recall_event') value")).rows[0]?.value,
    ).toBeNull();
    await atomicSql(db, readMigration(forward));
    expect(await snapshot(db, oldTables)).toEqual(before);
    for (const table of oldTables)
      expect(
        (await db.query(`SELECT count(*)::int count FROM inventory.${table}`)).rows[0]?.count,
      ).toBe(2);
    await seedEvents();
  });

  it('has exact columns, key/foreign-key/check catalog, forced RLS and SELECT/INSERT-only module ACL', async () => {
    await upgrade();
    const columns =
      await db.query(`SELECT attname,format_type(atttypid,atttypmod) type,attnotnull,atthasdef
      FROM pg_attribute WHERE attrelid='inventory.lot_recall_event'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`);
    expect(columns.rows).toEqual(
      [
        'tenant_id',
        'recall_ref',
        'kind',
        'lot_ref',
        'actor',
        'reason',
        'event_on',
        'synthetic',
      ].map((attname, index) => ({
        attname,
        type: index === 6 ? 'date' : index === 7 ? 'boolean' : 'text',
        attnotnull: true,
        atthasdef: false,
      })),
    );
    const constraints =
      await db.query(`SELECT contype,conkey,confkey,CASE WHEN confrelid=0 THEN NULL ELSE confrelid::regclass::text END target,
      convalidated,condeferrable,condeferred FROM pg_constraint WHERE conrelid='inventory.lot_recall_event'::regclass ORDER BY contype,conname`);
    expect(constraints.rows).toHaveLength(10);
    expect(constraints.rows.filter((row) => row.contype === 'p')).toEqual([
      {
        contype: 'p',
        conkey: [1, 2, 3],
        confkey: null,
        target: null,
        convalidated: true,
        condeferrable: false,
        condeferred: false,
      },
    ]);
    expect(constraints.rows.filter((row) => row.contype === 'f')).toEqual(
      expect.arrayContaining([
        {
          contype: 'f',
          conkey: [1],
          confkey: [1],
          target: 'platform_core.tenant',
          convalidated: true,
          condeferrable: false,
          condeferred: false,
        },
        {
          contype: 'f',
          conkey: [1, 4],
          confkey: [1, 2],
          target: 'inventory.lot',
          convalidated: true,
          condeferrable: false,
          condeferred: false,
        },
      ]),
    );
    expect(constraints.rows.filter((row) => row.contype === 'c')).toHaveLength(7);
    const security =
      await db.query(`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='inventory' AND relkind='r' ORDER BY relname`);
    expect(security.rows).toEqual(
      inventoryRlsSpecs
        .map(({ table }) => table)
        .sort()
        .map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })),
    );
    const acl = await db.query(`SELECT a.privilege_type,a.is_grantable FROM pg_class c,
      LATERAL aclexplode(c.relacl) a WHERE c.oid='inventory.lot_recall_event'::regclass
      AND a.grantee=(SELECT oid FROM pg_roles WHERE rolname='module_inventory') ORDER BY privilege_type`);
    expect(acl.rows).toEqual([
      { privilege_type: 'INSERT', is_grantable: false },
      { privilege_type: 'SELECT', is_grantable: false },
    ]);
    const role = await moduleSql(
      db,
      tenants[0],
      'SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user',
    );
    expect(role).toEqual([
      { current_user: 'module_inventory', rolsuper: false, rolbypassrls: false },
    ]);
    await atomicSql(db, readMigration(forward)); // normalized catalog/policy validation must also accept the real catalog
  });

  it('positive tenant writes/reads precede cross-tenant, unbound, empty and immutable-row negatives', async () => {
    // Seed as owner before any tenant SET so true absent-GUC controls execute
    // against populated storage, not a duplicate of the empty-GUC case.
    await seedHistorical(db, true);
    await atomicSql(db, readMigration(forward));
    for (const tenant of tenants) await ownerSql(db, insert, event(tenant));
    expect(
      (await db.query("SELECT current_setting('practicehub.tenant_id', true) value")).rows,
    ).toEqual([{ value: null }]);
    for (const principal of ['module_inventory', 'practicehub_app'] as const) {
      expect(
        await principalSql(
          db,
          principal,
          undefined,
          "SELECT current_user,current_setting('practicehub.tenant_id',true) binding",
        ),
      ).toEqual([{ current_user: principal, binding: null }]);
      expect(
        await principalSql(
          db,
          principal,
          undefined,
          'SELECT tenant_id FROM inventory.lot_recall_event',
        ),
      ).toEqual([]);
      await expect(
        principalSql(db, principal, undefined, insert, event(tenants[0], 'recall:absent001')),
      ).rejects.toMatchObject({ code: '42501' });
    }
    // SET LOCAL ROLE proves effective principal permissions and inherited
    // membership on the admin fixture connection; it does not prove app login.
    for (const principal of ['module_inventory', 'practicehub_app'] as const) {
      expect(
        await principalSql(
          db,
          principal,
          tenants[0],
          `SELECT current_user,session_user <> current_user AS switched,
          rolsuper,rolbypassrls,pg_has_role(current_user,'module_inventory','USAGE') inherited
          FROM pg_roles WHERE rolname=current_user`,
        ),
      ).toEqual([
        {
          current_user: principal,
          switched: true,
          rolsuper: false,
          rolbypassrls: false,
          inherited: true,
        },
      ]);
      const ownRef = principal === 'practicehub_app' ? 'recall:apppositive' : 'recall:modpositive';
      await principalSql(db, principal, tenants[0], insert, event(tenants[0], ownRef));
      expect(
        await principalSql(
          db,
          principal,
          tenants[0],
          'SELECT recall_ref FROM inventory.lot_recall_event WHERE recall_ref=$1',
          [ownRef],
        ),
      ).toEqual([{ recall_ref: ownRef }]);
      expect(
        await principalSql(
          db,
          principal,
          tenants[0],
          'SELECT tenant_id FROM inventory.lot_recall_event WHERE tenant_id=$1',
          [tenants[1]],
        ),
      ).toEqual([]);
      await expect(
        principalSql(db, principal, tenants[0], insert, event(tenants[1], 'recall:appcross01')),
      ).rejects.toMatchObject({ code: '42501' });
      const nullTenant = event(tenants[0], 'recall:nullrls01');
      nullTenant[0] = null;
      await expect(
        principalSql(db, principal, tenants[0], insert, nullTenant),
      ).rejects.toMatchObject({ code: '42501' });
      expect(
        await principalSql(
          db,
          principal,
          '',
          "SELECT current_setting('practicehub.tenant_id', true) binding",
        ),
      ).toEqual([{ binding: '' }]);
      expect(
        await principalSql(db, principal, '', 'SELECT tenant_id FROM inventory.lot_recall_event'),
      ).toEqual([]);
      await expect(
        principalSql(db, principal, '', insert, event(tenants[0], 'recall:empty001')),
      ).rejects.toMatchObject({ code: '42501' });
      for (const statement of [
        "UPDATE inventory.lot_recall_event SET reason='changed'",
        'DELETE FROM inventory.lot_recall_event',
        'TRUNCATE inventory.lot_recall_event',
      ])
        await expect(principalSql(db, principal, tenants[0], statement)).rejects.toMatchObject({
          code: '42501',
        });
    }
    // Extra positive controls above were savepoint-only statements in this
    // fixture; retain their rows and test the original module boundaries too.
    expect(
      await moduleSql(db, tenants[0], 'SELECT tenant_id FROM inventory.lot_recall_event'),
    ).toHaveLength(3);
    expect(
      await moduleSql(
        db,
        tenants[0],
        'SELECT tenant_id FROM inventory.lot_recall_event WHERE tenant_id=$1',
        [tenants[1]],
      ),
    ).toEqual([]);
    await expect(
      moduleSql(db, tenants[0], insert, event(tenants[1], 'recall:crosspair01')),
    ).rejects.toMatchObject({ code: '42501' });
    for (const binding of ['']) {
      expect(
        await moduleSql(db, binding, 'SELECT tenant_id FROM inventory.lot_recall_event'),
      ).toEqual([]);
      await expect(
        moduleSql(db, binding, insert, event(tenants[0], 'recall:unbound001')),
      ).rejects.toMatchObject({ code: '42501' });
    }
    for (const sql of [
      "UPDATE inventory.lot_recall_event SET reason='changed'",
      'DELETE FROM inventory.lot_recall_event',
      'TRUNCATE inventory.lot_recall_event',
    ]) {
      await expect(moduleSql(db, tenants[0], sql)).rejects.toMatchObject({ code: '42501' });
    }
    await moduleSql(
      db,
      tenants[1],
      "INSERT INTO inventory.lot VALUES ($1,'lot:riveronly01','product:synthetic01','2030-01-01',true)",
      [tenants[1]],
    );
    const forged = event(tenants[0], 'recall:forgedlot01');
    forged[3] = 'lot:riveronly01';
    await expect(moduleSql(db, tenants[0], insert, forged)).rejects.toMatchObject({
      code: '23503',
    });
    expect(
      (await db.query('SELECT count(*)::int count FROM inventory.lot_recall_event')).rows[0]?.count,
    ).toBe(4);
  });

  it('enforces every non-null column, token/kind/reason/synthetic constraints, tenant/lot FKs, PK and human release', async () => {
    await upgrade();
    await seedEvents();
    const before = await snapshot(db, [eventTable]);
    const nonNullColumns = [
      'tenant_id',
      'recall_ref',
      'kind',
      'lot_ref',
      'actor',
      'reason',
      'event_on',
      'synthetic',
    ];
    // Owner isolates NOT NULL from canonical tenant RLS; non-owner NULL tenant
    // refusal remains a separate strict 42501 control in the principal case.
    for (let index = 0; index < nonNullColumns.length; index++) {
      const values = event(tenants[0], 'recall:nullprobe1');
      values[index] = null;
      await expect(ownerSql(db, insert, values)).rejects.toMatchObject({
        code: '23502',
        column: nonNullColumns[index],
        table: eventTable,
        schema: 'inventory',
      });
    }
    for (const [index, value, code] of [
      [1, 'bad-ref', '23514'],
      [2, 'unknown', '23514'],
      [3, 'bad-lot', '23514'],
      [4, 'bad-actor', '23514'],
      [5, '   ', '23514'],
      [7, false, '23514'],
      [6, 'not-a-date', '22007'],
      [3, 'lot:missing001', '23503'],
    ] as const) {
      const values = event(tenants[0], 'recall:badprobe01');
      values[index] = value;
      await expect(moduleSql(db, tenants[0], insert, values)).rejects.toMatchObject({ code });
    }
    await expect(
      moduleSql(db, 'missing-synthetic', insert, event('missing-synthetic')),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(moduleSql(db, tenants[0], insert, event(tenants[0]))).rejects.toMatchObject({
      code: '23505',
    });
    const release = event(tenants[0]);
    release[2] = 'released';
    release[4] = 'agent:synthetic01';
    await expect(moduleSql(db, tenants[0], insert, release)).rejects.toMatchObject({
      code: '23514',
    });
    expect(await snapshot(db, [eventTable])).toEqual(before);
    release[4] = 'human:synthetic01';
    await moduleSql(db, tenants[0], insert, release);
    expect(
      await moduleSql(db, tenants[0], 'SELECT kind FROM inventory.lot_recall_event ORDER BY kind'),
    ).toEqual([{ kind: 'recalled' }, { kind: 'released' }]);
  });

  it('executes missing/rogue/unprotected guard failures without silently repairing the historical epoch', async () => {
    await seedHistorical(db);
    for (const mutation of [
      'ALTER TABLE inventory.dispense RENAME TO missing_dispense',
      'CREATE TABLE inventory.rogue_decoy (tenant_id text)',
      'ALTER TABLE inventory.unit DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE inventory.unit NO FORCE ROW LEVEL SECURITY',
    ]) {
      await db.query('SAVEPOINT guard_probe');
      await db.query(mutation);
      await rejected(readMigration(forward), /prerequisite missing|rls coverage failure/);
      expect(
        (await db.query("SELECT to_regclass('inventory.lot_recall_event') value")).rows[0]?.value,
      ).toBeNull();
      await db.query('ROLLBACK TO SAVEPOINT guard_probe');
      await db.query('RELEASE SAVEPOINT guard_probe');
    }
    await atomicSql(db, readMigration(forward));
    await db.query('SAVEPOINT forward_guard');
    await db.query('ALTER TABLE inventory.lot_recall_event NO FORCE ROW LEVEL SECURITY');
    await rejected(
      generateRlsCoverageGuard('inventory', inventoryRlsSpecs),
      /rls coverage failure.*lot_recall_event/,
    );
    await db.query('ROLLBACK TO SAVEPOINT forward_guard');
    await db.query('RELEASE SAVEPOINT forward_guard');
  });

  it('refuses preexisting drift; repeat is stable and failed atomic application recovers with no partial event table', async () => {
    await seedHistorical(db);
    const old = await snapshot(db, oldTables);
    await rejected(
      readMigration(forward) +
        "\nDO $fail$ BEGIN RAISE EXCEPTION 'injected atomic failure'; END $fail$;",
      /injected atomic failure/,
    );
    expect(
      (await db.query("SELECT to_regclass('inventory.lot_recall_event') value")).rows[0]?.value,
    ).toBeNull();
    expect(await snapshot(db, oldTables)).toEqual(old);
    await atomicSql(db, readMigration(forward));
    await seedEvents();
    const before = await snapshot(db, [...oldTables, eventTable]);
    await atomicSql(db, readMigration(forward));
    expect(await snapshot(db, [...oldTables, eventTable])).toEqual(before);
    for (const mutation of [
      'ALTER TABLE inventory.lot_recall_event ADD COLUMN rogue text',
      'ALTER TABLE inventory.lot_recall_event DROP CONSTRAINT lot_recall_event_reason_check',
      'CREATE INDEX rogue_index ON inventory.lot_recall_event(reason)',
      'GRANT UPDATE ON inventory.lot_recall_event TO module_inventory',
      'CREATE POLICY rogue_policy ON inventory.lot_recall_event USING (true)',
    ]) {
      await db.query('SAVEPOINT drift_probe');
      await db.query(mutation);
      await rejected(readMigration(forward), /unexpected existing event/);
      await db.query('ROLLBACK TO SAVEPOINT drift_probe');
      await db.query('RELEASE SAVEPOINT drift_probe');
    }
    expect(await snapshot(db, [...oldTables, eventTable])).toEqual(before);
  });

  it('persists synthetic history before safe rollback; preserves six tables/ACL/membership, repeats, reapplies and restores exact events', async () => {
    await upgrade();
    await seedEvents();
    const before = await snapshot(db, oldTables);
    for (const table of oldTables) {
      expect(
        (
          await db.query(
            `SELECT tenant_id,count(*)::int count FROM inventory.${table} GROUP BY tenant_id ORDER BY tenant_id`,
          )
        ).rows,
      ).toEqual(tenants.map((tenant_id) => ({ tenant_id, count: 1 })));
    }
    // The inverse fixture has recalled/released human events for both tenants.
    for (const tenant of tenants) {
      const released = event(tenant);
      released[2] = 'released';
      await moduleSql(db, tenant, insert, released);
    }
    const eventBefore = await snapshot(db, [eventTable]);
    const mixedBefore = eventBefore;
    const binding = proofBindingFromGrant();
    const descriptor = await preserveEvents(db, binding);
    expect(readEventArtifact(descriptor, binding)).toHaveLength(4);
    const catalog = await eventCatalog(db);
    expect(catalog).toBeDefined();
    if (!catalog) throw new Error('Missing accepted event catalog');
    const roles = await roleProvenance(db);
    const expected = { binding, catalog, roles };
    await recordRolePhase(db, 'before-inverse');
    await db.query('SAVEPOINT rollback_guard');
    await db.query('CREATE TABLE inventory.rogue_decoy (tenant_id text)');
    await rejected(readMigration(rollback), /rls coverage failure.*rogue_decoy/);
    expect(await snapshot(db, [eventTable])).toEqual(eventBefore);
    await db.query('ROLLBACK TO SAVEPOINT rollback_guard');
    await db.query('RELEASE SAVEPOINT rollback_guard');
    await inverseFromArtifact(db, descriptor, expected);
    await recordRolePhase(db, 'after-inverse');
    expect(
      (await db.query("SELECT to_regclass('inventory.lot_recall_event') value")).rows[0]?.value,
    ).toBeNull();
    expect(await snapshot(db, oldTables)).toEqual(before);
    await atomicSql(db, generateRlsCoverageGuard('inventory', inventoryHistoricalRlsSpecs));
    const sixRoles = await roleProvenance(db);
    validateEventRoleTransition(roles, sixRoles, 'inverse');
    await repeatInverseFromArtifact(db, descriptor, binding, sixRoles);
    expect(await roleProvenance(db)).toEqual(sixRoles);
    await recordRolePhase(db, 'before-reapply');
    await atomicSql(db, readMigration(forward));
    await recordRolePhase(db, 'after-reapply');
    expect(
      (await db.query('SELECT count(*)::int count FROM inventory.lot_recall_event')).rows,
    ).toEqual([{ count: 0 }]);
    expect(await eventCatalog(db)).toEqual(catalog);
    const reappliedRoles = await roleProvenance(db);
    // Only enumerated event identities/dependencies may receive new OIDs.
    validateEventRoleTransition(roles, reappliedRoles, 'reapply');
    const restoreExpectation = { ...expected, roles: reappliedRoles };
    const emptyRestoreState = await snapshot(db, [...oldTables, eventTable]);
    await recordRolePhase(db, 'before-restore');
    await expect(restoreFromArtifact(db, descriptor, restoreExpectation, true)).rejects.toThrow(
      'Injected inventory restore failure',
    );
    expect(
      (await db.query('SELECT count(*)::int count FROM inventory.lot_recall_event')).rows,
    ).toEqual([{ count: 0 }]);
    expect(await snapshot(db, oldTables)).toEqual(before);
    expect(await roleProvenance(db)).toEqual(reappliedRoles);
    expect(await eventCatalog(db)).toEqual(catalog);
    expect(await snapshot(db, [...oldTables, eventTable])).toEqual(emptyRestoreState);
    await restoreFromArtifact(db, descriptor, restoreExpectation);
    await recordRolePhase(db, 'after-restore');
    expect(await roleProvenance(db)).toEqual(reappliedRoles);
    expect(await eventCatalog(db)).toEqual(catalog);
    expect(await snapshot(db, [eventTable])).toEqual(mixedBefore);
    expect(await snapshot(db, [eventTable])).toEqual(eventBefore);
    expect(await snapshot(db, oldTables)).toEqual(before);
  });
});

interface CatalogProbe {
  name: string;
  mutation: string;
  witness: string;
  value: unknown;
  diagnostic: RegExp;
}
const schemaRefusal = /inventory-0074 unexpected existing event schema/;
const aclRefusal = /inventory-0074 unexpected existing event policy or ACL/;
const probes: readonly CatalogProbe[] = [
  {
    name: 'unlogged persistence',
    mutation: 'ALTER TABLE inventory.lot_recall_event SET UNLOGGED',
    witness:
      "SELECT relpersistence value FROM pg_class WHERE oid='inventory.lot_recall_event'::regclass",
    value: 'u',
    diagnostic: /inventory-0074 unexpected existing event relation/,
  },
  {
    name: 'reason nullable',
    mutation: 'ALTER TABLE inventory.lot_recall_event ALTER reason DROP NOT NULL',
    witness:
      "SELECT attnotnull value FROM pg_attribute WHERE attrelid='inventory.lot_recall_event'::regclass AND attname='reason'",
    value: false,
    diagnostic: schemaRefusal,
  },
  {
    name: 'actor varchar type',
    mutation: 'ALTER TABLE inventory.lot_recall_event ALTER actor TYPE varchar(100)',
    witness:
      "SELECT format_type(atttypid,atttypmod) value FROM pg_attribute WHERE attrelid='inventory.lot_recall_event'::regclass AND attname='actor'",
    value: 'character varying(100)',
    diagnostic: schemaRefusal,
  },
  {
    name: 'reason forbidden default',
    mutation: "ALTER TABLE inventory.lot_recall_event ALTER reason SET DEFAULT 'synthetic default'",
    witness:
      "SELECT pg_get_expr(adbin,adrelid) value FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE a.attrelid='inventory.lot_recall_event'::regclass AND a.attname='reason'",
    value: "'synthetic default'::text",
    diagnostic: schemaRefusal,
  },
  {
    name: 'reason different C collation',
    mutation: 'ALTER TABLE inventory.lot_recall_event ALTER reason TYPE text COLLATE "C"',
    witness:
      "SELECT (attcollation='\"C\"'::regcollation AND attcollation<>'default'::regcollation) value FROM pg_attribute WHERE attrelid='inventory.lot_recall_event'::regclass AND attname='reason'",
    value: true,
    diagnostic: schemaRefusal,
  },
  {
    name: 'user trigger dependency',
    mutation: `CREATE FUNCTION platform_core.inventory_probe_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER inventory_probe BEFORE INSERT ON inventory.lot_recall_event FOR EACH ROW EXECUTE FUNCTION platform_core.inventory_probe_trigger()`,
    witness:
      "SELECT count(*)::int value FROM pg_trigger WHERE tgrelid='inventory.lot_recall_event'::regclass AND NOT tgisinternal",
    value: 1,
    diagnostic: schemaRefusal,
  },
  {
    name: 'rewrite rule dependency',
    mutation:
      'CREATE RULE inventory_probe AS ON DELETE TO inventory.lot_recall_event DO INSTEAD NOTHING',
    witness:
      "SELECT count(*)::int value FROM pg_rewrite WHERE ev_class='inventory.lot_recall_event'::regclass",
    value: 1,
    diagnostic: schemaRefusal,
  },
  {
    name: 'inheritance dependency outside inventory',
    mutation:
      'CREATE TABLE platform_core.inventory_probe_child () INHERITS (inventory.lot_recall_event)',
    witness:
      "SELECT count(*)::int value FROM pg_inherits WHERE inhparent='inventory.lot_recall_event'::regclass AND inhrelid='platform_core.inventory_probe_child'::regclass",
    value: 1,
    diagnostic: schemaRefusal,
  },
  {
    name: 'PUBLIC select ACL',
    mutation: 'GRANT SELECT ON inventory.lot_recall_event TO PUBLIC',
    witness:
      "SELECT count(*)::int value FROM pg_class c,LATERAL aclexplode(c.relacl) a WHERE c.oid='inventory.lot_recall_event'::regclass AND a.grantee=0 AND a.privilege_type='SELECT'",
    value: 1,
    diagnostic: aclRefusal,
  },
  {
    name: 'foreign app direct ACL',
    mutation: 'GRANT SELECT ON inventory.lot_recall_event TO practicehub_app',
    witness:
      "SELECT count(*)::int value FROM pg_class c,LATERAL aclexplode(c.relacl) a WHERE c.oid='inventory.lot_recall_event'::regclass AND a.grantee='practicehub_app'::regrole AND a.privilege_type='SELECT'",
    value: 1,
    diagnostic: aclRefusal,
  },
  {
    name: 'module grant option',
    mutation: 'GRANT SELECT ON inventory.lot_recall_event TO module_inventory WITH GRANT OPTION',
    witness:
      "SELECT a.is_grantable value FROM pg_class c,LATERAL aclexplode(c.relacl) a WHERE c.oid='inventory.lot_recall_event'::regclass AND a.grantee='module_inventory'::regrole AND a.privilege_type='SELECT'",
    value: true,
    diagnostic: aclRefusal,
  },
  {
    name: 'column ACL',
    mutation: 'GRANT SELECT(reason) ON inventory.lot_recall_event TO module_inventory',
    witness:
      "SELECT attacl IS NOT NULL value FROM pg_attribute WHERE attrelid='inventory.lot_recall_event'::regclass AND attname='reason'",
    value: true,
    diagnostic: aclRefusal,
  },
  {
    name: 'inherited forbidden donor write',
    mutation:
      'GRANT UPDATE ON inventory.lot_recall_event TO inventory_proof_donor; GRANT inventory_proof_donor TO module_inventory',
    witness:
      "SELECT has_table_privilege('module_inventory','inventory.lot_recall_event','UPDATE') value",
    value: true,
    diagnostic: aclRefusal,
  },
  {
    name: 'module SUPERUSER',
    mutation: 'ALTER ROLE module_inventory SUPERUSER',
    witness: "SELECT rolsuper value FROM pg_roles WHERE rolname='module_inventory'",
    value: true,
    diagnostic: /inventory-0074 requires tenant table and non-bypass module_inventory role/,
  },
  {
    name: 'module BYPASSRLS',
    mutation: 'ALTER ROLE module_inventory BYPASSRLS',
    witness: "SELECT rolbypassrls value FROM pg_roles WHERE rolname='module_inventory'",
    value: true,
    diagnostic: /inventory-0074 requires tenant table and non-bypass module_inventory role/,
  },
  {
    name: 'partitioned relation in inventory',
    mutation:
      'CREATE TABLE inventory.proof_partition (tenant_id text) PARTITION BY LIST(tenant_id)',
    witness: "SELECT relkind value FROM pg_class WHERE oid='inventory.proof_partition'::regclass",
    value: 'p',
    diagnostic: /inventory-0074 unexpected partitioned or foreign table/,
  },
  {
    name: 'metadata-only foreign relation in inventory',
    mutation: `CREATE FOREIGN DATA WRAPPER inventory_proof_fdw NO HANDLER NO VALIDATOR;
      CREATE SERVER inventory_proof_server FOREIGN DATA WRAPPER inventory_proof_fdw;
      CREATE FOREIGN TABLE inventory.proof_foreign (tenant_id text) SERVER inventory_proof_server`,
    witness: "SELECT relkind value FROM pg_class WHERE oid='inventory.proof_foreign'::regclass",
    value: 'f',
    diagnostic: /inventory-0074 unexpected partitioned or foreign table/,
  },
];
const foreignKeyProbes: readonly CatalogProbe[] = [
  {
    name: 'FK wrong referenced relation',
    mutation: `CREATE TABLE platform_core.inventory_probe_tenant (tenant_id text PRIMARY KEY);
      ALTER TABLE inventory.lot_recall_event DROP CONSTRAINT lot_recall_event_tenant_id_fkey;
      ALTER TABLE inventory.lot_recall_event ADD CONSTRAINT probe_fk FOREIGN KEY(tenant_id) REFERENCES platform_core.inventory_probe_tenant(tenant_id)`,
    witness:
      "SELECT confrelid::regclass::text value FROM pg_constraint WHERE conrelid='inventory.lot_recall_event'::regclass AND conname='probe_fk'",
    value: 'platform_core.inventory_probe_tenant',
    diagnostic: schemaRefusal,
  },
  {
    name: 'FK wrong ordered columns',
    mutation: `CREATE UNIQUE INDEX inventory_probe_order ON inventory.lot(lot_ref,tenant_id);
      ALTER TABLE inventory.lot_recall_event DROP CONSTRAINT lot_recall_event_tenant_id_lot_ref_fkey;
      ALTER TABLE inventory.lot_recall_event ADD CONSTRAINT probe_fk FOREIGN KEY(lot_ref,tenant_id) REFERENCES inventory.lot(lot_ref,tenant_id)`,
    witness:
      "SELECT conkey::text value FROM pg_constraint WHERE conrelid='inventory.lot_recall_event'::regclass AND conname='probe_fk'",
    value: '{4,1}',
    diagnostic: schemaRefusal,
  },
  ...(
    [
      ['ON UPDATE CASCADE', 'confupdtype', 'c'],
      ['ON DELETE CASCADE', 'confdeltype', 'c'],
      ['MATCH FULL', 'confmatchtype', 'f'],
      ['DEFERRABLE INITIALLY IMMEDIATE', 'condeferrable', true],
      ['DEFERRABLE INITIALLY DEFERRED', 'condeferred', true],
      ['NOT VALID', 'convalidated', false],
    ] as const
  ).map(([clause, field, value]) => ({
    name: `FK ${clause}`,
    mutation: `ALTER TABLE inventory.lot_recall_event DROP CONSTRAINT lot_recall_event_tenant_id_fkey;
      ALTER TABLE inventory.lot_recall_event ADD CONSTRAINT probe_fk FOREIGN KEY(tenant_id) REFERENCES platform_core.tenant(tenant_id) ${clause}`,
    witness: `SELECT ${field} value FROM pg_constraint WHERE conrelid='inventory.lot_recall_event'::regclass AND conname='probe_fk'`,
    value,
    diagnostic: schemaRefusal,
  })),
];

describe('0074 named catalog branch witnesses (separate physical grant required)', () => {
  for (const probe of [...probes, ...foreignKeyProbes]) {
    it(`rejects ${probe.name} and accepts restored catalog`, async () => {
      await upgrade();
      // Accepted positive immediately precedes each one-field mutant.
      await atomicSql(db, readMigration(forward));
      const accepted = await snapshot(db, [...oldTables, eventTable]);
      const acceptedCatalog = await eventCatalog(db);
      const acceptedRoles = await roleProvenance(db);
      const priorWitness = (
        await db.query(
          probe.witness
            .replace(/'([^']+)'::regclass/g, "to_regclass('$1')")
            .replace(/ AND conname='probe_fk'/, " AND conname='lot_recall_event_tenant_id_fkey'"),
        )
      ).rows as unknown[];
      await db.query('SAVEPOINT named_catalog_probe');
      try {
        await db.query(probe.mutation);
        const witness = (await db.query(probe.witness)).rows as unknown[];
        expect(witness).toEqual([{ value: probe.value }]);
        expect(witness).not.toEqual(priorWitness);
        const mutant = await snapshot(db, [...oldTables, eventTable]);
        const mutantCatalog = await eventCatalog(db);
        const mutantRoles = await roleProvenance(db);
        await rejected(readMigration(forward), probe.diagnostic);
        expect(await snapshot(db, [...oldTables, eventTable])).toEqual(mutant);
        expect(await eventCatalog(db)).toEqual(mutantCatalog);
        expect(await roleProvenance(db)).toEqual(mutantRoles);
      } finally {
        await db.query('ROLLBACK TO SAVEPOINT named_catalog_probe');
        await db.query('RELEASE SAVEPOINT named_catalog_probe');
      }
      expect(await snapshot(db, [...oldTables, eventTable])).toEqual(accepted);
      expect(await eventCatalog(db)).toEqual(acceptedCatalog);
      expect(await roleProvenance(db)).toEqual(acceptedRoles);
      await atomicSql(db, readMigration(forward));
    });
  }

  it('isolates effective inheritance with owner donor and membership-only mutation', async () => {
    // FUTURE exact root authority must cover preprovisioned safe donor ownership
    // and the membership grant/revoke. No role creation or SQL-copy edit here.
    await upgrade();
    await db.query('SAVEPOINT inherited_owner_fixture');
    try {
      const donor = (
        await db.query(`SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication
        FROM pg_roles WHERE rolname='inventory_proof_donor'`)
      ).rows;
      expect(donor).toEqual([
        {
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolreplication: false,
        },
      ]);
      expect(
        (
          await db.query(
            "SELECT pg_has_role('module_inventory','inventory_proof_donor','MEMBER') value",
          )
        ).rows,
      ).toEqual([{ value: false }]);
      await db.query('ALTER TABLE inventory.lot_recall_event OWNER TO inventory_proof_donor');
      const effective =
        "SELECT has_table_privilege('module_inventory','inventory.lot_recall_event','UPDATE') value";
      const direct = `SELECT count(*)::int value FROM pg_class c,
        LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
        WHERE c.oid='inventory.lot_recall_event'::regclass AND a.grantee<>c.relowner
        AND (a.grantee<>'module_inventory'::regrole
          OR a.privilege_type NOT IN ('SELECT','INSERT') OR a.is_grantable)`;
      expect((await db.query(effective)).rows).toEqual([{ value: false }]);
      expect((await db.query(direct)).rows).toEqual([{ value: 0 }]);
      await atomicSql(db, readMigration(forward));
      const accepted = await snapshot(db, [...oldTables, eventTable]);
      const catalog = await eventCatalog(db);
      const roles = await roleProvenance(db);
      await db.query('GRANT inventory_proof_donor TO module_inventory');
      expect(
        (
          await db.query(
            "SELECT pg_has_role('module_inventory','inventory_proof_donor','USAGE') value",
          )
        ).rows,
      ).toEqual([{ value: true }]);
      expect((await db.query(effective)).rows).toEqual([{ value: true }]);
      // Direct ACL guards remain satisfied; the accepted relation ACL is unchanged.
      expect((await db.query(direct)).rows).toEqual([{ value: 0 }]);
      expect(await eventCatalog(db)).toEqual(catalog);
      const mutant = await snapshot(db, [...oldTables, eventTable]);
      const mutantRoles = await roleProvenance(db);
      await rejected(
        readMigration(forward),
        /^inventory-0074 unexpected existing event policy or ACL$/,
      );
      expect(await snapshot(db, [...oldTables, eventTable])).toEqual(mutant);
      expect(await roleProvenance(db)).toEqual(mutantRoles);
      await db.query('REVOKE inventory_proof_donor FROM module_inventory');
      expect((await db.query(effective)).rows).toEqual([{ value: false }]);
      expect((await db.query(direct)).rows).toEqual([{ value: 0 }]);
      expect(await snapshot(db, [...oldTables, eventTable])).toEqual(accepted);
      expect(await roleProvenance(db)).toEqual(roles);
      await atomicSql(db, readMigration(forward));
      expect(await eventCatalog(db)).toEqual(catalog);
    } finally {
      await db.query('ROLLBACK TO SAVEPOINT inherited_owner_fixture');
      await db.query('RELEASE SAVEPOINT inherited_owner_fixture');
    }
  });

  it('refuses unapproved default donor ACL before creating events', async () => {
    await seedHistorical(db);
    const before = await snapshot(db, oldTables);
    await db.query('SAVEPOINT default_acl_probe');
    try {
      await db.query(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA inventory GRANT SELECT ON TABLES TO inventory_proof_donor',
      );
      expect(
        (
          await db.query(`SELECT a.privilege_type value FROM pg_default_acl d,LATERAL aclexplode(d.defaclacl) a
        WHERE d.defaclnamespace='inventory'::regnamespace AND a.grantee='inventory_proof_donor'::regrole`)
        ).rows,
      ).toEqual([{ value: 'SELECT' }]);
      await rejected(
        readMigration(forward),
        /inventory-0074 unexpected event privileges, including inherited\/default grants/,
      );
      expect(
        (await db.query("SELECT to_regclass('inventory.lot_recall_event') value")).rows,
      ).toEqual([{ value: null }]);
      expect(await snapshot(db, oldTables)).toEqual(before);
    } finally {
      await db.query('ROLLBACK TO SAVEPOINT default_acl_probe');
      await db.query('RELEASE SAVEPOINT default_acl_probe');
    }
    await atomicSql(db, readMigration(forward));
  });

  it('preserves six-table original replay and refuses original replay at seven-table epoch', async () => {
    await seedHistorical(db);
    expect(await observedEpoch(db)).toBe('inventory-0066-six');
    const before = await snapshot(db, oldTables);
    const roles = await roleProvenance(db);
    await recordRolePhase(db, 'before-original-replay');
    await atomicSql(db, readMigration(historical));
    expect(await snapshot(db, oldTables)).toEqual(before);
    expect(await roleProvenance(db)).toEqual(roles);
    await recordRolePhase(db, 'after-original-replay');
    await recordRolePhase(db, 'before-forward');
    await atomicSql(db, readMigration(forward));
    await recordRolePhase(db, 'after-forward');
    const seven = await snapshot(db, [...oldTables, eventTable]);
    await rejected(readMigration(historical), /rls coverage failure.*lot_recall_event/);
    expect(await snapshot(db, [...oldTables, eventTable])).toEqual(seven);
    expect(fixtureProvenance.get(db)?.map(({ phase }) => phase)).toEqual([
      'before-beginFixture',
      'before-original0066',
      'after-original0066',
      'before-original-replay',
      'after-original-replay',
      'before-forward',
      'after-forward',
    ]);
  });
});

describe('paired principal controls with independently fresh NULL binding', () => {
  for (const principal of ['module_inventory', 'practicehub_app'] as const) {
    it(`${principal}: own-tenant positive precedes cross, true missing and empty denials`, async () => {
      await upgrade();
      await principalSql(db, principal, tenants[0], insert, event(tenants[0]));
      expect(
        await principalSql(
          db,
          principal,
          tenants[0],
          'SELECT tenant_id FROM inventory.lot_recall_event',
        ),
      ).toEqual([{ tenant_id: tenants[0] }]);
      expect(
        await principalSql(
          db,
          principal,
          tenants[1],
          'SELECT tenant_id FROM inventory.lot_recall_event',
        ),
      ).toEqual([]);
      await expect(
        principalSql(db, principal, tenants[1], insert, event(tenants[0], 'recall:cross0001')),
      ).rejects.toMatchObject({ code: '42501' });
      // RESET cannot establish NULL after a custom GUC has existed. Close the
      // entire admitted fixture and reconstruct identical rows on a fresh session.
      await db.query('ROLLBACK');
      await db.end();
      connected = false;
      db = await connectDisposable();
      connected = true;
      await beginFixture(db);
      await seedHistorical(db, true);
      await atomicSql(db, readMigration(forward));
      await ownerSql(db, insert, event(tenants[0]));
      expect(
        (await db.query("SELECT current_setting('practicehub.tenant_id',true) value")).rows,
      ).toEqual([{ value: null }]);
      expect(
        await principalSql(
          db,
          principal,
          undefined,
          'SELECT tenant_id FROM inventory.lot_recall_event',
        ),
      ).toEqual([]);
      await expect(
        principalSql(db, principal, undefined, insert, event(tenants[0], 'recall:missing01')),
      ).rejects.toMatchObject({ code: '42501' });
      expect(
        await principalSql(
          db,
          principal,
          tenants[0],
          'SELECT tenant_id FROM inventory.lot_recall_event',
        ),
      ).toEqual([{ tenant_id: tenants[0] }]);
      expect(
        await principalSql(
          db,
          principal,
          '',
          "SELECT current_setting('practicehub.tenant_id',true) value",
        ),
      ).toEqual([{ value: '' }]);
      expect(
        await principalSql(db, principal, '', 'SELECT tenant_id FROM inventory.lot_recall_event'),
      ).toEqual([]);
      await expect(
        principalSql(db, principal, '', insert, event(tenants[0], 'recall:empty0001')),
      ).rejects.toMatchObject({ code: '42501' });
    });
  }
});

describe('real fixture artifact refusals retain mixed events/history/security', () => {
  for (const fault of [
    'missing',
    'corrupt',
    'truncated',
    'digest',
    'nonsynthetic',
    'shape',
    'target',
  ] as const) {
    it(`${fault} artifact refuses before inverse effects`, async () => {
      await upgrade();
      for (const tenant of tenants) {
        await moduleSql(db, tenant, insert, event(tenant));
        const release = event(tenant);
        release[2] = 'released';
        await moduleSql(db, tenant, insert, release);
      }
      const binding = proofBindingFromGrant();
      const valid = await preserveEvents(db, binding);
      const before = await snapshot(db, [...oldTables, eventTable]);
      const roles = await roleProvenance(db);
      const catalog = await eventCatalog(db);
      if (!catalog) throw new Error('Missing accepted event catalog');
      let invalid: EventDescriptor;
      let diagnostic: RegExp;
      if (fault === 'missing') {
        const hash = createHash('sha256')
          .update(`inventory missing ${binding.artifactOwner}`)
          .digest('hex');
        invalid = { ...valid, sha256: hash, path: join(binding.ownedRoot, `events-${hash}.json`) };
        diagnostic = /ENOENT/;
      } else if (fault === 'target') {
        invalid = { ...valid, binding: { ...binding, target: { ...binding.target, oid: '0' } } };
        diagnostic = /artifact binding/;
      } else {
        const source = readFileSync(valid.path, 'utf8');
        let content = source;
        if (fault === 'corrupt') content = '{invalid JSON';
        if (fault === 'truncated') content = source.slice(0, 9);
        if (fault === 'nonsynthetic')
          content = source.replace('"synthetic": true', '"synthetic": false');
        if (fault === 'shape') content = source.replace('"reason":', '"wrong_key":');
        const bytes = Buffer.from(content, 'utf8');
        const hash = createHash('sha256')
          .update(fault === 'digest' ? 'wrong digest bytes' : bytes)
          .digest('hex');
        const path = join(binding.ownedRoot, `events-${hash}.json`);
        // New content-addressed fixtures only: never overwrite a retained receipt.
        try {
          writeFileSync(path, bytes, { flag: 'wx' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          expect(readFileSync(path)).toEqual(bytes);
        }
        invalid = {
          ...valid,
          path,
          sha256: hash,
          bytes: fault === 'truncated' ? valid.bytes : bytes.length,
        };
        diagnostic =
          fault === 'corrupt'
            ? /JSON|property name/
            : fault === 'truncated'
              ? /artifact byte count/
              : fault === 'digest'
                ? /artifact digest/
                : fault === 'nonsynthetic'
                  ? /synthetic tenant\/row/
                  : /exact event keys/;
      }
      await expect(inverseFromArtifact(db, invalid, { binding, catalog, roles })).rejects.toThrow(
        diagnostic,
      );
      expect(await snapshot(db, [...oldTables, eventTable])).toEqual(before);
      expect(await eventCatalog(db)).toEqual(catalog);
      expect(await roleProvenance(db)).toEqual(roles);
      expect(readEventArtifact(valid, binding)).toHaveLength(4);
    });
  }
});

// Actual restore adapter controls. Future root grant must explicitly allow the
// temporary corruption/removal and byte restoration of this proof-owned artifact.
// They are separate from the inverse adapter's refusal controls above.
describe('restore adapter refuses before any INSERT and retains full destination state', () => {
  for (const fault of [
    'target',
    'epoch',
    'owner',
    'catalog',
    'provenance',
    'artifact',
    'corrupt-after-observation',
    'remove-after-observation',
  ] as const) {
    it(`${fault} restore refusal leaves the empty destination unchanged`, async () => {
      await upgrade();
      for (const tenant of tenants) {
        await moduleSql(db, tenant, insert, event(tenant));
        const release = event(tenant);
        release[2] = 'released';
        await moduleSql(db, tenant, insert, release);
      }
      const binding = proofBindingFromGrant();
      const descriptor = await preserveEvents(db, binding);
      const catalog = await eventCatalog(db);
      if (!catalog) throw new Error('Missing accepted catalog');
      await inverseFromArtifact(db, descriptor, {
        binding,
        catalog,
        roles: await roleProvenance(db),
      });
      await atomicSql(db, readMigration(forward));
      const roles = await roleProvenance(db);
      const before = await snapshot(db, [...oldTables, eventTable]);
      const expectation = { binding, catalog, roles };
      const bytes = readFileSync(descriptor.path);
      expect(readEventArtifact(descriptor, binding)).toHaveLength(4); // known valid before observation
      let inserts = 0;
      let observations = 0;
      const invalid = fault === 'artifact' ? { ...descriptor, count: 3 } : descriptor;
      const diagnostic =
        fault === 'target'
          ? /target identity/
          : fault === 'epoch'
            ? /inverse epoch/
            : fault === 'owner' || fault === 'catalog'
              ? /event catalog/
              : fault === 'provenance'
                ? /inverse role posture/
                : fault === 'artifact'
                  ? /artifact row count/
                  : fault === 'corrupt-after-observation'
                    ? /artifact byte count/
                    : /ENOENT/;
      try {
        await expect(
          restoreFromArtifact(db, invalid, expectation, false, {
            afterObservation(observed) {
              observations++;
              if (fault === 'target') observed.target = { ...observed.target, oid: '0' };
              if (fault === 'epoch') observed.epoch = 'inventory-0066-six';
              if (fault === 'owner')
                observed.catalog = { ...observed.catalog, owner: 'other_owner' };
              if (fault === 'catalog') observed.catalog = { ...observed.catalog, force: false };
              if (fault === 'provenance')
                observed.roles = {
                  ...roles,
                  settings: [
                    ...roles.settings,
                    {
                      setdatabase: '0',
                      setrole: 'module_inventory',
                      setconfig: ['search_path=public'],
                    },
                  ],
                };
              if (fault === 'corrupt-after-observation') writeFileSync(descriptor.path, '[]');
              if (fault === 'remove-after-observation') unlinkSync(descriptor.path);
            },
            beforeInsert() {
              inserts++;
            },
          }),
        ).rejects.toThrow(diagnostic);
        expect(observations).toBe(1);
        expect(inserts).toBe(0);
        expect(await snapshot(db, [...oldTables, eventTable])).toEqual(before);
        expect(await eventCatalog(db)).toEqual(catalog);
        expect(await roleProvenance(db)).toEqual(roles);
      } finally {
        if (fault === 'corrupt-after-observation' || fault === 'remove-after-observation')
          writeFileSync(descriptor.path, bytes);
      }
      expect(readEventArtifact(descriptor, binding)).toHaveLength(4);
      // Paired real positive: same empty destination, observation, artifact and adapter.
      await restoreFromArtifact(db, descriptor, expectation, false, {
        beforeInsert() {
          inserts++;
        },
      });
      expect(inserts).toBe(4);
      expect(await roleProvenance(db)).toEqual(roles);
      expect(await eventCatalog(db)).toEqual(catalog);
      expect(await snapshot(db, oldTables)).toEqual(
        Object.fromEntries(Object.entries(before).filter(([key]) => key !== eventTable)),
      );
    });
  }
});

// Future DB mutation controls for the comparison itself, under exact additional
// root effects authority. Synthetic comparator tests do not replace these.
describe('lifecycle provenance controls reject unrelated real role effects', () => {
  it('allows event-only inverse/reapply but detects unrelated dependencies, comments and settings', async () => {
    await upgrade();
    for (const tenant of tenants) {
      await moduleSql(db, tenant, insert, event(tenant));
      const release = event(tenant);
      release[2] = 'released';
      await moduleSql(db, tenant, insert, release);
    }
    const binding = proofBindingFromGrant();
    const descriptor = await preserveEvents(db, binding);
    const catalog = await eventCatalog(db);
    if (!catalog) throw new Error('Missing accepted catalog');
    const seven = await roleProvenance(db);
    await inverseFromArtifact(db, descriptor, { binding, catalog, roles: seven });
    const six = await roleProvenance(db);
    validateEventRoleTransition(seven, six, 'inverse');
    await db.query('SAVEPOINT unrelated_dependency_control');
    try {
      await db.query(`CREATE TABLE platform_core.inventory_provenance_probe (synthetic boolean);
        GRANT SELECT ON platform_core.inventory_provenance_probe TO module_inventory`);
      const changed = await roleProvenance(db);
      expect(changed.dependencies).not.toEqual(six.dependencies);
      expect(() => validateEventRoleTransition(seven, changed, 'inverse')).toThrow(
        /event-only role provenance transition/,
      );
    } finally {
      await db.query('ROLLBACK TO SAVEPOINT unrelated_dependency_control');
      await db.query('RELEASE SAVEPOINT unrelated_dependency_control');
    }
    expect(await roleProvenance(db)).toEqual(six);
    await atomicSql(db, readMigration(forward));
    const reapplied = await roleProvenance(db);
    validateEventRoleTransition(seven, reapplied, 'reapply');
    const state = await snapshot(db, [...oldTables, eventTable]);
    for (const mutation of [
      "COMMENT ON ROLE module_inventory IS 'synthetic unrelated provenance control'",
      'ALTER ROLE module_inventory IN DATABASE CURRENT_DATABASE SET search_path TO pg_catalog',
    ]) {
      await db.query('SAVEPOINT restore_role_control');
      try {
        // CURRENT_DATABASE is not a SQL identifier placeholder: obtain/quote the
        // admitted database name for the ALTER ROLE grammar, never invent an OID.
        const database = binding.target.database.replace(/"/g, '""');
        await db.query(mutation.replace('CURRENT_DATABASE', `"${database}"`));
        const changed = await roleProvenance(db);
        expect(changed).not.toEqual(reapplied);
        expect(() => validateEventRoleTransition(seven, changed, 'reapply')).toThrow(
          /event-only role provenance transition/,
        );
        let inserts = 0;
        await expect(
          restoreFromArtifact(db, descriptor, { binding, catalog, roles: reapplied }, false, {
            beforeInsert() {
              inserts++;
            },
          }),
        ).rejects.toThrow(/inverse role posture/);
        expect(inserts).toBe(0);
        expect(await snapshot(db, [...oldTables, eventTable])).toEqual(state);
        expect(await eventCatalog(db)).toEqual(catalog);
        expect(await roleProvenance(db)).toEqual(changed);
      } finally {
        await db.query('ROLLBACK TO SAVEPOINT restore_role_control');
        await db.query('RELEASE SAVEPOINT restore_role_control');
      }
      expect(await roleProvenance(db)).toEqual(reapplied);
    }
  });
});
