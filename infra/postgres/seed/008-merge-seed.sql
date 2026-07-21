-- WP-016 synthetic merge-governance seed. Applied by `pnpm local:seed` after
-- module migrations (tables come from modules/identity/migrations/0006-merge.sql).
-- Idempotent; synthetic data only. Standing proofs this seed carries:
--   * a RESOLVED acquisition merge (Sam Porter): the merged-away legacy alias
--     stays resolvable to the survivor and its lineage row exists — aliases
--     preserved, merge reversible (REQ-ID-009 AC-2, REQ-ID-026 AC-2);
--   * an OPEN specialized-pattern collision (Jordan Kim × Alex Rivera):
--     quarantined, attribute NAMES only, automated outreach suppressed while
--     unresolved (REQ-ID-009 AC-1 + exception);
--   * a Riverbend open case keeping the cross-tenant negatives exercised.
-- Events and lineage insert with ON CONFLICT DO NOTHING — append-only history
-- is never rewritten by a re-seed.

-- The acquisition pair: the survivor is verified; the legacy identity arrived
-- provisional from the acquired clinic and was merged after governed review.
INSERT INTO identity.person
  (tenant_id, person_id, status, verification_evidence_ref, birth_date,
   provenance_source, captured_by, consent_ref, synthetic)
VALUES
  ('northwind-synthetic', 'np-sam-porter', 'verified', 'synthetic-idproof-0003', '1975-09-21',
   'synthetic-intake', 'synthetic-front-desk-001', 'synthetic-consent-0003', true),
  ('northwind-synthetic', 'np-sam-porter-legacy', 'provisional', NULL, '1975-09-21',
   'synthetic-acquisition-import', 'synthetic-migration-workbench', NULL, true),
  ('riverbend-synthetic', 'rb-drew-quinn', 'provisional', NULL, NULL,
   'synthetic-intake', 'synthetic-front-desk-101', NULL, true)
ON CONFLICT (tenant_id, person_id) DO UPDATE
SET status = EXCLUDED.status,
    verification_evidence_ref = EXCLUDED.verification_evidence_ref,
    birth_date = EXCLUDED.birth_date,
    provenance_source = EXCLUDED.provenance_source,
    captured_by = EXCLUDED.captured_by,
    consent_ref = EXCLUDED.consent_ref,
    synthetic = EXCLUDED.synthetic;

INSERT INTO identity.person_name
  (tenant_id, person_id, name_kind, revision, given_name, family_name,
   effective_date, source, unsafe_contexts, synthetic)
VALUES
  ('northwind-synthetic', 'np-sam-porter', 'legal', 1, 'Sam', 'Porter',
   NULL, 'synthetic-intake', '{}', true),
  ('northwind-synthetic', 'np-sam-porter-legacy', 'legal', 1, 'Sam', 'Porter',
   NULL, 'synthetic-acquisition-import', '{}', true),
  ('riverbend-synthetic', 'rb-drew-quinn', 'legal', 1, 'Drew', 'Quinn',
   NULL, 'synthetic-intake', '{}', true)
ON CONFLICT (tenant_id, person_id, name_kind, revision) DO UPDATE
SET given_name = EXCLUDED.given_name,
    family_name = EXCLUDED.family_name,
    effective_date = EXCLUDED.effective_date,
    source = EXCLUDED.source,
    unsafe_contexts = EXCLUDED.unsafe_contexts,
    synthetic = EXCLUDED.synthetic;

INSERT INTO identity.patient_record
  (tenant_id, patient_record_id, person_id, legal_entity_id, home_location_id, status, synthetic)
VALUES
  ('northwind-synthetic', 'npr-sam-porter', 'np-sam-porter', 'northwind-health-nv',
   'northwind-nv-henderson', 'active', true)
ON CONFLICT (tenant_id, patient_record_id) DO UPDATE
SET person_id = EXCLUDED.person_id,
    legal_entity_id = EXCLUDED.legal_entity_id,
    home_location_id = EXCLUDED.home_location_id,
    status = EXCLUDED.status,
    synthetic = EXCLUDED.synthetic;

-- The merged-away legacy alias, preserved and resolving to the SURVIVOR —
-- the standing alias-preservation proof local:test asserts.
INSERT INTO identity.source_identifier
  (tenant_id, source_system, source_value, person_id, patient_record_id,
   verification, evidence_ref, provenance_source, ingest_ref, synthetic)
VALUES
  ('northwind-synthetic', 'legacy-lakeside', 'lg-000778', 'np-sam-porter', 'npr-sam-porter',
   'verified', 'synthetic-merge-evidence-0001', 'synthetic-acquisition-import',
   'synthetic-ingest-0005', true)
ON CONFLICT (tenant_id, source_system, source_value) DO UPDATE
SET person_id = EXCLUDED.person_id,
    patient_record_id = EXCLUDED.patient_record_id,
    verification = EXCLUDED.verification,
    evidence_ref = EXCLUDED.evidence_ref,
    provenance_source = EXCLUDED.provenance_source,
    ingest_ref = EXCLUDED.ingest_ref,
    synthetic = EXCLUDED.synthetic;

-- Case 1 (resolved): the acquisition possible-match, resolved MERGED after
-- governed review — attributed, evidenced, naming its merge event.
-- Case 2 (open): a specialized-pattern collision — quarantined, attribute
-- names only, outreach suppressed while unresolved.
INSERT INTO identity.merge_case
  (tenant_id, case_id, kind, status, matched_attributes, conflicting_attributes,
   confidence, contact_risk, pending_operations, source_id_refs,
   specialized_patterns, opened_by, source, resolved_kind, resolved_by,
   resolved_reason, resolution_evidence_ref, specialized_checks_ref,
   do_not_reflag, merge_event_id, synthetic)
VALUES
  ('northwind-synthetic', 'nmc-0001', 'possible-match', 'resolved-merged',
   '{given-name,family-name,birth-date}', '{}', 'high', false, '{}',
   '{legacy-lakeside:lg-000778}', '{}', 'synthetic-migration-workbench',
   'synthetic-acquisition-import', 'merged', 'synthetic-data-migration-001',
   'synthetic acquisition duplicate confirmed on name and birth date',
   'synthetic-merge-evidence-0001', NULL, false, 'nme-0001', true),
  ('northwind-synthetic', 'nmc-0002', 'staff-flagged-duplicate', 'open',
   '{email,postal-address}', '{birth-date}', 'low', true,
   '{synthetic-crm-campaign-0001}', '{hubspot:hs-88121}',
   '{shared-household-contact,duplicate-payment-rail-email}',
   'synthetic-front-desk-001', 'synthetic-crm-import', NULL, NULL, NULL, NULL,
   NULL, false, NULL, true),
  ('riverbend-synthetic', 'rmc-0001', 'possible-match', 'open',
   '{family-name,phone}', '{}', 'medium', false, '{}', '{}', '{}',
   'synthetic-front-desk-101', 'synthetic-intake', NULL, NULL, NULL, NULL,
   NULL, false, NULL, true)
ON CONFLICT (tenant_id, case_id) DO UPDATE
SET kind = EXCLUDED.kind,
    status = EXCLUDED.status,
    matched_attributes = EXCLUDED.matched_attributes,
    conflicting_attributes = EXCLUDED.conflicting_attributes,
    confidence = EXCLUDED.confidence,
    contact_risk = EXCLUDED.contact_risk,
    pending_operations = EXCLUDED.pending_operations,
    source_id_refs = EXCLUDED.source_id_refs,
    specialized_patterns = EXCLUDED.specialized_patterns,
    opened_by = EXCLUDED.opened_by,
    source = EXCLUDED.source,
    resolved_kind = EXCLUDED.resolved_kind,
    resolved_by = EXCLUDED.resolved_by,
    resolved_reason = EXCLUDED.resolved_reason,
    resolution_evidence_ref = EXCLUDED.resolution_evidence_ref,
    specialized_checks_ref = EXCLUDED.specialized_checks_ref,
    do_not_reflag = EXCLUDED.do_not_reflag,
    merge_event_id = EXCLUDED.merge_event_id,
    synthetic = EXCLUDED.synthetic;

INSERT INTO identity.merge_case_person (tenant_id, case_id, person_id, synthetic)
VALUES
  ('northwind-synthetic', 'nmc-0001', 'np-sam-porter', true),
  ('northwind-synthetic', 'nmc-0001', 'np-sam-porter-legacy', true),
  ('northwind-synthetic', 'nmc-0002', 'np-jordan-kim', true),
  ('northwind-synthetic', 'nmc-0002', 'np-alex-rivera', true),
  ('riverbend-synthetic', 'rmc-0001', 'rb-taylor-quinn', true),
  ('riverbend-synthetic', 'rmc-0001', 'rb-drew-quinn', true)
ON CONFLICT (tenant_id, case_id, person_id) DO UPDATE
SET synthetic = EXCLUDED.synthetic;

-- Append-only history: never rewritten by a re-seed.
INSERT INTO identity.merge_event
  (tenant_id, event_id, case_id, kind, survivor_person_id, merged_person_id,
   basis_attributes, decided_by, rationale, evidence_ref, reverses_event_id,
   occurred_at, synthetic)
VALUES
  ('northwind-synthetic', 'nme-0001', 'nmc-0001', 'merge', 'np-sam-porter',
   'np-sam-porter-legacy', '{given-name,family-name,birth-date}',
   'synthetic-data-migration-001',
   'synthetic acquisition duplicate confirmed on name and birth date',
   'synthetic-merge-evidence-0001', NULL, '2026-03-12T10:00:00Z', true)
ON CONFLICT (tenant_id, event_id) DO NOTHING;

INSERT INTO identity.merge_lineage
  (tenant_id, lineage_id, event_id, artifact_kind, artifact_ref,
   from_person_id, to_person_id, disposition, synthetic)
VALUES
  ('northwind-synthetic', 'nml-0001', 'nme-0001', 'source-identifier',
   'legacy-lakeside:lg-000778', 'np-sam-porter-legacy', 'np-sam-porter',
   're-attributed', true),
  ('northwind-synthetic', 'nml-0002', 'nme-0001', 'person-name',
   'legacy-name-sam-porter', 'np-sam-porter-legacy', 'np-sam-porter',
   're-attributed', true),
  ('northwind-synthetic', 'nml-0003', 'nme-0001', 'timeline-entry',
   'nti-sam-legacy-registered', 'np-sam-porter-legacy', 'np-sam-porter',
   're-attributed', true)
ON CONFLICT (tenant_id, lineage_id) DO NOTHING;

-- The open collision ties into the append-only timeline (REQ-ID-005 AC-3).
INSERT INTO identity.identity_timeline
  (tenant_id, entry_id, person_id, entry_kind, actor_ref, location_id, source,
   occurred_at, detail, synthetic)
VALUES
  ('northwind-synthetic', 'nti-0004', 'np-jordan-kim', 'review-opened',
   'synthetic-front-desk-001', 'northwind-nv-henderson', 'synthetic-crm-import',
   '2026-03-14T11:00:00Z', 'synthetic merge case nmc-0002 opened', true)
ON CONFLICT (tenant_id, entry_id) DO NOTHING;
