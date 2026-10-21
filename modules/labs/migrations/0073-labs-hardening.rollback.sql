-- 0073 labs storage hardening. The trusted caller MUST own the transaction.
-- No data backfill. Only the exact original or this migration's complete state is accepted.
-- Temporary reference tables make catalog expectations executable on the target PG version.
DO $labs73$
DECLARE
  t text; cols text; actual oid; expected oid; role_id oid; app_id oid; hardened boolean;
  origin text;
BEGIN
  PERFORM pg_advisory_xact_lock(730064, 73);
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN
    RAISE EXCEPTION '0073 requires the trusted superuser migration owner';
  END IF;
  PERFORM set_config('search_path','pg_catalog,pg_temp',true);
  origin := 'PracticeHub:0073-labs-hardening:v1:db=' ||
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) || ':owner=' ||
    (SELECT oid::text FROM pg_roles WHERE rolname=current_user);
  SELECT oid INTO role_id FROM pg_roles WHERE rolname='module_labs';
  SELECT oid INTO app_id FROM pg_roles WHERE rolname='practicehub_app' AND NOT rolsuper
    AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND rolinherit;
  IF app_id IS NULL THEN RAISE EXCEPTION '0073 requires safe practicehub_app role'; END IF;
  IF (SELECT count(*) FROM pg_class WHERE relnamespace=to_regnamespace('labs') AND relkind IN ('r','p','v','m','f','S')) <> 6
    OR NOT EXISTS (SELECT FROM pg_namespace WHERE nspname='labs' AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user))
    OR EXISTS (SELECT FROM pg_default_acl WHERE defaclnamespace=to_regnamespace('labs')) THEN
    RAISE EXCEPTION '0073 requires exact six-table labs schema/owner/default ACL';
  END IF;
  LOCK TABLE labs.lab_order, labs.lab_result, labs.critical_closure, labs.expected_result_age,
    labs.device_calibration, labs.device_recall IN ACCESS EXCLUSIVE MODE;
  hardened := EXISTS (SELECT FROM pg_attribute WHERE attrelid='labs.critical_closure'::regclass
    AND attname='superseded_at' AND NOT attisdropped);
CREATE TEMP TABLE lab_order (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  order_id text NOT NULL CHECK (order_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  subject_ref text NOT NULL CHECK (subject_ref ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  loinc_code text NOT NULL CHECK (char_length(loinc_code) BETWEEN 1 AND 200),
  loinc_display text NOT NULL CHECK (char_length(loinc_display) BETWEEN 1 AND 200),
  ordered_at timestamptz NOT NULL,
  expected_result_by timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('awaiting-result', 'resulted')),
  service_request_id text NOT NULL CHECK (service_request_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  current_result_id text CHECK (
    current_result_id IS NULL OR current_result_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'
  ),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, order_id),
  CONSTRAINT lab_order_expected_after_ordered CHECK (expected_result_by > ordered_at)
) ON COMMIT DROP;

CREATE TEMP TABLE lab_result (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  result_id text NOT NULL CHECK (result_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  order_id text NOT NULL CHECK (order_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  supersedes_result_id text CHECK (
    supersedes_result_id IS NULL OR supersedes_result_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'
  ),
  value_text text NOT NULL CHECK (char_length(value_text) BETWEEN 1 AND 200),
  critical boolean NOT NULL,
  recorded_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('electronic', 'manual', 'device')),
  provisional boolean NOT NULL,
  reconciliation text NOT NULL CHECK (
    reconciliation IN (
      'not-applicable',
      'pending',
      'matched',
      'conflict',
      'adjudicated-manual',
      'adjudicated-electronic'
    )
  ),
  read_back_by text CHECK (
    read_back_by IS NULL OR read_back_by ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'
  ),
  read_back_at timestamptz,
  read_back_value text CHECK (
    read_back_value IS NULL OR char_length(read_back_value) BETWEEN 1 AND 200
  ),
  observation_id text NOT NULL CHECK (observation_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  report_id text NOT NULL CHECK (report_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, result_id),
  UNIQUE (tenant_id, order_id, result_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES pg_temp.lab_order (tenant_id, order_id),
  CONSTRAINT lab_result_not_self_supersede CHECK (
    supersedes_result_id IS NULL OR supersedes_result_id <> result_id
  ),
  CONSTRAINT lab_result_manual_read_back CHECK (
    source <> 'manual'
    OR (
      provisional
      AND read_back_by IS NOT NULL
      AND read_back_at IS NOT NULL
      AND read_back_value = value_text
    )
  ),
  CONSTRAINT lab_result_provisional_shape CHECK (
    (source = 'manual' AND provisional)
    OR (source IN ('electronic', 'device') AND provisional = (reconciliation = 'conflict'))
  )
) ON COMMIT DROP;

CREATE TEMP TABLE critical_closure (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  closure_id text NOT NULL CHECK (closure_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  order_id text NOT NULL CHECK (order_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  result_id text NOT NULL CHECK (result_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  phase text NOT NULL CHECK (phase IN ('paged', 'acknowledged', 'contacted', 'closed')),
  paged_at timestamptz NOT NULL,
  acknowledged_at timestamptz,
  acknowledged_by text CHECK (
    acknowledged_by IS NULL OR acknowledged_by ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'
  ),
  contacted_at timestamptz,
  contact_evidence text CHECK (
    contact_evidence IS NULL OR char_length(contact_evidence) BETWEEN 1 AND 200
  ),
  closed_at timestamptz,
  closed_by text CHECK (closed_by IS NULL OR closed_by ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  work_item_id text NOT NULL CHECK (work_item_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, closure_id),
  UNIQUE (tenant_id, result_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES pg_temp.lab_order (tenant_id, order_id),
  FOREIGN KEY (tenant_id, result_id) REFERENCES pg_temp.lab_result (tenant_id, result_id),
  CONSTRAINT critical_closure_steps CHECK (
    (
      phase = 'paged'
      AND acknowledged_at IS NULL
      AND contacted_at IS NULL
      AND closed_at IS NULL
    )
    OR (
      phase = 'acknowledged'
      AND acknowledged_at IS NOT NULL
      AND acknowledged_by IS NOT NULL
      AND contacted_at IS NULL
      AND closed_at IS NULL
    )
    OR (
      phase = 'contacted'
      AND acknowledged_at IS NOT NULL
      AND contacted_at IS NOT NULL
      AND contact_evidence IS NOT NULL
      AND closed_at IS NULL
    )
    OR (
      phase = 'closed'
      AND acknowledged_at IS NOT NULL
      AND contacted_at IS NOT NULL
      AND contact_evidence IS NOT NULL
      AND closed_at IS NOT NULL
      AND closed_by IS NOT NULL
    )
  )
) ON COMMIT DROP;

CREATE TEMP TABLE expected_result_age (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  order_id text NOT NULL CHECK (order_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  aged_at timestamptz NOT NULL,
  expected_result_by timestamptz NOT NULL,
  work_item_id text NOT NULL CHECK (work_item_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, order_id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES pg_temp.lab_order (tenant_id, order_id)
) ON COMMIT DROP;

CREATE TEMP TABLE device_calibration (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  result_id text NOT NULL CHECK (result_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  device_id text NOT NULL CHECK (device_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  lot_id text NOT NULL CHECK (lot_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  calibrated_at timestamptz NOT NULL,
  calibration_method text NOT NULL CHECK (char_length(calibration_method) BETWEEN 1 AND 200),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, result_id),
  FOREIGN KEY (tenant_id, result_id) REFERENCES pg_temp.lab_result (tenant_id, result_id)
) ON COMMIT DROP;

CREATE TEMP TABLE device_recall (
  tenant_id text NOT NULL CHECK (tenant_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  recall_id text NOT NULL CHECK (recall_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  device_id text NOT NULL CHECK (device_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  lot_id text NOT NULL CHECK (lot_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  result_id text NOT NULL CHECK (result_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  recalled_at timestamptz NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, recall_id, result_id),
  FOREIGN KEY (tenant_id, result_id) REFERENCES pg_temp.lab_result (tenant_id, result_id)
) ON COMMIT DROP;
IF hardened THEN
ALTER TABLE pg_temp.lab_result DROP CONSTRAINT lab_result_manual_read_back,
  DROP CONSTRAINT lab_result_provisional_shape,
  ADD CONSTRAINT lab_result_manual_read_back CHECK (source <> 'manual' OR
    (read_back_by IS NOT NULL AND read_back_at IS NOT NULL AND read_back_value IS NOT NULL AND read_back_value = value_text)),
  ADD CONSTRAINT lab_result_provisional_shape CHECK (
    (source = 'manual' AND provisional = (reconciliation <> 'adjudicated-manual')) OR
    (source IN ('electronic','device') AND provisional = (reconciliation IN ('conflict','adjudicated-manual'))));
ALTER TABLE pg_temp.critical_closure
  ADD COLUMN superseded_at timestamptz,
  ADD COLUMN superseded_by text CONSTRAINT critical_closure_superseded_by_check
    CHECK (superseded_by IS NULL OR superseded_by ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  ADD COLUMN superseded_reason text CONSTRAINT critical_closure_superseded_reason_check
    CHECK (superseded_reason IS NULL OR char_length(superseded_reason) BETWEEN 1 AND 200),
  DROP CONSTRAINT critical_closure_phase_check,
  DROP CONSTRAINT critical_closure_steps,
  ADD CONSTRAINT critical_closure_phase_check CHECK (phase IN ('paged','acknowledged','contacted','closed','superseded')),
  ADD CONSTRAINT critical_closure_steps CHECK (
    (phase = 'paged' AND acknowledged_at IS NULL AND contacted_at IS NULL AND closed_at IS NULL) OR
    (phase = 'acknowledged' AND acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL AND contacted_at IS NULL AND closed_at IS NULL) OR
    (phase = 'contacted' AND acknowledged_at IS NOT NULL AND contacted_at IS NOT NULL AND contact_evidence IS NOT NULL AND closed_at IS NULL) OR
    (phase = 'closed' AND acknowledged_at IS NOT NULL AND contacted_at IS NOT NULL AND contact_evidence IS NOT NULL AND closed_at IS NOT NULL AND closed_by IS NOT NULL) OR
    (phase = 'superseded' AND closed_at IS NULL AND superseded_at IS NOT NULL AND superseded_by IS NOT NULL AND superseded_reason IS NOT NULL)),
  ADD CONSTRAINT critical_closure_superseded_only_when_superseded CHECK
    (phase = 'superseded' OR (superseded_at IS NULL AND superseded_by IS NULL AND superseded_reason IS NULL));
END IF;

IF hardened THEN
  IF role_id IS NULL OR shobj_description(role_id,'pg_authid') IS DISTINCT FROM origin
    OR NOT EXISTS (SELECT FROM pg_roles WHERE oid=role_id AND NOT rolcanlogin AND NOT rolsuper
      AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
      AND rolinherit AND rolconnlimit=-1 AND rolvaliduntil IS NULL AND rolconfig IS NULL)
    OR (SELECT count(*) FROM pg_auth_members WHERE roleid=role_id OR member=role_id) <> 1
    OR NOT EXISTS (SELECT FROM pg_auth_members m WHERE roleid=role_id AND member=app_id AND NOT admin_option
      -- PostgreSQL records superuser membership grants as bootstrap-superuser OID 10.
      AND grantor=(SELECT oid FROM pg_roles WHERE oid=10 AND rolsuper)
      AND coalesce((to_jsonb(m)->>'inherit_option')::boolean,true)
      AND coalesce((to_jsonb(m)->>'set_option')::boolean,true))
    OR EXISTS (SELECT FROM pg_db_role_setting WHERE setrole=role_id)
    OR EXISTS (SELECT FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=role_id
      AND NOT (dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND deptype='a'
        AND ((classid='pg_namespace'::regclass AND objid='labs'::regnamespace)
          OR (classid='pg_class'::regclass AND objid IN (SELECT oid FROM pg_class WHERE relnamespace='labs'::regnamespace AND relkind='r'))))) THEN
    RAISE EXCEPTION '0073 unknown role origin/attributes/membership/external dependency';
  END IF;
ELSIF role_id IS NOT NULL THEN
  RAISE EXCEPTION '0073 refuses preexisting module_labs role';
END IF;

-- Compare both directions, including all columns, validated CHECKs, keys, FKs,
-- index shape, triggers, policy expressions, ACLs and ownership. Extra objects fail closed.
FOR t IN SELECT unnest(ARRAY['lab_order','lab_result','critical_closure','expected_result_age','device_calibration','device_recall']) LOOP
  actual := to_regclass('labs.' || t); expected := to_regclass('pg_temp.' || t);
  IF actual IS NULL OR NOT EXISTS (SELECT FROM pg_class WHERE oid=actual AND relkind='r'
      AND relpersistence='p' AND relrowsecurity AND relforcerowsecurity
      AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
      AND relam=(SELECT relam FROM pg_class WHERE oid=expected)
      AND relreplident='d' AND reloptions IS NULL AND NOT relispartition) THEN
    RAISE EXCEPTION '0073 unexpected table/RLS/owner: %', t;
  END IF;
  IF EXISTS (
    WITH a AS (SELECT attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated,attcollation,
      pg_get_expr(d.adbin,d.adrelid) AS def FROM pg_attribute x
      LEFT JOIN pg_attrdef d ON d.adrelid=x.attrelid AND d.adnum=x.attnum
      WHERE attrelid=actual AND attnum>0 AND NOT attisdropped),
    b AS (SELECT attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated,attcollation,
      pg_get_expr(d.adbin,d.adrelid) AS def FROM pg_attribute x
      LEFT JOIN pg_attrdef d ON d.adrelid=x.attrelid AND d.adnum=x.attnum
      WHERE attrelid=expected AND attnum>0 AND NOT attisdropped)
    (SELECT * FROM a EXCEPT SELECT * FROM b) UNION ALL (SELECT * FROM b EXCEPT SELECT * FROM a)
  ) THEN RAISE EXCEPTION '0073 unknown/partial column schema: %',t; END IF;
  IF EXISTS (
    -- Non-FK definitions (especially CHECK literals) are compared verbatim.
    -- FK relation names are catalog identifiers, never text replacements in SQL.
    -- Namespace identity, ordered key names, actions and equality operators all match.
    -- Resolve attnums to names: rollback/reapply leaves dropped audit-column slots.
    WITH a AS (SELECT conname,contype,convalidated,condeferrable,condeferred,
      connoinherit,conislocal,coninhcount,
      ARRAY(SELECT attname FROM unnest(conkey) WITH ORDINALITY k(num,pos)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.pos) AS keys,
      ARRAY(SELECT attname FROM unnest(confkey) WITH ORDINALITY k(num,pos)
        JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.pos) AS referenced_keys,
      ARRAY(SELECT attname FROM unnest(confdelsetcols) WITH ORDINALITY k(num,pos)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.pos) AS delete_set_keys,
      confupdtype,confdeltype,confmatchtype,conpfeqop,conppeqop,conffeqop,
      r.relname AS referenced_table, r.relnamespace='labs'::regnamespace AS local_reference,
      CASE WHEN contype<>'f' THEN pg_get_constraintdef(c.oid) END AS def
      FROM pg_constraint c LEFT JOIN pg_class r ON r.oid=c.confrelid WHERE conrelid=actual),
    b AS (SELECT conname,contype,convalidated,condeferrable,condeferred,
      connoinherit,conislocal,coninhcount,
      ARRAY(SELECT attname FROM unnest(conkey) WITH ORDINALITY k(num,pos)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.pos) AS keys,
      ARRAY(SELECT attname FROM unnest(confkey) WITH ORDINALITY k(num,pos)
        JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.pos) AS referenced_keys,
      ARRAY(SELECT attname FROM unnest(confdelsetcols) WITH ORDINALITY k(num,pos)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.pos) AS delete_set_keys,
      confupdtype,confdeltype,confmatchtype,conpfeqop,conppeqop,conffeqop,
      r.relname AS referenced_table, r.relnamespace=pg_my_temp_schema() AS local_reference,
      CASE WHEN contype<>'f' THEN pg_get_constraintdef(c.oid) END AS def
      FROM pg_constraint c LEFT JOIN pg_class r ON r.oid=c.confrelid WHERE conrelid=expected)
    (SELECT * FROM a EXCEPT SELECT * FROM b) UNION ALL (SELECT * FROM b EXCEPT SELECT * FROM a)
  ) THEN RAISE EXCEPTION '0073 unknown constraint schema: %',t; END IF;
  IF EXISTS (SELECT FROM pg_constraint c JOIN pg_class r ON r.oid=c.confrelid
      WHERE c.conrelid=actual AND r.relnamespace <> 'labs'::regnamespace)
    OR EXISTS (SELECT FROM pg_trigger WHERE tgrelid=actual AND (NOT tgisinternal OR tgenabled<>'O'))
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid=actual) <>
       (SELECT count(*) FROM pg_trigger WHERE tgrelid=expected)
    OR EXISTS (SELECT FROM pg_inherits WHERE inhrelid=actual OR inhparent=actual)
    OR EXISTS (SELECT FROM pg_rewrite WHERE ev_class=actual) THEN
    RAISE EXCEPTION '0073 unexpected dependency/trigger/rule: %',t;
  END IF;
  IF EXISTS (
    WITH a AS (SELECT indnatts,indnkeyatts,indisunique,indnullsnotdistinct,indisprimary,indisexclusion,
      indimmediate,indisvalid,indisready,indislive,indkey,indcollation,indclass,indoption,
      indexprs::text,indpred::text,c.relam FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE indrelid=actual),
    b AS (SELECT indnatts,indnkeyatts,indisunique,indnullsnotdistinct,indisprimary,indisexclusion,
      indimmediate,indisvalid,indisready,indislive,indkey,indcollation,indclass,indoption,
      indexprs::text,indpred::text,c.relam FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE indrelid=expected)
    (SELECT * FROM a EXCEPT ALL SELECT * FROM b) UNION ALL (SELECT * FROM b EXCEPT ALL SELECT * FROM a)
  ) THEN
    RAISE EXCEPTION '0073 unexpected index schema: %',t;
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid=actual) <> 1 OR NOT EXISTS (
    SELECT FROM pg_policy WHERE polrelid=actual AND polname='tenant_isolation'
      AND polcmd='*' AND polpermissive AND polroles=ARRAY[0::oid]
      AND pg_get_expr(polqual,polrelid) = '(tenant_id = current_setting(''practicehub.tenant_id''::text, true))'
      AND pg_get_expr(polwithcheck,polrelid) = '(tenant_id = current_setting(''practicehub.tenant_id''::text, true))'
  ) THEN RAISE EXCEPTION '0073 unexpected tenant policy: %',t; END IF;
  IF EXISTS (SELECT FROM pg_attribute WHERE attrelid=actual AND attacl IS NOT NULL) THEN
    RAISE EXCEPTION '0073 unexpected column ACL: %',t;
  END IF;
  IF EXISTS (SELECT FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=actual AND a.grantee<>c.relowner AND
        (NOT hardened OR a.grantee<>role_id OR a.is_grantable OR a.grantor<>c.relowner OR
         a.privilege_type NOT IN ('SELECT','INSERT',CASE WHEN t IN ('device_calibration','device_recall') THEN 'SELECT' ELSE 'UPDATE' END))) THEN
    RAISE EXCEPTION '0073 unexpected table ACL: %',t;
  END IF;
  IF hardened AND (SELECT count(*) FROM pg_class c, LATERAL aclexplode(c.relacl) a
      WHERE c.oid=actual AND a.grantee=role_id) <>
      (CASE WHEN t IN ('device_calibration','device_recall') THEN 2 ELSE 3 END) THEN
    RAISE EXCEPTION '0073 missing table grant: %',t;
  END IF;
END LOOP;
IF EXISTS (SELECT FROM pg_namespace n, LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
    WHERE n.nspname='labs' AND a.grantee<>n.nspowner AND
    (NOT hardened OR a.grantee<>role_id OR a.is_grantable OR a.privilege_type<>'USAGE' OR a.grantor<>n.nspowner))
 OR (hardened AND NOT has_schema_privilege(role_id,'labs','USAGE')) THEN
  RAISE EXCEPTION '0073 unexpected schema ACL';
END IF;

IF hardened THEN
  IF EXISTS (SELECT FROM labs.critical_closure WHERE phase='superseded' OR superseded_at IS NOT NULL
      OR superseded_by IS NOT NULL OR superseded_reason IS NOT NULL) THEN
    RAISE EXCEPTION '0073 rollback refuses supersession audit';
  END IF;
ALTER TABLE pg_temp.critical_closure
  DROP CONSTRAINT critical_closure_superseded_only_when_superseded,
  DROP CONSTRAINT critical_closure_phase_check, DROP CONSTRAINT critical_closure_steps,
  DROP COLUMN superseded_at, DROP COLUMN superseded_by, DROP COLUMN superseded_reason,
  ADD CONSTRAINT critical_closure_phase_check CHECK (phase IN ('paged','acknowledged','contacted','closed')),
  ADD CONSTRAINT critical_closure_steps CHECK (
    (phase = 'paged' AND acknowledged_at IS NULL AND contacted_at IS NULL AND closed_at IS NULL) OR
    (phase = 'acknowledged' AND acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL AND contacted_at IS NULL AND closed_at IS NULL) OR
    (phase = 'contacted' AND acknowledged_at IS NOT NULL AND contacted_at IS NOT NULL AND contact_evidence IS NOT NULL AND closed_at IS NULL) OR
    (phase = 'closed' AND acknowledged_at IS NOT NULL AND contacted_at IS NOT NULL AND contact_evidence IS NOT NULL AND closed_at IS NOT NULL AND closed_by IS NOT NULL));
ALTER TABLE pg_temp.lab_result DROP CONSTRAINT lab_result_manual_read_back,
  DROP CONSTRAINT lab_result_provisional_shape,
  ADD CONSTRAINT lab_result_manual_read_back CHECK (source <> 'manual' OR
    (provisional AND read_back_by IS NOT NULL AND read_back_at IS NOT NULL AND read_back_value = value_text)),
  ADD CONSTRAINT lab_result_provisional_shape CHECK (
    (source = 'manual' AND provisional) OR
    (source IN ('electronic','device') AND provisional = (reconciliation = 'conflict')));
-- Check every stored row and FK without altering clinical data. The intersection
-- omits only the three preflighted nullable audit columns added/removed by 0073.
FOR t IN SELECT unnest(ARRAY['lab_order','lab_result','critical_closure','expected_result_age','device_calibration','device_recall']) LOOP
  SELECT string_agg(quote_ident(a.attname),',' ORDER BY a.attnum) INTO cols
    FROM pg_attribute a JOIN pg_attribute b ON b.attname=a.attname
    WHERE a.attrelid=to_regclass('pg_temp.'||t) AND b.attrelid=to_regclass('labs.'||t)
      AND a.attnum>0 AND b.attnum>0 AND NOT a.attisdropped AND NOT b.attisdropped;
  EXECUTE format('INSERT INTO pg_temp.%I (%s) SELECT %s FROM labs.%I',t,cols,cols,t);
END LOOP;
ALTER TABLE labs.critical_closure
  DROP CONSTRAINT critical_closure_superseded_only_when_superseded,
  DROP CONSTRAINT critical_closure_phase_check, DROP CONSTRAINT critical_closure_steps,
  DROP COLUMN superseded_at, DROP COLUMN superseded_by, DROP COLUMN superseded_reason,
  ADD CONSTRAINT critical_closure_phase_check CHECK (phase IN ('paged','acknowledged','contacted','closed')),
  ADD CONSTRAINT critical_closure_steps CHECK (
    (phase = 'paged' AND acknowledged_at IS NULL AND contacted_at IS NULL AND closed_at IS NULL) OR
    (phase = 'acknowledged' AND acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL AND contacted_at IS NULL AND closed_at IS NULL) OR
    (phase = 'contacted' AND acknowledged_at IS NOT NULL AND contacted_at IS NOT NULL AND contact_evidence IS NOT NULL AND closed_at IS NULL) OR
    (phase = 'closed' AND acknowledged_at IS NOT NULL AND contacted_at IS NOT NULL AND contact_evidence IS NOT NULL AND closed_at IS NOT NULL AND closed_by IS NOT NULL));
ALTER TABLE labs.lab_result DROP CONSTRAINT lab_result_manual_read_back,
  DROP CONSTRAINT lab_result_provisional_shape,
  ADD CONSTRAINT lab_result_manual_read_back CHECK (source <> 'manual' OR
    (provisional AND read_back_by IS NOT NULL AND read_back_at IS NOT NULL AND read_back_value = value_text)),
  ADD CONSTRAINT lab_result_provisional_shape CHECK (
    (source = 'manual' AND provisional) OR
    (source IN ('electronic','device') AND provisional = (reconciliation = 'conflict')));
REVOKE SELECT,INSERT,UPDATE ON labs.lab_order,labs.lab_result,labs.critical_closure,labs.expected_result_age FROM module_labs;
REVOKE SELECT,INSERT ON labs.device_calibration,labs.device_recall FROM module_labs;
REVOKE USAGE ON SCHEMA labs FROM module_labs;
REVOKE module_labs FROM practicehub_app;
DROP ROLE module_labs;
role_id := NULL;

hardened := false;
ELSE

-- Check every stored row and FK without altering clinical data. The intersection
-- omits only the three preflighted nullable audit columns added/removed by 0073.
FOR t IN SELECT unnest(ARRAY['lab_order','lab_result','critical_closure','expected_result_age','device_calibration','device_recall']) LOOP
  SELECT string_agg(quote_ident(a.attname),',' ORDER BY a.attnum) INTO cols
    FROM pg_attribute a JOIN pg_attribute b ON b.attname=a.attname
    WHERE a.attrelid=to_regclass('pg_temp.'||t) AND b.attrelid=to_regclass('labs.'||t)
      AND a.attnum>0 AND b.attnum>0 AND NOT a.attisdropped AND NOT b.attisdropped;
  EXECUTE format('INSERT INTO pg_temp.%I (%s) SELECT %s FROM labs.%I',t,cols,cols,t);
END LOOP;
END IF;

IF hardened THEN
  IF role_id IS NULL OR shobj_description(role_id,'pg_authid') IS DISTINCT FROM origin
    OR NOT EXISTS (SELECT FROM pg_roles WHERE oid=role_id AND NOT rolcanlogin AND NOT rolsuper
      AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
      AND rolinherit AND rolconnlimit=-1 AND rolvaliduntil IS NULL AND rolconfig IS NULL)
    OR (SELECT count(*) FROM pg_auth_members WHERE roleid=role_id OR member=role_id) <> 1
    OR NOT EXISTS (SELECT FROM pg_auth_members m WHERE roleid=role_id AND member=app_id AND NOT admin_option
      -- PostgreSQL records superuser membership grants as bootstrap-superuser OID 10.
      AND grantor=(SELECT oid FROM pg_roles WHERE oid=10 AND rolsuper)
      AND coalesce((to_jsonb(m)->>'inherit_option')::boolean,true)
      AND coalesce((to_jsonb(m)->>'set_option')::boolean,true))
    OR EXISTS (SELECT FROM pg_db_role_setting WHERE setrole=role_id)
    OR EXISTS (SELECT FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=role_id
      AND NOT (dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND deptype='a'
        AND ((classid='pg_namespace'::regclass AND objid='labs'::regnamespace)
          OR (classid='pg_class'::regclass AND objid IN (SELECT oid FROM pg_class WHERE relnamespace='labs'::regnamespace AND relkind='r'))))) THEN
    RAISE EXCEPTION '0073 unknown role origin/attributes/membership/external dependency';
  END IF;
ELSIF role_id IS NOT NULL THEN
  RAISE EXCEPTION '0073 refuses preexisting module_labs role';
END IF;

-- Compare both directions, including all columns, validated CHECKs, keys, FKs,
-- index shape, triggers, policy expressions, ACLs and ownership. Extra objects fail closed.
FOR t IN SELECT unnest(ARRAY['lab_order','lab_result','critical_closure','expected_result_age','device_calibration','device_recall']) LOOP
  actual := to_regclass('labs.' || t); expected := to_regclass('pg_temp.' || t);
  IF actual IS NULL OR NOT EXISTS (SELECT FROM pg_class WHERE oid=actual AND relkind='r'
      AND relpersistence='p' AND relrowsecurity AND relforcerowsecurity
      AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
      AND relam=(SELECT relam FROM pg_class WHERE oid=expected)
      AND relreplident='d' AND reloptions IS NULL AND NOT relispartition) THEN
    RAISE EXCEPTION '0073 unexpected table/RLS/owner: %', t;
  END IF;
  IF EXISTS (
    WITH a AS (SELECT attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated,attcollation,
      pg_get_expr(d.adbin,d.adrelid) AS def FROM pg_attribute x
      LEFT JOIN pg_attrdef d ON d.adrelid=x.attrelid AND d.adnum=x.attnum
      WHERE attrelid=actual AND attnum>0 AND NOT attisdropped),
    b AS (SELECT attname,atttypid,atttypmod,attnotnull,attidentity,attgenerated,attcollation,
      pg_get_expr(d.adbin,d.adrelid) AS def FROM pg_attribute x
      LEFT JOIN pg_attrdef d ON d.adrelid=x.attrelid AND d.adnum=x.attnum
      WHERE attrelid=expected AND attnum>0 AND NOT attisdropped)
    (SELECT * FROM a EXCEPT SELECT * FROM b) UNION ALL (SELECT * FROM b EXCEPT SELECT * FROM a)
  ) THEN RAISE EXCEPTION '0073 unknown/partial column schema: %',t; END IF;
  IF EXISTS (
    -- Non-FK definitions (especially CHECK literals) are compared verbatim.
    -- FK relation names are catalog identifiers, never text replacements in SQL.
    -- Namespace identity, ordered key names, actions and equality operators all match.
    -- Resolve attnums to names: rollback/reapply leaves dropped audit-column slots.
    WITH a AS (SELECT conname,contype,convalidated,condeferrable,condeferred,
      connoinherit,conislocal,coninhcount,
      ARRAY(SELECT attname FROM unnest(conkey) WITH ORDINALITY k(num,pos)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.pos) AS keys,
      ARRAY(SELECT attname FROM unnest(confkey) WITH ORDINALITY k(num,pos)
        JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.pos) AS referenced_keys,
      ARRAY(SELECT attname FROM unnest(confdelsetcols) WITH ORDINALITY k(num,pos)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.pos) AS delete_set_keys,
      confupdtype,confdeltype,confmatchtype,conpfeqop,conppeqop,conffeqop,
      r.relname AS referenced_table, r.relnamespace='labs'::regnamespace AS local_reference,
      CASE WHEN contype<>'f' THEN pg_get_constraintdef(c.oid) END AS def
      FROM pg_constraint c LEFT JOIN pg_class r ON r.oid=c.confrelid WHERE conrelid=actual),
    b AS (SELECT conname,contype,convalidated,condeferrable,condeferred,
      connoinherit,conislocal,coninhcount,
      ARRAY(SELECT attname FROM unnest(conkey) WITH ORDINALITY k(num,pos)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.pos) AS keys,
      ARRAY(SELECT attname FROM unnest(confkey) WITH ORDINALITY k(num,pos)
        JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.num ORDER BY k.pos) AS referenced_keys,
      ARRAY(SELECT attname FROM unnest(confdelsetcols) WITH ORDINALITY k(num,pos)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.num ORDER BY k.pos) AS delete_set_keys,
      confupdtype,confdeltype,confmatchtype,conpfeqop,conppeqop,conffeqop,
      r.relname AS referenced_table, r.relnamespace=pg_my_temp_schema() AS local_reference,
      CASE WHEN contype<>'f' THEN pg_get_constraintdef(c.oid) END AS def
      FROM pg_constraint c LEFT JOIN pg_class r ON r.oid=c.confrelid WHERE conrelid=expected)
    (SELECT * FROM a EXCEPT SELECT * FROM b) UNION ALL (SELECT * FROM b EXCEPT SELECT * FROM a)
  ) THEN RAISE EXCEPTION '0073 unknown constraint schema: %',t; END IF;
  IF EXISTS (SELECT FROM pg_constraint c JOIN pg_class r ON r.oid=c.confrelid
      WHERE c.conrelid=actual AND r.relnamespace <> 'labs'::regnamespace)
    OR EXISTS (SELECT FROM pg_trigger WHERE tgrelid=actual AND (NOT tgisinternal OR tgenabled<>'O'))
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid=actual) <>
       (SELECT count(*) FROM pg_trigger WHERE tgrelid=expected)
    OR EXISTS (SELECT FROM pg_inherits WHERE inhrelid=actual OR inhparent=actual)
    OR EXISTS (SELECT FROM pg_rewrite WHERE ev_class=actual) THEN
    RAISE EXCEPTION '0073 unexpected dependency/trigger/rule: %',t;
  END IF;
  IF EXISTS (
    WITH a AS (SELECT indnatts,indnkeyatts,indisunique,indnullsnotdistinct,indisprimary,indisexclusion,
      indimmediate,indisvalid,indisready,indislive,indkey,indcollation,indclass,indoption,
      indexprs::text,indpred::text,c.relam FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE indrelid=actual),
    b AS (SELECT indnatts,indnkeyatts,indisunique,indnullsnotdistinct,indisprimary,indisexclusion,
      indimmediate,indisvalid,indisready,indislive,indkey,indcollation,indclass,indoption,
      indexprs::text,indpred::text,c.relam FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE indrelid=expected)
    (SELECT * FROM a EXCEPT ALL SELECT * FROM b) UNION ALL (SELECT * FROM b EXCEPT ALL SELECT * FROM a)
  ) THEN
    RAISE EXCEPTION '0073 unexpected index schema: %',t;
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid=actual) <> 1 OR NOT EXISTS (
    SELECT FROM pg_policy WHERE polrelid=actual AND polname='tenant_isolation'
      AND polcmd='*' AND polpermissive AND polroles=ARRAY[0::oid]
      AND pg_get_expr(polqual,polrelid) = '(tenant_id = current_setting(''practicehub.tenant_id''::text, true))'
      AND pg_get_expr(polwithcheck,polrelid) = '(tenant_id = current_setting(''practicehub.tenant_id''::text, true))'
  ) THEN RAISE EXCEPTION '0073 unexpected tenant policy: %',t; END IF;
  IF EXISTS (SELECT FROM pg_attribute WHERE attrelid=actual AND attacl IS NOT NULL) THEN
    RAISE EXCEPTION '0073 unexpected column ACL: %',t;
  END IF;
  IF EXISTS (SELECT FROM pg_class c, LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      WHERE c.oid=actual AND a.grantee<>c.relowner AND
        (NOT hardened OR a.grantee<>role_id OR a.is_grantable OR a.grantor<>c.relowner OR
         a.privilege_type NOT IN ('SELECT','INSERT',CASE WHEN t IN ('device_calibration','device_recall') THEN 'SELECT' ELSE 'UPDATE' END))) THEN
    RAISE EXCEPTION '0073 unexpected table ACL: %',t;
  END IF;
  IF hardened AND (SELECT count(*) FROM pg_class c, LATERAL aclexplode(c.relacl) a
      WHERE c.oid=actual AND a.grantee=role_id) <>
      (CASE WHEN t IN ('device_calibration','device_recall') THEN 2 ELSE 3 END) THEN
    RAISE EXCEPTION '0073 missing table grant: %',t;
  END IF;
END LOOP;
IF EXISTS (SELECT FROM pg_namespace n, LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
    WHERE n.nspname='labs' AND a.grantee<>n.nspowner AND
    (NOT hardened OR a.grantee<>role_id OR a.is_grantable OR a.privilege_type<>'USAGE' OR a.grantor<>n.nspowner))
 OR (hardened AND NOT has_schema_privilege(role_id,'labs','USAGE')) THEN
  RAISE EXCEPTION '0073 unexpected schema ACL';
END IF;
DROP TABLE pg_temp.device_recall;
DROP TABLE pg_temp.device_calibration;
DROP TABLE pg_temp.expected_result_age;
DROP TABLE pg_temp.critical_closure;
DROP TABLE pg_temp.lab_result;
DROP TABLE pg_temp.lab_order;
END
$labs73$;
