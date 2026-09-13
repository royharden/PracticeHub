-- WP-110 synthetic stage-only workbench evidence. No capability grant and no target write.

INSERT INTO migration.mapping_version (
  tenant_id, mapping_version_ref, source_system_ref, mapping_version_hash,
  status, approved_by, approval_evidence_ref, rules_json, synthetic
) VALUES (
  'northwind-synthetic', 'mapping:synthetic-v1', 'legacy-synthetic',
  repeat('b', 64), 'approved', 'staff:migration-owner',
  'evidence:mapping-approval-v1',
  '[{"sourceField":"patient-id","disposition":"mapped","targetField":"person.source-id","dataClassification":"demographic"},{"sourceField":"birth-date","disposition":"mapped","targetField":"person.birth-date","dataClassification":"phi"}]'::jsonb,
  true
) ON CONFLICT DO NOTHING;

INSERT INTO migration.source_manifest (
  tenant_id, source_manifest_ref, source_system_ref, source_manifest_hash,
  structurally_readable, in_scope_record_count, source_fields, artifact_refs, synthetic
) VALUES (
  'northwind-synthetic', 'manifest:synthetic-v1', 'legacy-synthetic', repeat('a', 64),
  true, 200, ARRAY['patient-id', 'birth-date'], ARRAY['artifact:synthetic-export-v1'], true
) ON CONFLICT DO NOTHING;

INSERT INTO migration.batch_event (
  tenant_id, batch_ref, version, event_ref, event_type, source_system_ref,
  evidence_hash, occurred_at, synthetic
) VALUES (
  'northwind-synthetic', 'batch:synthetic-v1', 1, 'event:migration-batch-v1-init',
  'initialized', 'legacy-synthetic', repeat('1', 64), '2026-01-01T00:00:00Z', true
) ON CONFLICT DO NOTHING;

INSERT INTO migration.validation_run (
  tenant_id, run_ref, source_manifest_ref, mapping_version_ref,
  source_manifest_hash, mapping_version_hash,
  failed_record_count, in_scope_record_count, threshold_basis_points,
  previously_threshold_blocked, threshold_state, readiness, blocker_codes,
  code_version_ref, config_version_ref, sample_evidence_refs,
  runtime_milliseconds, signoff_refs, proposed_write_set_hash, comparison_json,
  target_data_writes, synthetic
) VALUES (
  'northwind-synthetic', 'run:synthetic-v1', 'manifest:synthetic-v1',
  'mapping:synthetic-v1', repeat('a', 64), repeat('b', 64),
  0, 200, 500, false, 'clear', 'ready-for-review',
  ARRAY[]::text[], 'code:c540076', 'config:synthetic-v1',
  ARRAY['sample:synthetic-v1'], 42, ARRAY['signoff:migration-owner'],
  repeat('d', 64),
  '{"sourceRecordCount":200,"candidateRecordCount":200,"keyFieldCompleteness":{"patient-id":{"sourceCompleteCount":200,"candidateCompleteCount":200}},"identityMatchResults":{"matched":200,"candidate":0,"ambiguous":0,"unmatched":0},"outcomeCounts":{"created":200,"updated":0,"merged":0,"flagged":0}}'::jsonb,
  0, true
) ON CONFLICT DO NOTHING;

INSERT INTO migration.control_total (
  tenant_id, run_ref, total_ref, side, name, value_minor, unit, checksum,
  reconciliation_state, synthetic
) VALUES
  ('northwind-synthetic', 'run:synthetic-v1', 'total:source-records',
   'source', 'records', '200', 'records', repeat('c', 64), 'reconciled', true),
  ('northwind-synthetic', 'run:synthetic-v1', 'total:candidate-records',
   'candidate-target', 'records', '200', 'records', repeat('c', 64), 'reconciled', true)
ON CONFLICT DO NOTHING;

INSERT INTO migration.batch_event (
  tenant_id, batch_ref, version, event_ref, event_type, run_ref, readiness,
  evidence_hash, occurred_at, synthetic
) VALUES (
  'northwind-synthetic', 'batch:synthetic-v1', 2,
  'event:migration-batch-v1-dry-run', 'dry-run-recorded', 'run:synthetic-v1',
  'ready-for-review', repeat('2', 64), '2026-01-01T00:00:42Z', true
) ON CONFLICT DO NOTHING;

INSERT INTO migration.batch_state (
  tenant_id, batch_ref, source_system_ref, version, latest_run_ref,
  latest_readiness, synthetic
) VALUES (
  'northwind-synthetic', 'batch:synthetic-v1', 'legacy-synthetic', 2,
  'run:synthetic-v1', 'ready-for-review', true
) ON CONFLICT (tenant_id, batch_ref) DO NOTHING;
