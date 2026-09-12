INSERT INTO sched.constraint_bundle
  (tenant_id, constraint_bundle_id, version, constraints, created_at, synthetic)
VALUES
  ('northwind-synthetic', 'routine-visit', 1,
   '{"service":"routine-visit","durationMinutes":30}'::jsonb,
   '2026-09-12T00:00:00Z', true),
  ('riverbend-synthetic', 'routine-visit', 1,
   '{"service":"routine-visit","durationMinutes":30}'::jsonb,
   '2026-09-12T00:00:00Z', true)
ON CONFLICT (tenant_id, constraint_bundle_id, version) DO NOTHING;

INSERT INTO sched.policy_snapshot
  (tenant_id, policy_snapshot_id, policy_version, policy_hash,
   accepting_new_patients, payload, captured_at, synthetic)
VALUES
  ('northwind-synthetic', 'accepting-v1', 'v1',
   'fbbea487d56276a552405d678b16a5c2baef9410024ec8e6afc41ef0429ba51f', true,
   '{"acceptingNewPatients":true}'::jsonb, '2026-09-12T00:00:00Z', true),
  ('riverbend-synthetic', 'accepting-v1', 'v1',
   'fbbea487d56276a552405d678b16a5c2baef9410024ec8e6afc41ef0429ba51f', true,
   '{"acceptingNewPatients":true}'::jsonb, '2026-09-12T00:00:00Z', true)
ON CONFLICT (tenant_id, policy_snapshot_id) DO NOTHING;

INSERT INTO sched.resource
  (tenant_id, resource_id, resource_type, source_version, active, synthetic)
VALUES
  ('northwind-synthetic', 'provider-synthetic-1', 'provider', 1, true, true),
  ('northwind-synthetic', 'room-synthetic-1', 'room', 1, true, true),
  ('riverbend-synthetic', 'provider-synthetic-1', 'provider', 1, true, true),
  ('riverbend-synthetic', 'room-synthetic-1', 'room', 1, true, true)
ON CONFLICT (tenant_id, resource_id) DO NOTHING;
