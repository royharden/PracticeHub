-- WP-042 prospective portal intake. Collection consent is a separate immutable
-- evidence stream; it never grants treatment or marketing communication.
CREATE SCHEMA IF NOT EXISTS portal_intake;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_portal_intake') THEN
    CREATE ROLE module_portal_intake NOLOGIN;
  END IF;
END
$roles$;
GRANT module_portal_intake TO practicehub_app;
GRANT USAGE ON SCHEMA portal_intake TO module_portal_intake;

CREATE TABLE IF NOT EXISTS portal_intake.intake_definition (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  definition_id text NOT NULL CHECK (definition_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  version text NOT NULL CHECK (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  effective_at timestamptz NOT NULL,
  privacy_notice_ref text NOT NULL CHECK (privacy_notice_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  fields jsonb NOT NULL,
  health_fields jsonb NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, definition_id, version)
);

CREATE TABLE IF NOT EXISTS portal_intake.intake_event (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  event_id text NOT NULL CHECK (event_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  intake_ref text NOT NULL CHECK (intake_ref ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  prospect_ref text NOT NULL CHECK (prospect_ref ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  event_type text NOT NULL CHECK (event_type IN ('collection-consent-granted','collection-consent-declined','subject-linked','submitted','abandoned')),
  purpose text CHECK (purpose IS NULL OR purpose = 'quiz-collection'),
  quiz_version text,
  notice_version text,
  embedding_origin text,
  evidence_ref text CHECK (evidence_ref IS NULL OR evidence_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  evidence_hash text CHECK (evidence_hash IS NULL OR evidence_hash ~ '^[0-9a-f]{64}$'),
  governed_person_ref text CHECK (governed_person_ref IS NULL OR governed_person_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  source_event_id text CHECK (source_event_id IS NULL OR source_event_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  occurred_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, event_id),
  CONSTRAINT collection_consent_shape CHECK (
    event_type NOT IN ('collection-consent-granted','collection-consent-declined') OR
    (purpose = 'quiz-collection' AND quiz_version IS NOT NULL AND notice_version IS NOT NULL
      AND embedding_origin IS NOT NULL AND evidence_ref IS NOT NULL AND evidence_hash IS NOT NULL
      AND governed_person_ref IS NULL AND source_event_id IS NULL)
  ),
  CONSTRAINT subject_link_shape CHECK (
    event_type <> 'subject-linked' OR
    (purpose = 'quiz-collection' AND quiz_version IS NOT NULL AND notice_version IS NOT NULL
      AND embedding_origin IS NOT NULL AND governed_person_ref IS NOT NULL
      AND source_event_id IS NOT NULL AND evidence_ref IS NOT NULL AND evidence_hash IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, source_event_id)
    REFERENCES portal_intake.intake_event (tenant_id, event_id)
);

CREATE TABLE IF NOT EXISTS portal_intake.intake_submission (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  intake_ref text NOT NULL CHECK (intake_ref ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  prospect_ref text NOT NULL CHECK (prospect_ref ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  governed_person_ref text CHECK (governed_person_ref IS NULL OR governed_person_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  definition_id text NOT NULL,
  definition_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('submitted','urgent-review','abandoned')),
  work_item_ref text CHECK (work_item_ref IS NULL OR work_item_ref ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
  response_due_at timestamptz,
  submitted_at timestamptz NOT NULL,
  last_event_id text NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, intake_ref),
  FOREIGN KEY (tenant_id, definition_id, definition_version)
    REFERENCES portal_intake.intake_definition (tenant_id, definition_id, version),
  CONSTRAINT submitted_has_owned_receipt CHECK (
    status = 'abandoned' OR (work_item_ref IS NOT NULL AND response_due_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS portal_intake.intake_attempt (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  attempt_key text NOT NULL CHECK (attempt_key ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  consent_event_id text NOT NULL CHECK (consent_event_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  attachment_receipts jsonb NOT NULL DEFAULT '[]'::jsonb,
  work_item_ref text CHECK (work_item_ref IS NULL OR work_item_ref ~ '^[a-z0-9][a-z0-9-]{0,127}$'),
  response_due_at timestamptz,
  status text CHECK (status IS NULL OR status IN ('submitted','urgent-review')),
  state text NOT NULL CHECK (state IN ('consented','uploads-reconciled','complete')),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, attempt_key),
  CONSTRAINT complete_attempt_receipt CHECK (
    state <> 'complete' OR (work_item_ref IS NOT NULL AND response_due_at IS NOT NULL AND status IS NOT NULL)
  )
);

CREATE OR REPLACE FUNCTION portal_intake.require_ref_only_attempt_receipts() RETURNS trigger
LANGUAGE plpgsql AS $receipt$
DECLARE
  item jsonb;
  keys text[];
BEGIN
  IF jsonb_typeof(NEW.attachment_receipts) <> 'array' THEN
    RAISE EXCEPTION 'attempt_attachment_receipts_must_be_array';
  END IF;
  IF TG_OP = 'UPDATE' AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(OLD.attachment_receipts) AS prior(value)
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(NEW.attachment_receipts) AS candidate(value)
        WHERE candidate.value = prior.value
     )
  ) THEN
    RAISE EXCEPTION 'attempt_attachment_receipts_are_immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.state = 'complete' AND (
    OLD.attachment_receipts IS DISTINCT FROM NEW.attachment_receipts
    OR OLD.work_item_ref IS DISTINCT FROM NEW.work_item_ref
    OR OLD.response_due_at IS DISTINCT FROM NEW.response_due_at
    OR OLD.status IS DISTINCT FROM NEW.status
  ) THEN
    RAISE EXCEPTION 'completed_attempt_receipt_is_immutable';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(NEW.attachment_receipts) LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'attempt_attachment_receipts_must_be_ref_only';
    END IF;
    SELECT array_agg(key ORDER BY key) INTO keys FROM jsonb_object_keys(item) AS key;
    IF keys IS DISTINCT FROM ARRAY['blobRef','contentHash','documentRef','observedAttributeNames']::text[]
       OR jsonb_typeof(item->'documentRef') IS DISTINCT FROM 'string'
       OR jsonb_typeof(item->'blobRef') IS DISTINCT FROM 'string'
       OR jsonb_typeof(item->'contentHash') IS DISTINCT FROM 'string'
       OR COALESCE(item->>'documentRef','') !~ '^[a-z0-9][a-z0-9-]{0,63}$'
       OR COALESCE(item->>'contentHash','') !~ '^[0-9a-f]{64}$'
       OR item->>'blobRef' IS DISTINCT FROM 'blob://documents/' || (item->>'contentHash')
       OR jsonb_typeof(item->'observedAttributeNames') IS DISTINCT FROM 'array'
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(item->'observedAttributeNames') AS observed(value)
          WHERE jsonb_typeof(value) IS DISTINCT FROM 'string'
             OR (value #>> '{}') NOT IN ('patient-name','date-of-birth','address','phone','mrn','ssn-last4','member-id','sender-fax','account-number')
       ) THEN
      RAISE EXCEPTION 'attempt_attachment_receipts_must_be_ref_only';
    END IF;
  END LOOP;
  RETURN NEW;
END
$receipt$;
DROP TRIGGER IF EXISTS ref_only_attempt_receipts ON portal_intake.intake_attempt;
CREATE TRIGGER ref_only_attempt_receipts BEFORE INSERT OR UPDATE ON portal_intake.intake_attempt
FOR EACH ROW EXECUTE FUNCTION portal_intake.require_ref_only_attempt_receipts();

CREATE TABLE IF NOT EXISTS portal_intake.intake_answer (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  answer_id text NOT NULL CHECK (answer_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  intake_ref text NOT NULL,
  field_id text NOT NULL CHECK (field_id ~ '^[a-z0-9][a-z0-9:._-]{0,127}$'),
  answer_value text NOT NULL,
  respondent_ref text NOT NULL CHECK (respondent_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  respondent_role text NOT NULL CHECK (respondent_role IN ('prospect','patient','proxy')),
  source_channel text NOT NULL CHECK (source_channel IN ('primary-web','embedded-web','staff-assisted')),
  captured_at timestamptz NOT NULL,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, answer_id),
  FOREIGN KEY (tenant_id, intake_ref) REFERENCES portal_intake.intake_submission (tenant_id, intake_ref)
);

CREATE TABLE IF NOT EXISTS portal_intake.intake_attachment (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  attachment_id text NOT NULL CHECK (attachment_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  intake_ref text NOT NULL,
  document_ref text NOT NULL CHECK (document_ref ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  blob_ref text NOT NULL CHECK (blob_ref ~ '^blob://documents/[0-9a-f]{64}$'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status = 'quarantined'),
  observed_attribute_names text[] NOT NULL CHECK (observed_attribute_names <@ ARRAY['patient-name','date-of-birth','address','phone','mrn','ssn-last4','member-id','sender-fax','account-number']::text[]),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, attachment_id),
  FOREIGN KEY (tenant_id, intake_ref) REFERENCES portal_intake.intake_submission (tenant_id, intake_ref),
  CONSTRAINT attachment_content_address CHECK (blob_ref = 'blob://documents/' || content_hash)
);

CREATE OR REPLACE FUNCTION portal_intake.require_collection_consent() RETURNS trigger
LANGUAGE plpgsql AS $guard$
DECLARE
  latest_type text;
BEGIN
  SELECT e.event_type INTO latest_type
    FROM portal_intake.intake_event e
    JOIN portal_intake.intake_submission s
      ON s.tenant_id = NEW.tenant_id AND s.intake_ref = NEW.intake_ref
   WHERE e.tenant_id = NEW.tenant_id AND e.intake_ref = NEW.intake_ref
     AND e.prospect_ref = s.prospect_ref AND e.purpose = 'quiz-collection'
     AND e.quiz_version = s.definition_version AND e.occurred_at <= NEW.captured_at
     AND e.event_type IN ('collection-consent-granted','collection-consent-declined')
     AND EXISTS (
       SELECT 1 FROM portal_intake.intake_definition d,
                    jsonb_array_elements(d.health_fields) AS field
        WHERE d.tenant_id=s.tenant_id AND d.definition_id=s.definition_id
          AND d.version=s.definition_version AND field->>'key'=NEW.field_id
          AND field->>'sensitivity'='health'
          AND field->>'collectionConsentPurpose'='quiz-collection'
     )
   ORDER BY e.occurred_at DESC,
            (e.event_type='collection-consent-declined') DESC,
            e.event_id DESC LIMIT 1;
  IF latest_type IS DISTINCT FROM 'collection-consent-granted' THEN
    RAISE EXCEPTION 'collection_consent_precedes_health';
  END IF;
  RETURN NEW;
END
$guard$;

CREATE OR REPLACE FUNCTION portal_intake.require_exact_subject_link() RETURNS trigger
LANGUAGE plpgsql AS $link$
DECLARE
  source portal_intake.intake_event%ROWTYPE;
BEGIN
  IF NEW.event_type <> 'subject-linked' THEN RETURN NEW; END IF;
  SELECT * INTO source FROM portal_intake.intake_event
   WHERE tenant_id=NEW.tenant_id AND event_id=NEW.source_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subject_link_source_missing';
  END IF;
  IF source.event_type IS DISTINCT FROM 'collection-consent-granted'
     OR source.intake_ref IS DISTINCT FROM NEW.intake_ref
     OR source.prospect_ref IS DISTINCT FROM NEW.prospect_ref
     OR source.purpose IS DISTINCT FROM NEW.purpose
     OR source.quiz_version IS DISTINCT FROM NEW.quiz_version
     OR source.notice_version IS DISTINCT FROM NEW.notice_version
     OR source.embedding_origin IS DISTINCT FROM NEW.embedding_origin
     OR source.evidence_ref IS DISTINCT FROM NEW.evidence_ref
     OR source.evidence_hash IS DISTINCT FROM NEW.evidence_hash
     OR source.occurred_at > NEW.occurred_at THEN
    RAISE EXCEPTION 'subject_link_must_preserve_granted_collection_consent';
  END IF;
  RETURN NEW;
END
$link$;
DROP TRIGGER IF EXISTS exact_subject_link ON portal_intake.intake_event;
CREATE TRIGGER exact_subject_link BEFORE INSERT ON portal_intake.intake_event
FOR EACH ROW EXECUTE FUNCTION portal_intake.require_exact_subject_link();

DROP TRIGGER IF EXISTS collection_consent_precedes_health ON portal_intake.intake_answer;
CREATE TRIGGER collection_consent_precedes_health BEFORE INSERT ON portal_intake.intake_answer
FOR EACH ROW EXECUTE FUNCTION portal_intake.require_collection_consent();

GRANT SELECT ON portal_intake.intake_definition TO module_portal_intake;
GRANT SELECT, INSERT ON portal_intake.intake_event TO module_portal_intake;
GRANT SELECT, INSERT ON portal_intake.intake_submission TO module_portal_intake;
REVOKE UPDATE ON portal_intake.intake_submission FROM module_portal_intake;
GRANT UPDATE (governed_person_ref,status,work_item_ref,response_due_at,last_event_id)
  ON portal_intake.intake_submission TO module_portal_intake;
GRANT SELECT, INSERT, UPDATE ON portal_intake.intake_attempt TO module_portal_intake;
GRANT SELECT, INSERT ON portal_intake.intake_answer TO module_portal_intake;
GRANT SELECT, INSERT, UPDATE ON portal_intake.intake_attachment TO module_portal_intake;
REVOKE INSERT, UPDATE, DELETE ON portal_intake.intake_definition FROM module_portal_intake;
REVOKE UPDATE, DELETE ON portal_intake.intake_event FROM module_portal_intake;
REVOKE DELETE ON portal_intake.intake_submission FROM module_portal_intake;
REVOKE DELETE ON portal_intake.intake_attempt FROM module_portal_intake;
REVOKE UPDATE, DELETE ON portal_intake.intake_answer FROM module_portal_intake;
REVOKE DELETE ON portal_intake.intake_attachment FROM module_portal_intake;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE portal_intake.intake_answer ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_intake.intake_answer FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON portal_intake.intake_answer;
CREATE POLICY tenant_isolation ON portal_intake.intake_answer
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE portal_intake.intake_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_intake.intake_attachment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON portal_intake.intake_attachment;
CREATE POLICY tenant_isolation ON portal_intake.intake_attachment
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE portal_intake.intake_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_intake.intake_attempt FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON portal_intake.intake_attempt;
CREATE POLICY tenant_isolation ON portal_intake.intake_attempt
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE portal_intake.intake_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_intake.intake_definition FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON portal_intake.intake_definition;
CREATE POLICY tenant_isolation ON portal_intake.intake_definition
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE portal_intake.intake_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_intake.intake_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON portal_intake.intake_event;
CREATE POLICY tenant_isolation ON portal_intake.intake_event
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE portal_intake.intake_submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_intake.intake_submission FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON portal_intake.intake_submission;
CREATE POLICY tenant_isolation ON portal_intake.intake_submission
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
   WHERE n.nspname = 'portal_intake'
     AND c.relkind = 'r'
     AND (NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR c.relname NOT IN ('intake_answer', 'intake_attachment', 'intake_attempt', 'intake_definition', 'intake_event', 'intake_submission'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema portal_intake: %', offender;
  END IF;
END
$coverage$;
-- rls:generated:end
