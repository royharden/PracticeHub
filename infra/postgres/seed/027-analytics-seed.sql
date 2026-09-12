-- WP-076 synthetic analytics seed. The metric and projection are deliberately
-- non-clinical; they prove source lineage and a release-safe two-cell family.
INSERT INTO analytics.metric_definition
  (tenant_id, metric_id, metric_version, definition_hash, status, denominator_ref,
   allowed_event_types, required_source_refs, freshness_objective_minutes,
   dimensions, minimum_cell_count, maximum_classification,
   accountable_owner_ref, release_family, synthetic)
VALUES
  ('northwind-synthetic', 'analytics.synthetic.completed-visits', 1,
   '07613e939ec2547e08b8da32b7f46a8aac6056fb35a57308aed7f9b95f1cb899', 'active',
   'synthetic:scheduled-visits', ARRAY['synthetic.metric-observed'], ARRAY['source-a'],
   60, ARRAY['cohort'], 5, 'PHI', 'role:analytics-owner',
   '{"familyId":"two-cell-total","atomicCellIds":["a","b"],"nodes":[{"nodeId":"total","memberCellIds":["a","b"]},{"nodeId":"a","memberCellIds":["a"]},{"nodeId":"b","memberCellIds":["b"]}]}'::jsonb,
   true)
ON CONFLICT (tenant_id, metric_id, metric_version) DO NOTHING;

INSERT INTO analytics.projection_version
  (tenant_id, version_ref, legal_entity_id, dataset_id, cohort_ref, metric_id,
   metric_version, definition_hash, built_at, event_ids, maximum_classification,
   partition_tags, verification_status, content_hash, supersedes_version_ref, synthetic)
VALUES
  ('northwind-synthetic', 'projection-seed-0001', 'northwind-legal-entity-synthetic',
   'dataset:visits', 'cohort:all', 'analytics.synthetic.completed-visits', 1,
   '07613e939ec2547e08b8da32b7f46a8aac6056fb35a57308aed7f9b95f1cb899',
   '2026-03-10T12:00:00Z',
   ARRAY[
     '01H00000000000000000000001', '01H00000000000000000000002',
     '01H00000000000000000000003', '01H00000000000000000000004',
     '01H00000000000000000000005', '01H00000000000000000000006',
     '01H00000000000000000000007', '01H00000000000000000000008',
     '01H00000000000000000000009', '01H00000000000000000000010'
   ], 'PHI', ARRAY[]::text[], 'verified',
   '6e3051a2bf61928d3f3a9d7d7adbb2620a4d9359fc8cb8ac681fa2d6d1be8fbd',
   NULL, true)
ON CONFLICT (tenant_id, version_ref) DO NOTHING;

INSERT INTO analytics.projection_cell
  (tenant_id, version_ref, cell_id, member_count, measure_value, work_item_refs, synthetic)
VALUES
  ('northwind-synthetic', 'projection-seed-0001', 'a', 5, 5,
   ARRAY['work-item:source-1', 'work-item:source-2', 'work-item:source-3',
         'work-item:source-4', 'work-item:source-5'], true),
  ('northwind-synthetic', 'projection-seed-0001', 'b', 5, 5,
   ARRAY['work-item:source-10', 'work-item:source-6', 'work-item:source-7',
         'work-item:source-8', 'work-item:source-9'], true)
ON CONFLICT (tenant_id, version_ref, cell_id) DO NOTHING;

INSERT INTO analytics.projection_source_offset
  (tenant_id, version_ref, source_ref, high_water_mark, loaded_at, receipt_ref, synthetic)
VALUES
  ('northwind-synthetic', 'projection-seed-0001', 'source-a', '10',
   '2026-03-10T12:00:00Z', 'receipt:source-a:0001', true)
ON CONFLICT (tenant_id, version_ref, source_ref) DO NOTHING;

INSERT INTO analytics.projection_event
  (tenant_id, event_id, legal_entity_id, event_type, metric_id, metric_version,
   occurred_at, recorded_at, source_ref, source_offset, source_receipt_ref,
   supersedes_event_id, reversal_of_event_id, cell_id, measure_value,
   data_classification, partition_tags, work_item_refs, fact_hash, synthetic)
SELECT
  'northwind-synthetic',
  '01H0000000' || lpad(value::text, 16, '0'),
  'northwind-legal-entity-synthetic',
  'synthetic.metric-observed',
  'analytics.synthetic.completed-visits',
  1,
  '2026-03-10T12:00:00Z',
  '2026-03-10T12:00:00Z',
  'source-a',
  value::text,
  'receipt:source-a:0001',
  NULL,
  NULL,
  CASE WHEN value <= 5 THEN 'a' ELSE 'b' END,
  1,
  'PHI',
  ARRAY[]::text[],
  ARRAY['work-item:source-' || value::text],
  (ARRAY[
    '443d00bb0ee693ceb970e9009260d6e13b5370c8694411533015ac5c156dda8b',
    '9e122f53439bc03ae8dd453c0a7dee54c42c5f64835d5462ac01f563dc812319',
    '0cc4d04ed3e63cc0527624f1c28611ae3545a269baf0665e4894a5611c160011',
    'a44f908b32d0e8f5f9f2f533d779279e1cec09165c479bcd69e1ef29d95d3af7',
    '84605a68b2effa5f16bce70c0bc5314e123edede69613185016534fdac480f94',
    '1e45c2977c094afefd680305612437c3f0eeee400bce9b50ffe6da9c4654c754',
    '982e669a842dad2254f7411e5e96bec5e10c58f974e9c2988bbeb4cd7e9b2349',
    'd88dd11b0c0b8d0d13d666661553a8f2af328b3a9e5211914e6c2be286cd94db',
    '4560c60063a669683532dba9afb50961bbb086c767c76b9b3b3fcbf85f804a83',
    '90cf44653bf150de5028f30c0aedaacdb0fd5bb5c6dd18fedc092e543aa8128b'
  ])[value],
  true
FROM generate_series(1, 10) AS value
ON CONFLICT (tenant_id, metric_id, metric_version, event_id) DO NOTHING;
