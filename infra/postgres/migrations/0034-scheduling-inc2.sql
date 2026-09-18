-- WP-040 increment 2. Re-runnable. Does not recreate 0032 objects (NR-075).
-- Grants module_scheduling UPDATE on resource_reservation so
-- sched.lock_reservation_subjects FOR UPDATE can run as the app role (NR-074).

GRANT UPDATE ON TABLE sched.resource_reservation TO module_scheduling;

CREATE TABLE IF NOT EXISTS sched.inc2_resource_catalog (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  catalog_id text NOT NULL,
  location_id text NOT NULL,
  resource_id text NOT NULL,
  resource_kind text NOT NULL CHECK (resource_kind IN (
    'provider','room','equipment','staff','interpreter','partner','transport','preparation'
  )),
  setup_minutes integer NOT NULL CHECK (setup_minutes >= 0),
  cleanup_minutes integer NOT NULL CHECK (cleanup_minutes >= 0),
  out_of_service boolean NOT NULL,
  nearest_alternate_location_id text,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, catalog_id)
);

CREATE TABLE IF NOT EXISTS sched.inc2_waitlist_pause (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  waitlist_entry_id text NOT NULL,
  reason text NOT NULL,
  owner_ref text NOT NULL,
  original_priority integer NOT NULL CHECK (original_priority > 0),
  reevaluation_deadline timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('paused','restored','closed')),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, waitlist_entry_id)
);

CREATE TABLE IF NOT EXISTS sched.inc2_manager_exception (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  exception_id text NOT NULL,
  rationale text NOT NULL,
  scope text NOT NULL,
  exception_range tstzrange NOT NULL,
  impacted_resource_ids text[] NOT NULL,
  approved_by text NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, exception_id),
  CHECK (NOT isempty(exception_range) AND NOT lower_inf(exception_range)
    AND NOT upper_inf(exception_range) AND lower_inc(exception_range)
    AND NOT upper_inc(exception_range) AND isfinite(lower(exception_range))
    AND isfinite(upper(exception_range)))
);

DO $rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'inc2_resource_catalog','inc2_waitlist_pause','inc2_manager_exception'
  ] LOOP
    EXECUTE format('ALTER TABLE sched.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE sched.%I FORCE ROW LEVEL SECURITY', table_name);
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'sched' AND tablename = table_name AND policyname = 'tenant_isolation'
    ) THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON sched.%I USING (tenant_id = current_setting(''practicehub.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''practicehub.tenant_id'', true))',
        table_name
      );
    END IF;
  END LOOP;
END
$rls$;

GRANT SELECT ON sched.inc2_resource_catalog, sched.inc2_waitlist_pause, sched.inc2_manager_exception
  TO module_scheduling;

DO $coverage$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO offender
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'sched' AND c.relkind = 'r'
     AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema sched: %', offender;
  END IF;
END
$coverage$;
