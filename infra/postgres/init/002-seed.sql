INSERT INTO platform_core.synthetic_tenant (
  tenant_id,
  display_name,
  synthetic,
  bootstrap_capability_state
)
VALUES
  ('northwind-synthetic', 'Northwind Health & Care Synthetic', true, 'simulated'),
  ('riverbend-synthetic', 'Riverbend Synthetic', true, 'disabled')
ON CONFLICT (tenant_id) DO UPDATE
SET
  display_name = EXCLUDED.display_name,
  synthetic = EXCLUDED.synthetic,
  bootstrap_capability_state = EXCLUDED.bootstrap_capability_state;
