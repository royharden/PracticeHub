-- WP-100 exact synthetic development scope. The provider port binds RAIL-022;
-- model_binding stores its pinned model version, not another rail selector.
-- Versioned rows never overwrite a protective disablement or changed grant.
BEGIN;

INSERT INTO ai_gateway.model_binding
  (tenant_id, use_case, cohort_ref, binding_ref, vendor_id, model_ref,
   pinned_model_version, prompt_template_version, system_policy_ref,
   version, mode, enabled, synthetic)
VALUES
  ('northwind-synthetic', 'draft-visit-summary', 'cohort-alpha', 'binding:summary:alpha',
   'synthetic-ai-covered', 'model:synthetic-summary', 'model-api-v1', 'prompt-v1',
   'policy:ai:v1', 1, 'dev', true, true)
ON CONFLICT (tenant_id, binding_ref) DO NOTHING;

INSERT INTO ai_gateway.tool_grant
  (tenant_id, actor_ref, subject_ref, cohort_ref, ai_system_ref, purpose, version, allowed_tool_ids,
   allowed_argument_keys_by_tool, required_argument_keys_by_tool,
   allow_draft_side_effect, human_approval_required, enabled, environment, synthetic)
VALUES
  ('northwind-synthetic', 'staff:northwind:001', 'subject:northwind:001', 'cohort-alpha',
   'ai:summary', 'treatment', 1, ARRAY['tool:chart-read']::text[],
   '{"tool:chart-read":["subjectRef"]}'::jsonb, '{"tool:chart-read":["subjectRef"]}'::jsonb,
   false, true, true, 'dev', true)
ON CONFLICT (tenant_id, actor_ref, subject_ref, cohort_ref, ai_system_ref, version) DO NOTHING;

-- Refuse conflicting versioned state rather than silently broadening it.
DO $seed_guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ai_gateway.model_binding
    WHERE tenant_id = 'northwind-synthetic' AND binding_ref = 'binding:summary:alpha'
      AND use_case = 'draft-visit-summary' AND cohort_ref = 'cohort-alpha'
      AND vendor_id = 'synthetic-ai-covered' AND model_ref = 'model:synthetic-summary'
      AND pinned_model_version = 'model-api-v1' AND prompt_template_version = 'prompt-v1'
      AND system_policy_ref = 'policy:ai:v1' AND version = 1
      AND mode = 'dev' AND enabled AND synthetic
  ) OR NOT EXISTS (
    SELECT 1 FROM ai_gateway.tool_grant
    WHERE tenant_id = 'northwind-synthetic' AND actor_ref = 'staff:northwind:001'
      AND subject_ref = 'subject:northwind:001' AND cohort_ref = 'cohort-alpha'
      AND ai_system_ref = 'ai:summary' AND purpose = 'treatment' AND version = 1
      AND allowed_tool_ids = ARRAY['tool:chart-read']::text[]
      AND allowed_argument_keys_by_tool = '{"tool:chart-read":["subjectRef"]}'::jsonb
      AND required_argument_keys_by_tool = '{"tool:chart-read":["subjectRef"]}'::jsonb
      AND NOT allow_draft_side_effect AND human_approval_required AND enabled
      AND environment = 'dev' AND synthetic
  ) THEN
    RAISE EXCEPTION 'synthetic AI seed conflicts with existing binding or grant';
  END IF;
  IF EXISTS (SELECT 1 FROM ai_gateway.model_binding
             WHERE tenant_id = 'riverbend-synthetic' AND enabled)
     OR EXISTS (SELECT 1 FROM ai_gateway.tool_grant WHERE tenant_id = 'riverbend-synthetic') THEN
    RAISE EXCEPTION 'opposite-state synthetic tenant must have no enabled AI binding or tool grant';
  END IF;
END
$seed_guard$;

COMMIT;
