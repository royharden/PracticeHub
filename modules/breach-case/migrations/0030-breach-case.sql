-- WP-098 breach-case consumer. Provider clock, audit, identity and notification
-- systems remain authoritative behind literal-v1 ports; this schema stores refs.
CREATE SCHEMA IF NOT EXISTS breach_case;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_breach_case') THEN
    CREATE ROLE module_breach_case NOLOGIN;
  END IF;
END
$roles$;

GRANT module_breach_case TO practicehub_app;
GRANT USAGE ON SCHEMA breach_case TO module_breach_case;

CREATE TABLE IF NOT EXISTS breach_case.breach_case (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  case_id text NOT NULL CHECK (case_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  source_kind text NOT NULL CHECK (source_kind IN ('manual','wrong-disclosure','account-takeover','audit-anomaly','vendor-incident','genetic-break-glass')),
  source_ref text NOT NULL CHECK (source_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  incident_at timestamptz NOT NULL,
  discovery_at timestamptz NOT NULL,
  owner_ref text NOT NULL CHECK (owner_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  status text NOT NULL CHECK (status IN ('assessing','determined-reportable','determined-low-probability','notifying','closed')),
  current_assessment_version integer CHECK (current_assessment_version IS NULL OR current_assessment_version > 0),
  current_scope_version integer CHECK (current_scope_version IS NULL OR current_scope_version > 0),
  determination jsonb,
  strictest_due_at timestamptz,
  retention_evidence_ref text CHECK (retention_evidence_ref IS NULL OR retention_evidence_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  closure_evidence_ref text CHECK (closure_evidence_ref IS NULL OR closure_evidence_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  last_event_seq integer NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, case_id),
  UNIQUE (tenant_id, source_ref),
  CONSTRAINT breach_discovery_not_before_incident CHECK (discovery_at >= incident_at),
  CONSTRAINT breach_closed_has_evidence CHECK (status <> 'closed' OR closure_evidence_ref IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS breach_case.breach_case_event (
  tenant_id text NOT NULL,
  case_id text NOT NULL,
  event_seq integer NOT NULL CHECK (event_seq > 0),
  event_key text NOT NULL CHECK (event_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  event_type text NOT NULL CHECK (event_type IN ('case-opened','scope-versioned','assessment-recorded','determination-recorded','duty-linked','duty-updated','notice-recorded','evidence-linked','targeted-review-opened','targeted-review-completed','case-reopened','case-closed')),
  occurred_at timestamptz NOT NULL,
  actor_ref text NOT NULL CHECK (actor_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  payload jsonb NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, case_id, event_seq),
  UNIQUE (tenant_id, event_key),
  UNIQUE (tenant_id, case_id, event_seq, event_type),
  FOREIGN KEY (tenant_id, case_id) REFERENCES breach_case.breach_case (tenant_id, case_id),
  CONSTRAINT breach_event_payload_tuple CHECK (
    (
      jsonb_typeof(payload) = 'object' AND
      payload ?& ARRAY['tenantId','caseId','eventSeq','eventKey','eventType','actorRef','occurredAt','synthetic'] AND
      jsonb_typeof(payload->'tenantId') = 'string' AND
      jsonb_typeof(payload->'caseId') = 'string' AND
      jsonb_typeof(payload->'eventSeq') = 'number' AND
      jsonb_typeof(payload->'eventKey') = 'string' AND
      jsonb_typeof(payload->'eventType') = 'string' AND
      jsonb_typeof(payload->'actorRef') = 'string' AND
      jsonb_typeof(payload->'occurredAt') = 'string' AND
      jsonb_typeof(payload->'synthetic') = 'boolean' AND
      payload->>'tenantId' = tenant_id AND
      payload->>'caseId' = case_id AND
      (payload->>'eventSeq')::integer = event_seq AND
      payload->>'eventKey' = event_key AND
      payload->>'eventType' = event_type AND
      payload->>'actorRef' = actor_ref AND
      (payload->>'occurredAt')::timestamptz = occurred_at AND
      (payload->>'synthetic')::boolean IS TRUE
    ) IS TRUE
  )
);

CREATE TABLE IF NOT EXISTS breach_case.factor_assessment (
  tenant_id text NOT NULL,
  case_id text NOT NULL,
  assessment_id text NOT NULL CHECK (assessment_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  version integer NOT NULL CHECK (version > 0),
  event_seq integer NOT NULL CHECK (event_seq > 0),
  event_type text NOT NULL CHECK (event_type = 'assessment-recorded'),
  scope_version integer NOT NULL CHECK (scope_version > 0),
  assessed_at timestamptz NOT NULL,
  assessed_by text NOT NULL CHECK (assessed_by ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  assessment jsonb NOT NULL,
  complete boolean NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, case_id, version),
  UNIQUE (tenant_id, assessment_id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES breach_case.breach_case (tenant_id, case_id),
  FOREIGN KEY (tenant_id, case_id, event_seq, event_type) REFERENCES breach_case.breach_case_event (tenant_id, case_id, event_seq, event_type)
);

CREATE TABLE IF NOT EXISTS breach_case.affected_scope_version (
  tenant_id text NOT NULL,
  case_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  event_seq integer NOT NULL CHECK (event_seq > 0),
  event_type text NOT NULL CHECK (event_type = 'scope-versioned'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  query_evidence_ref text NOT NULL CHECK (query_evidence_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  complete boolean NOT NULL,
  limitation_ref text CHECK (limitation_ref IS NULL OR limitation_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  recorded_at timestamptz NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, case_id, version),
  UNIQUE (tenant_id, case_id, content_hash),
  FOREIGN KEY (tenant_id, case_id) REFERENCES breach_case.breach_case (tenant_id, case_id),
  FOREIGN KEY (tenant_id, case_id, event_seq, event_type) REFERENCES breach_case.breach_case_event (tenant_id, case_id, event_seq, event_type),
  CONSTRAINT affected_scope_window_order CHECK (window_end >= window_start),
  CONSTRAINT affected_scope_limitation_truth CHECK ((complete AND limitation_ref IS NULL) OR (NOT complete AND limitation_ref IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS breach_case.affected_subject (
  tenant_id text NOT NULL,
  case_id text NOT NULL,
  scope_version integer NOT NULL,
  subject_ref text NOT NULL CHECK (subject_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, case_id, scope_version, subject_ref),
  FOREIGN KEY (tenant_id, case_id, scope_version) REFERENCES breach_case.affected_scope_version (tenant_id, case_id, version)
);

CREATE TABLE IF NOT EXISTS breach_case.jurisdiction_duty (
  tenant_id text NOT NULL,
  case_id text NOT NULL,
  duty_id text NOT NULL CHECK (duty_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  event_seq integer NOT NULL CHECK (event_seq > 0),
  event_type text NOT NULL CHECK (event_type IN ('duty-linked','duty-updated')),
  clock_id text NOT NULL CHECK (clock_id ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  jurisdiction text NOT NULL CHECK (jurisdiction = 'floor' OR jurisdiction ~ '^[A-Z]{2}$'),
  contribution_fact text NOT NULL CHECK (contribution_fact IN ('provider','patient','floor')),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  policy_effective_on date NOT NULL,
  policy_ref text NOT NULL CHECK (policy_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  due_at timestamptz NOT NULL,
  escalation_at timestamptz NOT NULL,
  required_audiences text[] NOT NULL CHECK (
    cardinality(required_audiences) > 0 AND
    required_audiences <@ ARRAY['individual','hhs','media','state-authority']::text[]
  ),
  status text NOT NULL CHECK (status IN ('open','escalated','satisfied','cancelled')),
  completion_evidence_ref text CHECK (completion_evidence_ref IS NULL OR completion_evidence_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, case_id, duty_id),
  UNIQUE (tenant_id, clock_id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES breach_case.breach_case (tenant_id, case_id),
  FOREIGN KEY (tenant_id, case_id, event_seq, event_type) REFERENCES breach_case.breach_case_event (tenant_id, case_id, event_seq, event_type),
  CONSTRAINT jurisdiction_duty_completion CHECK ((status IN ('open','escalated') AND completion_evidence_ref IS NULL) OR (status IN ('satisfied','cancelled') AND completion_evidence_ref IS NOT NULL)),
  CONSTRAINT jurisdiction_duty_escalation_order CHECK (escalation_at <= due_at)
);

CREATE TABLE IF NOT EXISTS breach_case.notification_evidence (
  tenant_id text NOT NULL,
  case_id text NOT NULL,
  notice_id text NOT NULL CHECK (notice_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  event_seq integer NOT NULL CHECK (event_seq > 0),
  event_type text NOT NULL CHECK (event_type = 'notice-recorded'),
  duty_id text NOT NULL,
  audience text NOT NULL CHECK (audience IN ('individual','hhs','media','state-authority')),
  payload_ref text NOT NULL CHECK (payload_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  prepared_by text NOT NULL CHECK (prepared_by ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  prepared_at timestamptz NOT NULL,
  approved_by text CHECK (approved_by IS NULL OR approved_by ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  approved_at timestamptz,
  effect_intent_key text CHECK (effect_intent_key IS NULL OR effect_intent_key ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  effect_key text CHECK (effect_key IS NULL OR effect_key ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  transport_state text NOT NULL CHECK (transport_state IN ('prepared','approved','effect-intended','accepted','unknown','delivered','failed')),
  terminal_evidence_ref text CHECK (terminal_evidence_ref IS NULL OR terminal_evidence_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, case_id, notice_id, event_seq),
  FOREIGN KEY (tenant_id, case_id, duty_id) REFERENCES breach_case.jurisdiction_duty (tenant_id, case_id, duty_id),
  FOREIGN KEY (tenant_id, case_id, event_seq, event_type) REFERENCES breach_case.breach_case_event (tenant_id, case_id, event_seq, event_type),
  CONSTRAINT notice_approval_order CHECK ((transport_state = 'prepared' AND approved_by IS NULL AND approved_at IS NULL) OR (transport_state <> 'prepared' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND approved_by <> prepared_by AND approved_at >= prepared_at)),
  CONSTRAINT notice_effect_shape CHECK (
    (transport_state IN ('prepared','approved') AND effect_intent_key IS NULL AND effect_key IS NULL) OR
    (transport_state = 'effect-intended' AND effect_intent_key IS NOT NULL AND effect_key IS NULL) OR
    (transport_state IN ('accepted','unknown','delivered','failed') AND effect_intent_key IS NOT NULL AND effect_key IS NOT NULL)
  ),
  CONSTRAINT notice_terminal_evidence CHECK ((transport_state = 'delivered' AND terminal_evidence_ref IS NOT NULL) OR (transport_state <> 'delivered' AND terminal_evidence_ref IS NULL))
);

CREATE TABLE IF NOT EXISTS breach_case.genetic_targeted_review (
  tenant_id text NOT NULL,
  case_id text NOT NULL,
  review_id text NOT NULL CHECK (review_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  event_seq integer NOT NULL CHECK (event_seq > 0),
  event_type text NOT NULL CHECK (event_type IN ('targeted-review-opened','targeted-review-completed')),
  grant_ref text NOT NULL CHECK (grant_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  audit_ref text NOT NULL CHECK (audit_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  work_item_ref text NOT NULL CHECK (work_item_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  accessor_ref text NOT NULL CHECK (accessor_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  initiator_ref text NOT NULL CHECK (initiator_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  subject_ref text NOT NULL CHECK (subject_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  review_due_at timestamptz NOT NULL,
  source_occurred_at timestamptz NOT NULL,
  risk text NOT NULL CHECK (risk = 'critical'),
  reviewer_ref text CHECK (reviewer_ref IS NULL OR reviewer_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  disposition text CHECK (disposition IS NULL OR disposition IN ('appropriate','insufficient-justification')),
  evidence_ref text CHECK (evidence_ref IS NULL OR evidence_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  completed_at timestamptz,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, case_id, review_id, event_seq),
  FOREIGN KEY (tenant_id, case_id) REFERENCES breach_case.breach_case (tenant_id, case_id),
  FOREIGN KEY (tenant_id, case_id, event_seq, event_type) REFERENCES breach_case.breach_case_event (tenant_id, case_id, event_seq, event_type),
  CONSTRAINT genetic_review_independent CHECK (reviewer_ref IS NULL OR (reviewer_ref <> accessor_ref AND reviewer_ref <> initiator_ref)),
  CONSTRAINT genetic_review_completion CHECK ((completed_at IS NULL AND reviewer_ref IS NULL AND disposition IS NULL AND evidence_ref IS NULL) OR (completed_at IS NOT NULL AND reviewer_ref IS NOT NULL AND disposition IS NOT NULL AND evidence_ref IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS breach_case.effect_fence (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  event_key text NOT NULL CHECK (event_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  case_id text NOT NULL,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic),
  PRIMARY KEY (tenant_id, event_key),
  FOREIGN KEY (tenant_id, case_id) REFERENCES breach_case.breach_case (tenant_id, case_id)
);

ALTER TABLE breach_case.breach_case
  DROP CONSTRAINT IF EXISTS breach_current_assessment_fk,
  ADD CONSTRAINT breach_current_assessment_fk
    FOREIGN KEY (tenant_id, case_id, current_assessment_version)
    REFERENCES breach_case.factor_assessment (tenant_id, case_id, version)
    DEFERRABLE INITIALLY DEFERRED,
  DROP CONSTRAINT IF EXISTS breach_current_scope_fk,
  ADD CONSTRAINT breach_current_scope_fk
    FOREIGN KEY (tenant_id, case_id, current_scope_version)
    REFERENCES breach_case.affected_scope_version (tenant_id, case_id, version)
    DEFERRABLE INITIALLY DEFERRED,
  DROP CONSTRAINT IF EXISTS breach_last_event_fk,
  ADD CONSTRAINT breach_last_event_fk
    FOREIGN KEY (tenant_id, case_id, last_event_seq)
    REFERENCES breach_case.breach_case_event (tenant_id, case_id, event_seq)
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE breach_case.factor_assessment
  DROP CONSTRAINT IF EXISTS factor_assessment_scope_fk,
  ADD CONSTRAINT factor_assessment_scope_fk
    FOREIGN KEY (tenant_id, case_id, scope_version)
    REFERENCES breach_case.affected_scope_version (tenant_id, case_id, version)
    DEFERRABLE INITIALLY DEFERRED;

GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA breach_case TO module_breach_case;
GRANT UPDATE (status, current_assessment_version, current_scope_version, determination, strictest_due_at, retention_evidence_ref, closure_evidence_ref, last_event_seq) ON breach_case.breach_case TO module_breach_case;
GRANT UPDATE (event_seq, event_type, status, completion_evidence_ref) ON breach_case.jurisdiction_duty TO module_breach_case;
REVOKE DELETE ON ALL TABLES IN SCHEMA breach_case FROM module_breach_case;
REVOKE UPDATE, DELETE ON breach_case.breach_case_event, breach_case.factor_assessment, breach_case.affected_scope_version, breach_case.affected_subject, breach_case.notification_evidence, breach_case.genetic_targeted_review, breach_case.effect_fence FROM module_breach_case;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE breach_case.affected_scope_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE breach_case.affected_scope_version FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON breach_case.affected_scope_version;
CREATE POLICY tenant_isolation ON breach_case.affected_scope_version
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE breach_case.affected_subject ENABLE ROW LEVEL SECURITY;
ALTER TABLE breach_case.affected_subject FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON breach_case.affected_subject;
CREATE POLICY tenant_isolation ON breach_case.affected_subject
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE breach_case.breach_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE breach_case.breach_case FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON breach_case.breach_case;
CREATE POLICY tenant_isolation ON breach_case.breach_case
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE breach_case.breach_case_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE breach_case.breach_case_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON breach_case.breach_case_event;
CREATE POLICY tenant_isolation ON breach_case.breach_case_event
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE breach_case.effect_fence ENABLE ROW LEVEL SECURITY;
ALTER TABLE breach_case.effect_fence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON breach_case.effect_fence;
CREATE POLICY tenant_isolation ON breach_case.effect_fence
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE breach_case.factor_assessment ENABLE ROW LEVEL SECURITY;
ALTER TABLE breach_case.factor_assessment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON breach_case.factor_assessment;
CREATE POLICY tenant_isolation ON breach_case.factor_assessment
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE breach_case.genetic_targeted_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE breach_case.genetic_targeted_review FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON breach_case.genetic_targeted_review;
CREATE POLICY tenant_isolation ON breach_case.genetic_targeted_review
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE breach_case.jurisdiction_duty ENABLE ROW LEVEL SECURITY;
ALTER TABLE breach_case.jurisdiction_duty FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON breach_case.jurisdiction_duty;
CREATE POLICY tenant_isolation ON breach_case.jurisdiction_duty
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE breach_case.notification_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE breach_case.notification_evidence FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON breach_case.notification_evidence;
CREATE POLICY tenant_isolation ON breach_case.notification_evidence
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
   WHERE n.nspname = 'breach_case'
     AND c.relkind = 'r'
     AND (NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR c.relname NOT IN ('affected_scope_version', 'affected_subject', 'breach_case', 'breach_case_event', 'effect_fence', 'factor_assessment', 'genetic_targeted_review', 'jurisdiction_duty', 'notification_evidence'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema breach_case: %', offender;
  END IF;
END
$coverage$;
-- rls:generated:end
