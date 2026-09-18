DO $guard$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'voice') THEN
    DROP TABLE IF EXISTS voice.voicemail_triage;
    DROP TABLE IF EXISTS voice.recording_decision;
    DROP TABLE IF EXISTS voice.call_session;
    DROP SCHEMA IF EXISTS voice;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_voice') THEN
    DROP ROLE module_voice;
  END IF;
END
$guard$;
