-- WP-010 synthetic tenancy seed. Applied by `pnpm local:seed` after module
-- migrations (never at container init — the tables come from
-- modules/platform-core/migrations/0001-tenancy.sql). Idempotent upserts;
-- synthetic data only. Riverbend stays the opposite-capability-state tenant
-- (see platform_core.synthetic_tenant seeded by 002-seed.sql) and carries
-- distinct branding for the brand-leak negative.

INSERT INTO platform_core.tenant (tenant_id, display_name, status, synthetic)
VALUES
  ('northwind-synthetic', 'Northwind Health & Care Synthetic', 'active', true),
  ('riverbend-synthetic', 'Riverbend Synthetic', 'active', true)
ON CONFLICT (tenant_id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    status = EXCLUDED.status,
    synthetic = EXCLUDED.synthetic;

INSERT INTO platform_core.legal_entity
  (tenant_id, legal_entity_id, name, entity_type, cpom_state, counsel_ratification_ref, synthetic)
VALUES
  ('northwind-synthetic', 'northwind-health-nv', 'Northwind Health & Care NV Synthetic PLLC', 'PLLC',
   'NV', 'synthetic-counsel-cpom-nv-001', true),
  ('northwind-synthetic', 'northwind-health-fl', 'Northwind Health & Care FL Synthetic PLLC', 'PLLC',
   'FL', 'synthetic-counsel-cpom-fl-001', true),
  ('northwind-synthetic', 'northwind-mso', 'Northwind Synthetic Management Services', 'MSO', NULL, NULL, true),
  ('riverbend-synthetic', 'riverbend-medical-il', 'Riverbend Medical IL Synthetic PC', 'PC',
   'IL', 'synthetic-counsel-cpom-il-001', true)
ON CONFLICT (tenant_id, legal_entity_id) DO UPDATE
SET name = EXCLUDED.name,
    entity_type = EXCLUDED.entity_type,
    cpom_state = EXCLUDED.cpom_state,
    counsel_ratification_ref = EXCLUDED.counsel_ratification_ref,
    synthetic = EXCLUDED.synthetic;

INSERT INTO platform_core.location
  (tenant_id, location_id, legal_entity_id, name, state_code, kind, synthetic)
VALUES
  ('northwind-synthetic', 'northwind-nv-henderson', 'northwind-health-nv', 'Northwind Henderson Synthetic Clinic',
   'NV', 'physical', true),
  ('northwind-synthetic', 'northwind-fl-coral-gables', 'northwind-health-fl', 'Northwind Coral Gables Synthetic Clinic',
   'FL', 'physical', true),
  ('northwind-synthetic', 'northwind-virtual-nv', 'northwind-health-nv', 'Northwind Synthetic Virtual Care NV',
   'NV', 'virtual', true),
  ('riverbend-synthetic', 'riverbend-chicago-loop', 'riverbend-medical-il',
   'Riverbend Chicago Loop Synthetic Clinic', 'IL', 'physical', true)
ON CONFLICT (tenant_id, location_id) DO UPDATE
SET legal_entity_id = EXCLUDED.legal_entity_id,
    name = EXCLUDED.name,
    state_code = EXCLUDED.state_code,
    kind = EXCLUDED.kind,
    synthetic = EXCLUDED.synthetic;

INSERT INTO platform_core.tenant_config
  (tenant_id, legal_entity_id, location_id, namespace, key, value, phi_class,
   counsel_owned, change_control_ref, revision, changed_by, synthetic)
VALUES
  -- White-label branding (distinct per tenant: brand-leak negative reads these).
  ('northwind-synthetic', NULL, NULL, 'branding', 'display-name',
   '"Northwind Health & Care (Synthetic)"'::jsonb, 'none', false, NULL, 1,
   'synthetic-platform-bootstrap', true),
  ('riverbend-synthetic', NULL, NULL, 'branding', 'display-name',
   '"Riverbend Health (Synthetic)"'::jsonb, 'none', false, NULL, 1,
   'synthetic-platform-bootstrap', true),
  ('northwind-synthetic', NULL, NULL, 'portal-domain', 'primary',
   '"portal.northwind.synthetic.invalid"'::jsonb, 'none', false, NULL, 1,
   'synthetic-platform-bootstrap', true),
  ('riverbend-synthetic', NULL, NULL, 'portal-domain', 'primary',
   '"portal.riverbend.synthetic.invalid"'::jsonb, 'none', false, NULL, 1,
   'synthetic-platform-bootstrap', true),
  -- Counsel-owned disclosure string (R6-SR-110 change-control pattern).
  ('northwind-synthetic', NULL, NULL, 'disclosure', 'sms-footer',
   '"Synthetic Northwind disclosure: reply STOP to opt out."'::jsonb, 'none',
   true, 'synthetic-ccr-001', 1, 'synthetic-platform-bootstrap', true),
  -- REQ-ADM-027: per-location × payer × provider accepting-new-patients config.
  -- Values carry the machine-readable policy-state vocabulary
  -- (open/not-accepted/panel-closed/waitlist/existing-patients-only).
  ('northwind-synthetic', 'northwind-health-nv', 'northwind-nv-henderson', 'policy',
   'accepting-new-patients:payer=*:provider=*',
   '{"policy": "open", "reason": "default-open"}'::jsonb, 'none', false, NULL, 1,
   'synthetic-practice-manager-001', true),
  ('northwind-synthetic', 'northwind-health-nv', 'northwind-nv-henderson', 'policy',
   'accepting-new-patients:payer=synthetic-medicare:provider=*',
   '{"policy": "panel-closed", "reason": "medicare-panel-full"}'::jsonb, 'none', false, NULL, 1,
   'synthetic-practice-manager-001', true),
  ('northwind-synthetic', 'northwind-health-nv', 'northwind-nv-henderson', 'policy',
   'accepting-new-patients:payer=synthetic-medicare:provider=synthetic-dr-lee',
   '{"policy": "open", "reason": "provider-exception"}'::jsonb, 'none', false, NULL, 1,
   'synthetic-practice-manager-001', true),
  -- Waitlist and existing-patients-only states (REQ-ADM-027 AC-1).
  ('northwind-synthetic', 'northwind-health-nv', 'northwind-nv-henderson', 'policy',
   'accepting-new-patients:payer=synthetic-cigna:provider=*',
   '{"policy": "waitlist", "reason": "waitlist-available"}'::jsonb, 'none', false, NULL, 1,
   'synthetic-practice-manager-001', true),
  ('northwind-synthetic', 'northwind-health-nv', 'northwind-nv-henderson', 'policy',
   'accepting-new-patients:payer=synthetic-humana:provider=*',
   '{"policy": "existing-patients-only", "reason": "established-patients-only"}'::jsonb,
   'none', false, NULL, 1, 'synthetic-practice-manager-001', true),
  -- Plan-scoped payer ids (REQ-ADM-047 exception 2): two plans of one payer,
  -- different answers, no bare payer-level entry that would collapse them.
  ('northwind-synthetic', 'northwind-health-nv', 'northwind-nv-henderson', 'policy',
   'accepting-new-patients:payer=synthetic-aetna-gold-plan:provider=*',
   '{"policy": "open", "reason": "gold-plan-contracted"}'::jsonb, 'none', false, NULL, 1,
   'synthetic-practice-manager-001', true),
  ('northwind-synthetic', 'northwind-health-nv', 'northwind-nv-henderson', 'policy',
   'accepting-new-patients:payer=synthetic-aetna-basic-plan:provider=*',
   '{"policy": "not-accepted", "reason": "basic-plan-not-contracted"}'::jsonb, 'none', false,
   NULL, 1, 'synthetic-practice-manager-001', true),
  -- Superseded revision pair (RECOVERY semantics: highest revision wins, prior
  -- retained with its own attribution).
  ('northwind-synthetic', 'northwind-health-fl', 'northwind-fl-coral-gables', 'policy',
   'accepting-new-patients:payer=*:provider=*',
   '{"policy": "panel-closed", "reason": "misconfigured-closed"}'::jsonb, 'none', false, NULL, 1,
   'synthetic-practice-manager-001', true),
  ('northwind-synthetic', 'northwind-health-fl', 'northwind-fl-coral-gables', 'policy',
   'accepting-new-patients:payer=*:provider=*',
   '{"policy": "open", "reason": "corrected-open"}'::jsonb, 'none', false, NULL, 2,
   'synthetic-practice-manager-002', true),
  ('riverbend-synthetic', 'riverbend-medical-il', 'riverbend-chicago-loop', 'policy',
   'accepting-new-patients:payer=*:provider=*',
   '{"policy": "not-accepted", "reason": "not-accepting"}'::jsonb, 'none', false, NULL, 1,
   'synthetic-practice-manager-001', true)
ON CONFLICT ON CONSTRAINT tenant_config_scope_key DO UPDATE
SET value = EXCLUDED.value,
    phi_class = EXCLUDED.phi_class,
    counsel_owned = EXCLUDED.counsel_owned,
    change_control_ref = EXCLUDED.change_control_ref,
    changed_at = now(),
    changed_by = EXCLUDED.changed_by,
    synthetic = EXCLUDED.synthetic;
