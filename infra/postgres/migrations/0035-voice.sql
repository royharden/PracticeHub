-- WP-046 voice. Unapplied. 0034 is D26 scheduling-inc2 on another checkout.
CREATE SCHEMA IF NOT EXISTS voice;

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_voice') THEN
    CREATE ROLE module_voice NOLOGIN;
  END IF;
END
$roles$;
GRANT module_voice TO practicehub_app;
GRANT USAGE ON SCHEMA voice TO module_voice;

CREATE TABLE IF NOT EXISTS voice.call_session (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  call_id text NOT NULL CHECK (call_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  state text NOT NULL,
  work_item_id text,
  context_package_ref text,
  synthetic boolean NOT NULL CHECK (synthetic = true),
  PRIMARY KEY (tenant_id, call_id)
);

CREATE TABLE IF NOT EXISTS voice.recording_decision (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  call_id text NOT NULL,
  rule text NOT NULL CHECK (rule = 'all-party'),
  outcome text NOT NULL CHECK (outcome IN (
    'recording-permitted','unrecorded-service','quarantined','hold-human-verify','purge-required','legal-hold-retain'
  )),
  workflow_permitted boolean NOT NULL,
  transcript_permitted boolean NOT NULL,
  playback_permitted boolean NOT NULL,
  legal_hold boolean NOT NULL,
  synthetic boolean NOT NULL CHECK (synthetic = true),
  PRIMARY KEY (tenant_id, call_id),
  FOREIGN KEY (tenant_id, call_id) REFERENCES voice.call_session (tenant_id, call_id)
);

CREATE TABLE IF NOT EXISTS voice.voicemail_triage (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  call_id text NOT NULL,
  urgency text NOT NULL CHECK (urgency IN ('routine','urgent','emergency')),
  paged_on_call boolean NOT NULL,
  work_item_id text NOT NULL,
  context_package_ref text,
  synthetic boolean NOT NULL CHECK (synthetic = true),
  PRIMARY KEY (tenant_id, call_id),
  FOREIGN KEY (tenant_id, call_id) REFERENCES voice.call_session (tenant_id, call_id)
);

GRANT SELECT, INSERT, UPDATE ON voice.call_session TO module_voice;
GRANT SELECT, INSERT, UPDATE ON voice.recording_decision TO module_voice;
GRANT SELECT, INSERT, UPDATE ON voice.voicemail_triage TO module_voice;
