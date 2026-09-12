INSERT INTO portal_intake.intake_definition
  (tenant_id, definition_id, version, effective_at, privacy_notice_ref, fields, health_fields, synthetic)
VALUES
  ('northwind-synthetic', 'prospective-intake', '2026-09-12', '2026-09-12T00:00:00Z',
   'privacy-notice:synthetic-v1',
   '[{"key":"contact-email","required":true,"purpose":"follow-up"},{"key":"urgency-screen","required":true,"purpose":"safe-routing"},{"key":"location","required":true,"purpose":"jurisdiction-routing"}]'::jsonb,
   '[{"key":"health-goal","purpose":"prospective-care-routing","sensitivity":"health","collectionConsentPurpose":"quiz-collection"}]'::jsonb,
   true),
  ('riverbend-synthetic', 'prospective-intake', '2026-09-12', '2026-09-12T00:00:00Z',
   'privacy-notice:synthetic-v1',
   '[{"key":"contact-email","required":true,"purpose":"follow-up"},{"key":"urgency-screen","required":true,"purpose":"safe-routing"},{"key":"location","required":true,"purpose":"jurisdiction-routing"}]'::jsonb,
   '[{"key":"health-goal","purpose":"prospective-care-routing","sensitivity":"health","collectionConsentPurpose":"quiz-collection"}]'::jsonb,
   true)
ON CONFLICT (tenant_id, definition_id, version) DO NOTHING;
