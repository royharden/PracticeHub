-- 0074: accepted recall-event STORAGE reissue; application containment is separate.
-- Execute atomically through the migration journal or controlled proof harness.
-- Validate the historical epoch before doing any work; do not repair it.
DO $prerequisites$
DECLARE missing text;
BEGIN
  SELECT string_agg(expected, ', ' ORDER BY expected) INTO missing
  FROM unnest(ARRAY['dispense', 'dispense_unit', 'lot', 'product', 'recall_unit', 'unit']::text[]) expected
  WHERE NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='inventory' AND c.relkind='r' AND c.relname=expected);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'inventory-0074 prerequisite missing ordinary tables: %', missing;
  END IF;
  IF to_regclass('platform_core.tenant') IS NULL OR NOT EXISTS
    (SELECT 1 FROM pg_roles WHERE rolname='module_inventory' AND NOT rolsuper AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'inventory-0074 requires tenant table and non-bypass module_inventory role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='inventory' AND c.relkind IN ('p','f')) THEN
    RAISE EXCEPTION 'inventory-0074 unexpected partitioned or foreign table';
  END IF;
END
$prerequisites$;

DO $coverage$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO offender
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'inventory'
     AND c.relkind = 'r'
     AND (NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR c.relname NOT IN ('dispense', 'dispense_unit', 'lot', 'lot_recall_event', 'product', 'recall_unit', 'unit'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema inventory: %', offender;
  END IF;
END
$coverage$;

CREATE TEMP TABLE inventory_recall_expected (
  tenant_id text NOT NULL,
  recall_ref text NOT NULL CHECK (recall_ref ~ '^recall:[a-z0-9][a-z0-9-]{7,63}$'),
  kind text NOT NULL CHECK (kind IN ('recalled', 'released')),
  lot_ref text NOT NULL CHECK (lot_ref ~ '^lot:[a-z0-9][a-z0-9-]{7,63}$'),
  actor text NOT NULL CHECK (actor ~ '^[a-z][a-z0-9-]{1,31}:[a-z0-9][a-z0-9-]{1,63}$'),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  event_on date NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, recall_ref, kind),
  CHECK (kind <> 'released' OR actor ~ '^human:')
);
-- Compare an existing event relation to the accepted shape, using PostgreSQL's
-- own normalized column/check/key definitions; FKs are checked against their exact
-- column positions and referenced relations separately (temporary-table FKs cannot
-- target permanent tables). Never bless CREATE IF NOT EXISTS drift.
DO $shape$
DECLARE actual oid := to_regclass('inventory.lot_recall_event');
BEGIN
  IF actual IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid=actual AND relkind='r'
      AND relpersistence='p' AND NOT relispartition) THEN
      RAISE EXCEPTION 'inventory-0074 unexpected existing event relation';
    END IF;
    IF EXISTS (
      WITH signatures AS (
        SELECT attrelid,
          jsonb_agg(jsonb_build_array(attname, atttypid, atttypmod, attnotnull,
            attidentity, attgenerated, attcollation, pg_get_expr(d.adbin,d.adrelid)) ORDER BY attnum) AS value
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE attrelid IN (actual, 'pg_temp.inventory_recall_expected'::regclass)
          AND attnum>0 AND NOT attisdropped GROUP BY attrelid)
      SELECT 1 WHERE (SELECT value FROM signatures WHERE attrelid=actual) IS DISTINCT FROM
        (SELECT value FROM signatures WHERE attrelid='pg_temp.inventory_recall_expected'::regclass)
    ) OR EXISTS (
      WITH signatures AS (
        SELECT conrelid, jsonb_agg(jsonb_build_array(contype, pg_get_constraintdef(oid),
          convalidated, condeferrable, condeferred) ORDER BY contype, pg_get_constraintdef(oid)) value
        FROM pg_constraint WHERE contype <> 'f' AND conrelid IN (actual,'pg_temp.inventory_recall_expected'::regclass)
        GROUP BY conrelid)
      SELECT 1 WHERE (SELECT value FROM signatures WHERE conrelid=actual) IS DISTINCT FROM
        (SELECT value FROM signatures WHERE conrelid='pg_temp.inventory_recall_expected'::regclass)
    ) OR (SELECT count(*) FROM pg_constraint WHERE conrelid=actual AND contype='f') <> 2
      OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=actual AND contype='f'
        AND conkey=ARRAY[1]::smallint[] AND confkey=ARRAY[1]::smallint[]
        AND confrelid='platform_core.tenant'::regclass AND convalidated
        AND NOT condeferrable AND NOT condeferred AND confupdtype='a' AND confdeltype='a' AND confmatchtype='s')
      OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=actual AND contype='f'
        AND conkey=ARRAY[1,4]::smallint[] AND confkey=ARRAY[1,2]::smallint[]
        AND confrelid='inventory.lot'::regclass AND convalidated
        AND NOT condeferrable AND NOT condeferred AND confupdtype='a' AND confdeltype='a' AND confmatchtype='s')
      OR (SELECT count(*) FROM pg_index WHERE indrelid=actual) <> 1
      OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=actual AND NOT tgisinternal)
      OR EXISTS (SELECT 1 FROM pg_rewrite WHERE ev_class=actual)
      OR EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=actual OR inhparent=actual) THEN
      RAISE EXCEPTION 'inventory-0074 unexpected existing event schema';
    END IF;
    IF (SELECT count(*) FROM pg_policy WHERE polrelid=actual) <> 1 OR NOT EXISTS (
      SELECT 1 FROM pg_policy WHERE polrelid=actual AND polname='tenant_isolation'
        AND polcmd='*' AND polpermissive AND polroles=ARRAY[0::oid]
        AND pg_get_expr(polqual,polrelid) = '(tenant_id = current_setting(''practicehub.tenant_id''::text, true))'
        AND pg_get_expr(polwithcheck,polrelid) = '(tenant_id = current_setting(''practicehub.tenant_id''::text, true))'
    ) OR EXISTS (
      SELECT 1 FROM pg_class c, LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=actual AND a.grantee<>c.relowner AND
        (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='module_inventory')
          OR a.privilege_type NOT IN ('SELECT','INSERT') OR a.is_grantable)
    ) OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=actual AND attacl IS NOT NULL)
      OR NOT has_table_privilege('module_inventory',actual,'SELECT')
      OR NOT has_table_privilege('module_inventory',actual,'INSERT')
      OR has_table_privilege('module_inventory',actual,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
      RAISE EXCEPTION 'inventory-0074 unexpected existing event policy or ACL';
    END IF;
  END IF;
END
$shape$;
DROP TABLE pg_temp.inventory_recall_expected;

CREATE TABLE IF NOT EXISTS inventory.lot_recall_event (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  recall_ref text NOT NULL CHECK (recall_ref ~ '^recall:[a-z0-9][a-z0-9-]{7,63}$'),
  kind text NOT NULL CHECK (kind IN ('recalled', 'released')),
  lot_ref text NOT NULL CHECK (lot_ref ~ '^lot:[a-z0-9][a-z0-9-]{7,63}$'),
  actor text NOT NULL CHECK (actor ~ '^[a-z][a-z0-9-]{1,31}:[a-z0-9][a-z0-9-]{1,63}$'),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  event_on date NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, recall_ref, kind),
  CHECK (kind <> 'released' OR actor ~ '^human:'),
  FOREIGN KEY (tenant_id, lot_ref) REFERENCES inventory.lot (tenant_id, lot_ref)
);
REVOKE ALL ON inventory.lot_recall_event FROM PUBLIC, module_inventory;
GRANT SELECT, INSERT ON inventory.lot_recall_event TO module_inventory;
DO $privileges$
BEGIN
  IF has_table_privilege('module_inventory','inventory.lot_recall_event','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    OR EXISTS (SELECT 1 FROM pg_class c, LATERAL aclexplode(c.relacl) a
      WHERE c.oid='inventory.lot_recall_event'::regclass AND a.grantee<>c.relowner
        AND (a.grantee<>(SELECT oid FROM pg_roles WHERE rolname='module_inventory')
          OR a.privilege_type NOT IN ('SELECT','INSERT') OR a.is_grantable)) THEN
    RAISE EXCEPTION 'inventory-0074 unexpected event privileges, including inherited/default grants';
  END IF;
END
$privileges$;
-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE inventory.lot_recall_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory.lot_recall_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON inventory.lot_recall_event;
CREATE POLICY tenant_isolation ON inventory.lot_recall_event
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

DO $coverage$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO offender
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'inventory'
     AND c.relkind = 'r'
     AND (NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR c.relname NOT IN ('dispense', 'dispense_unit', 'lot', 'lot_recall_event', 'product', 'recall_unit', 'unit'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema inventory: %', offender;
  END IF;
END
$coverage$;
-- rls:generated:end
