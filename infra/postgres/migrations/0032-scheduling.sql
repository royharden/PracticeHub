-- WP-040 scheduling core. Reservations are structurally exclusive across
-- locations for patients/providers and across all uses for exclusive resources.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS sched;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_scheduling') THEN
    CREATE ROLE module_scheduling NOLOGIN;
  END IF;
END
$roles$;
GRANT module_scheduling TO practicehub_app;
GRANT USAGE ON SCHEMA sched TO module_scheduling;

CREATE TABLE sched.constraint_bundle (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  constraint_bundle_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  constraints jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, constraint_bundle_id, version)
);

CREATE TABLE sched.resource (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  resource_id text NOT NULL,
  resource_type text NOT NULL CHECK (resource_type IN ('provider','room','device','staff','other')),
  source_version bigint NOT NULL CHECK (source_version >= 0),
  active boolean NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, resource_id)
);

CREATE TABLE sched.policy_snapshot (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  policy_snapshot_id text NOT NULL,
  policy_version text NOT NULL,
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  accepting_new_patients boolean NOT NULL,
  payload jsonb NOT NULL,
  captured_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, policy_snapshot_id)
);

CREATE TABLE sched.command_effect (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  idempotency_key text NOT NULL,
  operation text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  effect_identity text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','complete','indeterminate','reconciled')),
  authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
  source_version bigint NOT NULL CHECK (source_version >= 0),
  receipt_id text,
  result jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key),
  UNIQUE (tenant_id, effect_identity),
  CHECK ((state = 'complete') = (receipt_id IS NOT NULL AND result IS NOT NULL))
);

CREATE TABLE sched.command_effect_scope (
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('provider','patient','resource')),
  subject_id text NOT NULL,
  effect_range tstzrange NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','indeterminate','closed')),
  PRIMARY KEY (tenant_id, idempotency_key, subject_kind, subject_id),
  FOREIGN KEY (tenant_id, idempotency_key)
    REFERENCES sched.command_effect (tenant_id, idempotency_key) ON DELETE CASCADE,
  CHECK (NOT isempty(effect_range) AND NOT lower_inf(effect_range) AND NOT upper_inf(effect_range)
    AND isfinite(lower(effect_range)) AND isfinite(upper(effect_range))
    AND lower_inc(effect_range) AND NOT upper_inc(effect_range)),
  EXCLUDE USING gist (
    tenant_id WITH =,
    subject_kind WITH =,
    subject_id WITH =,
    effect_range WITH &&
  ) WHERE (state IN ('pending','indeterminate'))
);

CREATE TABLE sched.slot_offer (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  slot_offer_id text NOT NULL,
  location_id text NOT NULL,
  provider_id text NOT NULL,
  service_id text NOT NULL,
  required_resource_ids text[] NOT NULL CHECK (cardinality(required_resource_ids) > 0),
  slot_range tstzrange NOT NULL,
  constraint_bundle_id text NOT NULL,
  constraint_bundle_version integer NOT NULL,
  policy_snapshot_id text NOT NULL,
  source_version bigint NOT NULL CHECK (source_version >= 0),
  adapter_id text NOT NULL,
  adapter_mode text NOT NULL CHECK (adapter_mode IN ('synthetic','real')),
  expires_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, slot_offer_id),
  FOREIGN KEY (tenant_id, constraint_bundle_id, constraint_bundle_version)
    REFERENCES sched.constraint_bundle (tenant_id, constraint_bundle_id, version),
  FOREIGN KEY (tenant_id, policy_snapshot_id)
    REFERENCES sched.policy_snapshot (tenant_id, policy_snapshot_id),
  CHECK (NOT isempty(slot_range) AND NOT lower_inf(slot_range) AND NOT upper_inf(slot_range)
    AND isfinite(lower(slot_range)) AND isfinite(upper(slot_range))
    AND lower_inc(slot_range) AND NOT upper_inc(slot_range))
);

CREATE TABLE sched.slot_hold (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  hold_id text NOT NULL,
  slot_offer_id text NOT NULL,
  patient_id text NOT NULL,
  idempotency_key text NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  state text NOT NULL CHECK (state IN ('live','converted','released','expired','indeterminate')),
  authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
  source_version bigint NOT NULL CHECK (source_version >= 0),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, hold_id),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, slot_offer_id)
    REFERENCES sched.slot_offer (tenant_id, slot_offer_id)
);

CREATE TABLE sched.appointment (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  appointment_id text NOT NULL,
  patient_id text NOT NULL,
  location_id text NOT NULL,
  provider_id text NOT NULL,
  service_id text NOT NULL,
  resource_ids text[] NOT NULL CHECK (cardinality(resource_ids) > 0),
  appointment_range tstzrange NOT NULL,
  state text NOT NULL CHECK (state IN ('booked','cancelled','superseded')),
  version bigint NOT NULL CHECK (version > 0),
  authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
  source_version bigint NOT NULL CHECK (source_version >= 0),
  predecessor_appointment_id text,
  created_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, appointment_id),
  FOREIGN KEY (tenant_id, predecessor_appointment_id)
    REFERENCES sched.appointment (tenant_id, appointment_id),
  CHECK (NOT isempty(appointment_range) AND NOT lower_inf(appointment_range)
    AND NOT upper_inf(appointment_range) AND lower_inc(appointment_range)
    AND NOT upper_inc(appointment_range) AND isfinite(lower(appointment_range))
    AND isfinite(upper(appointment_range)))
);

CREATE TABLE sched.resource_reservation (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  reservation_id text NOT NULL,
  subject_kind text NOT NULL CHECK (subject_kind IN ('provider','patient','resource')),
  subject_id text NOT NULL,
  reservation_range tstzrange NOT NULL,
  state text NOT NULL CHECK (state IN ('held','booked','released','expired','cancelled')),
  hold_id text,
  appointment_id text,
  created_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, reservation_id),
  FOREIGN KEY (tenant_id, hold_id) REFERENCES sched.slot_hold (tenant_id, hold_id),
  FOREIGN KEY (tenant_id, appointment_id)
    REFERENCES sched.appointment (tenant_id, appointment_id),
  CHECK ((hold_id IS NOT NULL)::integer + (appointment_id IS NOT NULL)::integer = 1),
  CHECK (NOT isempty(reservation_range) AND NOT lower_inf(reservation_range)
    AND NOT upper_inf(reservation_range) AND lower_inc(reservation_range)
    AND NOT upper_inc(reservation_range) AND isfinite(lower(reservation_range))
    AND isfinite(upper(reservation_range))),
  EXCLUDE USING gist (
    tenant_id WITH =,
    subject_kind WITH =,
    subject_id WITH =,
    reservation_range WITH &&
  ) WHERE (state IN ('held','booked'))
);

CREATE INDEX resource_reservation_lock_order
  ON sched.resource_reservation (tenant_id, subject_kind, subject_id, reservation_id);

-- Call before inserting or converting reservations. Advisory locks cover absent
-- rows; existing rows are then locked in the same stable identity order.
CREATE OR REPLACE FUNCTION sched.lock_reservation_subjects(
  requested_tenant_id text,
  requested_subjects jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $lock$
DECLARE
  subject record;
BEGIN
  IF jsonb_typeof(requested_subjects) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'reservation_subjects_must_be_array';
  END IF;
  FOR subject IN
    SELECT value->>'kind' AS kind, value->>'id' AS id
      FROM jsonb_array_elements(requested_subjects)
     ORDER BY value->>'kind', value->>'id'
  LOOP
    IF subject.kind NOT IN ('provider','patient','resource') OR subject.id IS NULL THEN
      RAISE EXCEPTION 'invalid_reservation_subject';
    END IF;
    PERFORM pg_advisory_xact_lock(
      hashtextextended(requested_tenant_id || '|' || subject.kind || '|' || subject.id, 0)
    );
    PERFORM 1 FROM sched.resource_reservation
     WHERE tenant_id = requested_tenant_id
       AND subject_kind = subject.kind AND subject_id = subject.id
     ORDER BY reservation_id FOR UPDATE;
  END LOOP;
END
$lock$;

CREATE OR REPLACE FUNCTION sched.validate_reservation_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER AS $binding$
DECLARE
  expected_patient text;
  expected_provider text;
  expected_resources text[];
  expected_range tstzrange;
  expected_state text;
BEGIN
  IF NEW.hold_id IS NOT NULL THEN
    SELECT h.patient_id, o.provider_id, o.required_resource_ids, o.slot_range,
           CASE h.state WHEN 'live' THEN 'held' WHEN 'indeterminate' THEN 'held'
             WHEN 'converted' THEN 'booked'
             WHEN 'released' THEN 'released' ELSE 'expired' END
      INTO expected_patient, expected_provider, expected_resources, expected_range, expected_state
      FROM sched.slot_hold h JOIN sched.slot_offer o
        ON o.tenant_id=h.tenant_id AND o.slot_offer_id=h.slot_offer_id
     WHERE h.tenant_id=NEW.tenant_id AND h.hold_id=NEW.hold_id;
  ELSE
    SELECT a.patient_id, a.provider_id, a.resource_ids, a.appointment_range,
           CASE a.state WHEN 'booked' THEN 'booked' ELSE 'cancelled' END
      INTO expected_patient, expected_provider, expected_resources, expected_range, expected_state
      FROM sched.appointment a
     WHERE a.tenant_id=NEW.tenant_id AND a.appointment_id=NEW.appointment_id;
  END IF;
  IF NOT FOUND OR NEW.reservation_range IS DISTINCT FROM expected_range
     OR NEW.state IS DISTINCT FROM expected_state
     OR (NEW.subject_kind='patient' AND NEW.subject_id IS DISTINCT FROM expected_patient)
     OR (NEW.subject_kind='provider' AND NEW.subject_id IS DISTINCT FROM expected_provider)
     OR (NEW.subject_kind='resource' AND NOT NEW.subject_id=ANY(expected_resources)) THEN
    RAISE EXCEPTION 'reservation_parent_binding_mismatch';
  END IF;
  RETURN NEW;
END
$binding$;

CREATE TRIGGER reservation_parent_binding
BEFORE INSERT OR UPDATE ON sched.resource_reservation
FOR EACH ROW EXECUTE FUNCTION sched.validate_reservation_binding();

CREATE OR REPLACE FUNCTION sched.assert_reservation_completeness(
  requested_tenant_id text,
  requested_hold_id text,
  requested_appointment_id text
) RETURNS void
LANGUAGE plpgsql SECURITY INVOKER AS $complete$
DECLARE
  expected_count integer;
  actual_count integer;
  parent_state text;
BEGIN
  IF requested_hold_id IS NOT NULL THEN
    SELECT 2 + cardinality(o.required_resource_ids), h.state
      INTO expected_count, parent_state
      FROM sched.slot_hold h JOIN sched.slot_offer o
        ON o.tenant_id=h.tenant_id AND o.slot_offer_id=h.slot_offer_id
     WHERE h.tenant_id=requested_tenant_id AND h.hold_id=requested_hold_id;
    IF NOT FOUND THEN RETURN; END IF;
    IF parent_state = 'converted' THEN
      expected_count := 0;
      SELECT count(*) INTO actual_count FROM sched.resource_reservation
       WHERE tenant_id=requested_tenant_id AND hold_id=requested_hold_id;
    ELSE
      SELECT count(*) INTO actual_count FROM sched.resource_reservation
       WHERE tenant_id=requested_tenant_id AND hold_id=requested_hold_id
         AND state = CASE parent_state WHEN 'live' THEN 'held' WHEN 'indeterminate' THEN 'held'
           WHEN 'released' THEN 'released' ELSE 'expired' END;
    END IF;
  ELSE
    SELECT 2 + cardinality(a.resource_ids), a.state
      INTO expected_count, parent_state FROM sched.appointment a
     WHERE a.tenant_id=requested_tenant_id AND a.appointment_id=requested_appointment_id;
    IF NOT FOUND THEN RETURN; END IF;
    SELECT count(*) INTO actual_count FROM sched.resource_reservation
     WHERE tenant_id=requested_tenant_id AND appointment_id=requested_appointment_id
       AND state = CASE parent_state WHEN 'booked' THEN 'booked' ELSE 'cancelled' END;
  END IF;
  IF actual_count IS DISTINCT FROM expected_count THEN
    RAISE EXCEPTION 'reservation_set_incomplete expected %, observed %', expected_count, actual_count;
  END IF;
END
$complete$;

CREATE OR REPLACE FUNCTION sched.check_reservation_completeness() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER AS $check$
BEGIN
  IF TG_TABLE_NAME='slot_hold' THEN
    PERFORM sched.assert_reservation_completeness(NEW.tenant_id, NEW.hold_id, NULL);
  ELSIF TG_TABLE_NAME='appointment' THEN
    PERFORM sched.assert_reservation_completeness(NEW.tenant_id, NULL, NEW.appointment_id);
  ELSE
    IF TG_OP <> 'INSERT' THEN
      PERFORM sched.assert_reservation_completeness(OLD.tenant_id, OLD.hold_id, OLD.appointment_id);
    END IF;
    IF TG_OP <> 'DELETE' THEN
      PERFORM sched.assert_reservation_completeness(NEW.tenant_id, NEW.hold_id, NEW.appointment_id);
    END IF;
  END IF;
  RETURN NULL;
END
$check$;

CREATE CONSTRAINT TRIGGER slot_hold_reservation_completeness
AFTER INSERT OR UPDATE ON sched.slot_hold DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION sched.check_reservation_completeness();
CREATE CONSTRAINT TRIGGER appointment_reservation_completeness
AFTER INSERT OR UPDATE ON sched.appointment DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION sched.check_reservation_completeness();
CREATE CONSTRAINT TRIGGER reservation_set_completeness
AFTER INSERT OR UPDATE OR DELETE ON sched.resource_reservation DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION sched.check_reservation_completeness();

CREATE TABLE sched.booking_receipt (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  receipt_id text NOT NULL,
  effect_identity text NOT NULL,
  hold_id text,
  appointment_id text,
  adapter_id text NOT NULL,
  adapter_mode text NOT NULL CHECK (adapter_mode IN ('synthetic','real')),
  authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
  source_version bigint NOT NULL CHECK (source_version >= 0),
  receipt_hash text NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, receipt_id),
  UNIQUE (tenant_id, effect_identity),
  FOREIGN KEY (tenant_id, hold_id) REFERENCES sched.slot_hold (tenant_id, hold_id),
  FOREIGN KEY (tenant_id, appointment_id)
    REFERENCES sched.appointment (tenant_id, appointment_id)
);

CREATE TABLE sched.waitlist_entry (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  waitlist_entry_id text NOT NULL,
  patient_id text NOT NULL,
  requested_range tstzrange NOT NULL,
  constraints jsonb NOT NULL,
  original_appointment_id text,
  state text NOT NULL CHECK (state IN ('waiting','offered','fulfilled','withdrawn')),
  created_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, waitlist_entry_id),
  FOREIGN KEY (tenant_id, original_appointment_id)
    REFERENCES sched.appointment (tenant_id, appointment_id),
  CHECK (NOT isempty(requested_range) AND NOT lower_inf(requested_range)
    AND NOT upper_inf(requested_range) AND lower_inc(requested_range)
    AND NOT upper_inc(requested_range) AND isfinite(lower(requested_range))
    AND isfinite(upper(requested_range)))
);

CREATE TABLE sched.waitlist_offer (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  waitlist_offer_id text NOT NULL,
  waitlist_entry_id text NOT NULL,
  slot_offer_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('open','accepted','expired','declined')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, waitlist_offer_id),
  FOREIGN KEY (tenant_id, waitlist_entry_id)
    REFERENCES sched.waitlist_entry (tenant_id, waitlist_entry_id),
  FOREIGN KEY (tenant_id, slot_offer_id)
    REFERENCES sched.slot_offer (tenant_id, slot_offer_id)
);

CREATE TABLE sched.reconciliation_case (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  reconciliation_case_id text NOT NULL,
  effect_identity text NOT NULL,
  reason text NOT NULL,
  authority_epoch bigint NOT NULL CHECK (authority_epoch >= 0),
  observed_source_version bigint NOT NULL CHECK (observed_source_version >= 0),
  expected_source_version bigint NOT NULL CHECK (expected_source_version >= 0),
  state text NOT NULL CHECK (state IN ('open','resolved','quarantined')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, reconciliation_case_id)
);

CREATE TABLE sched.outbox (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  outbox_id text NOT NULL,
  effect_identity text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','published','failed')),
  created_at timestamptz NOT NULL,
  published_at timestamptz,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, outbox_id),
  UNIQUE (tenant_id, effect_identity, event_type)
);

-- Hold expiry and the release of structural reservations are one transaction.
CREATE OR REPLACE FUNCTION sched.expire_hold(
  requested_tenant_id text,
  requested_hold_id text,
  observed_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,sched AS $expire$
DECLARE
  changed integer;
BEGIN
  IF requested_tenant_id IS DISTINCT FROM current_setting('practicehub.tenant_id', true) THEN
    RAISE EXCEPTION 'hold_tenant_scope_mismatch';
  END IF;
  PERFORM 1 FROM sched.slot_hold
   WHERE tenant_id = requested_tenant_id AND hold_id = requested_hold_id
   ORDER BY tenant_id, hold_id FOR UPDATE;
  UPDATE sched.slot_hold
     SET state = 'expired'
   WHERE tenant_id = requested_tenant_id AND hold_id = requested_hold_id
     AND state = 'live' AND expires_at <= observed_at;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed = 1 THEN
    UPDATE sched.resource_reservation SET state = 'expired'
     WHERE tenant_id = requested_tenant_id AND hold_id = requested_hold_id
       AND state = 'held';
  END IF;
  RETURN changed = 1;
END
$expire$;

CREATE OR REPLACE FUNCTION sched.begin_effect(
  requested_tenant_id text,
  requested_idempotency_key text,
  requested_operation text,
  requested_input_hash text,
  requested_effect_identity text,
  requested_authority_epoch bigint,
  requested_source_version bigint,
  requested_synthetic boolean,
  requested_provider_id text,
  requested_patient_id text,
  requested_resource_ids text[],
  requested_effect_range tstzrange
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,sched AS $effect$
DECLARE
  existing sched.command_effect%ROWTYPE;
  created_count integer;
BEGIN
  IF requested_tenant_id IS DISTINCT FROM current_setting('practicehub.tenant_id', true) THEN
    RAISE EXCEPTION 'effect_tenant_scope_mismatch';
  END IF;
  IF requested_provider_id = '' OR requested_patient_id = ''
     OR cardinality(requested_resource_ids) = 0
     OR cardinality(requested_resource_ids) IS DISTINCT FROM
       (SELECT count(DISTINCT resource_id) FROM unnest(requested_resource_ids) resource_id)
     OR isempty(requested_effect_range) OR lower_inf(requested_effect_range)
     OR upper_inf(requested_effect_range) OR NOT isfinite(lower(requested_effect_range))
     OR NOT isfinite(upper(requested_effect_range)) OR NOT lower_inc(requested_effect_range)
     OR upper_inc(requested_effect_range) THEN
    RAISE EXCEPTION 'invalid_effect_scope';
  END IF;
  INSERT INTO sched.command_effect
    (tenant_id,idempotency_key,operation,input_hash,effect_identity,state,
     authority_epoch,source_version,created_at,updated_at,synthetic)
  VALUES
    (requested_tenant_id,requested_idempotency_key,requested_operation,
     requested_input_hash,requested_effect_identity,'pending',
     requested_authority_epoch,requested_source_version,clock_timestamp(),
     clock_timestamp(),requested_synthetic)
  ON CONFLICT (tenant_id,idempotency_key) DO NOTHING;
  GET DIAGNOSTICS created_count = ROW_COUNT;
  SELECT * INTO existing FROM sched.command_effect
   WHERE tenant_id=requested_tenant_id AND idempotency_key=requested_idempotency_key
   FOR UPDATE;
  IF existing.input_hash IS DISTINCT FROM requested_input_hash
     OR existing.effect_identity IS DISTINCT FROM requested_effect_identity
     OR existing.operation IS DISTINCT FROM requested_operation THEN
    RAISE EXCEPTION 'effect_idempotency_payload_drift';
  END IF;
  IF created_count = 1 THEN
    INSERT INTO sched.command_effect_scope
      (tenant_id,idempotency_key,subject_kind,subject_id,effect_range,state)
    SELECT requested_tenant_id, requested_idempotency_key, requested_scope.subject_kind,
           requested_scope.subject_id, requested_effect_range, 'pending'
      FROM (
        SELECT 'provider'::text AS subject_kind, requested_provider_id AS subject_id
        UNION ALL SELECT 'patient', requested_patient_id
        UNION ALL SELECT 'resource', resource_id FROM unnest(requested_resource_ids) resource_id
      ) requested_scope;
  ELSIF EXISTS (
    (SELECT subject_kind, subject_id, effect_range FROM sched.command_effect_scope
      WHERE tenant_id=requested_tenant_id AND idempotency_key=requested_idempotency_key)
    EXCEPT
    (SELECT requested_scope.subject_kind, requested_scope.subject_id, requested_effect_range
      FROM (
        SELECT 'provider'::text AS subject_kind, requested_provider_id AS subject_id
        UNION ALL SELECT 'patient', requested_patient_id
        UNION ALL SELECT 'resource', resource_id FROM unnest(requested_resource_ids) resource_id
      ) requested_scope)
  ) OR EXISTS (
    (SELECT requested_scope.subject_kind, requested_scope.subject_id, requested_effect_range
      FROM (
        SELECT 'provider'::text AS subject_kind, requested_provider_id AS subject_id
        UNION ALL SELECT 'patient', requested_patient_id
        UNION ALL SELECT 'resource', resource_id FROM unnest(requested_resource_ids) resource_id
      ) requested_scope)
    EXCEPT
    (SELECT subject_kind, subject_id, effect_range FROM sched.command_effect_scope
      WHERE tenant_id=requested_tenant_id AND idempotency_key=requested_idempotency_key)
  ) THEN
    RAISE EXCEPTION 'effect_scope_drift';
  END IF;
  RETURN existing.state;
END
$effect$;

CREATE OR REPLACE FUNCTION sched.mark_effect_indeterminate(
  requested_tenant_id text,
  requested_idempotency_key text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,sched AS $effect$
BEGIN
  IF requested_tenant_id IS DISTINCT FROM current_setting('practicehub.tenant_id', true) THEN
    RAISE EXCEPTION 'effect_tenant_scope_mismatch';
  END IF;
  UPDATE sched.command_effect SET state='indeterminate', updated_at=clock_timestamp()
   WHERE tenant_id=requested_tenant_id AND idempotency_key=requested_idempotency_key
     AND state='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'effect_not_pending'; END IF;
  UPDATE sched.command_effect_scope SET state='indeterminate'
   WHERE tenant_id=requested_tenant_id AND idempotency_key=requested_idempotency_key
     AND state='pending';
END
$effect$;

CREATE OR REPLACE FUNCTION sched.complete_effect(
  requested_tenant_id text,
  requested_idempotency_key text,
  requested_receipt_id text,
  requested_result jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,sched AS $effect$
BEGIN
  IF requested_tenant_id IS DISTINCT FROM current_setting('practicehub.tenant_id', true) THEN
    RAISE EXCEPTION 'effect_tenant_scope_mismatch';
  END IF;
  UPDATE sched.command_effect
     SET state='complete', receipt_id=requested_receipt_id, result=requested_result,
         updated_at=clock_timestamp()
   WHERE tenant_id=requested_tenant_id AND idempotency_key=requested_idempotency_key
     AND state='pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'effect_not_pending'; END IF;
  UPDATE sched.command_effect_scope SET state='closed'
   WHERE tenant_id=requested_tenant_id AND idempotency_key=requested_idempotency_key
     AND state='pending';
END
$effect$;

CREATE OR REPLACE FUNCTION sched.reconcile_effect(
  requested_tenant_id text,
  requested_idempotency_key text,
  requested_result jsonb
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,sched AS $effect$
BEGIN
  IF requested_tenant_id IS DISTINCT FROM current_setting('practicehub.tenant_id', true) THEN
    RAISE EXCEPTION 'effect_tenant_scope_mismatch';
  END IF;
  UPDATE sched.command_effect
     SET state='reconciled', result=requested_result, updated_at=clock_timestamp()
   WHERE tenant_id=requested_tenant_id AND idempotency_key=requested_idempotency_key
     AND state='indeterminate';
  IF NOT FOUND THEN RAISE EXCEPTION 'effect_not_indeterminate'; END IF;
  UPDATE sched.command_effect_scope SET state='closed'
   WHERE tenant_id=requested_tenant_id AND idempotency_key=requested_idempotency_key
     AND state='indeterminate';
END
$effect$;

GRANT SELECT ON ALL TABLES IN SCHEMA sched TO module_scheduling;
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA sched FROM module_scheduling;
GRANT EXECUTE ON FUNCTION sched.expire_hold(text,text,timestamptz) TO module_scheduling;
GRANT EXECUTE ON FUNCTION sched.lock_reservation_subjects(text,jsonb) TO module_scheduling;
GRANT EXECUTE ON FUNCTION sched.assert_reservation_completeness(text,text,text)
  TO module_scheduling;
GRANT EXECUTE ON FUNCTION sched.begin_effect(text,text,text,text,text,bigint,bigint,boolean,text,text,text[],tstzrange)
  TO module_scheduling;
GRANT EXECUTE ON FUNCTION sched.mark_effect_indeterminate(text,text) TO module_scheduling;
GRANT EXECUTE ON FUNCTION sched.complete_effect(text,text,text,jsonb) TO module_scheduling;
GRANT EXECUTE ON FUNCTION sched.reconcile_effect(text,text,jsonb) TO module_scheduling;

DO $rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'appointment','booking_receipt','command_effect','command_effect_scope','constraint_bundle','outbox','policy_snapshot',
    'reconciliation_case','resource','resource_reservation','slot_hold','slot_offer',
    'waitlist_entry','waitlist_offer'
  ] LOOP
    EXECUTE format('ALTER TABLE sched.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE sched.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON sched.%I USING (tenant_id = current_setting(''practicehub.tenant_id'', true)) WITH CHECK (tenant_id = current_setting(''practicehub.tenant_id'', true))',
      table_name
    );
  END LOOP;
END
$rls$;

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
