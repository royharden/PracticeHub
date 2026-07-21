-- WP-013 synthetic identity seed. Applied by `pnpm local:seed` after module
-- migrations (tables come from modules/identity/migrations/0004-identity.sql).
-- Idempotent upserts; synthetic data only. The Rivera household endpoints are
-- the STANDING shared-endpoint proof: one phone and one email each attach to
-- two distinct persons who must never merge on endpoint equality
-- (REQ-ID-017); Riverbend rows keep the cross-tenant negatives exercised.

INSERT INTO identity.person
  (tenant_id, person_id, status, verification_evidence_ref, birth_date,
   provenance_source, captured_by, consent_ref, synthetic)
VALUES
  ('northwind-synthetic', 'np-alex-rivera', 'verified', 'synthetic-idproof-0001', '1980-03-14',
   'synthetic-intake', 'synthetic-front-desk-001', 'synthetic-consent-0001', true),
  ('northwind-synthetic', 'np-casey-rivera', 'provisional', NULL, '2011-06-02',
   'synthetic-intake', 'synthetic-front-desk-001', 'synthetic-consent-0002', true),
  ('northwind-synthetic', 'np-jordan-kim', 'provisional', NULL, NULL,
   'synthetic-crm-import', 'synthetic-marketing-import', NULL, true),
  ('northwind-synthetic', 'np-morgan-lee', 'verified', 'synthetic-idproof-0002', NULL,
   'synthetic-staff-onboarding', 'synthetic-it-admin-001', NULL, true),
  ('riverbend-synthetic', 'rb-taylor-quinn', 'provisional', NULL, NULL,
   'synthetic-intake', 'synthetic-front-desk-101', NULL, true)
ON CONFLICT (tenant_id, person_id) DO UPDATE
SET status = EXCLUDED.status,
    verification_evidence_ref = EXCLUDED.verification_evidence_ref,
    birth_date = EXCLUDED.birth_date,
    provenance_source = EXCLUDED.provenance_source,
    captured_by = EXCLUDED.captured_by,
    consent_ref = EXCLUDED.consent_ref,
    synthetic = EXCLUDED.synthetic;

-- Affirmed vs legal name pair on one person (REQ-ID-015): distinct facts,
-- one identity, no second patient.
INSERT INTO identity.person_name
  (tenant_id, person_id, name_kind, revision, given_name, family_name,
   effective_date, source, unsafe_contexts, synthetic)
VALUES
  ('northwind-synthetic', 'np-alex-rivera', 'affirmed', 1, 'Alex', 'Rivera',
   '2026-01-05', 'synthetic-patient-update', '{}', true),
  ('northwind-synthetic', 'np-alex-rivera', 'legal', 1, 'Alexander', 'Rivera',
   NULL, 'synthetic-intake', '{}', true),
  ('northwind-synthetic', 'np-casey-rivera', 'legal', 1, 'Casey', 'Rivera',
   NULL, 'synthetic-intake', '{}', true),
  ('northwind-synthetic', 'np-jordan-kim', 'legal', 1, 'Jordan', 'Kim',
   NULL, 'synthetic-crm-import', '{}', true),
  ('northwind-synthetic', 'np-morgan-lee', 'legal', 1, 'Morgan', 'Lee',
   NULL, 'synthetic-staff-onboarding', '{}', true),
  ('riverbend-synthetic', 'rb-taylor-quinn', 'legal', 1, 'Taylor', 'Quinn',
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
  ('northwind-synthetic', 'npr-alex-rivera', 'np-alex-rivera', 'northwind-health-nv',
   'northwind-nv-henderson', 'active', true),
  ('northwind-synthetic', 'npr-casey-rivera', 'np-casey-rivera', 'northwind-health-nv',
   'northwind-nv-henderson', 'active', true),
  ('riverbend-synthetic', 'rbr-taylor-quinn', 'rb-taylor-quinn', 'riverbend-medical-il',
   'riverbend-chicago-loop', 'active', true)
ON CONFLICT (tenant_id, patient_record_id) DO UPDATE
SET person_id = EXCLUDED.person_id,
    legal_entity_id = EXCLUDED.legal_entity_id,
    home_location_id = EXCLUDED.home_location_id,
    status = EXCLUDED.status,
    synthetic = EXCLUDED.synthetic;

INSERT INTO identity.staff_account
  (tenant_id, staff_account_id, person_id, status, synthetic)
VALUES
  ('northwind-synthetic', 'nsa-morgan-lee', 'np-morgan-lee', 'active', true)
ON CONFLICT (tenant_id, staff_account_id) DO UPDATE
SET person_id = EXCLUDED.person_id,
    status = EXCLUDED.status,
    synthetic = EXCLUDED.synthetic;

INSERT INTO identity.guarantor_role
  (tenant_id, guarantor_role_id, guarantor_person_id, patient_record_id, scope,
   evidence_ref, status, ended_reason, synthetic)
VALUES
  ('northwind-synthetic', 'ngr-alex-for-casey', 'np-alex-rivera', 'npr-casey-rivera',
   '{statements,payment-methods}', 'synthetic-guarantor-evidence-0001', 'active', NULL, true)
ON CONFLICT (tenant_id, guarantor_role_id) DO UPDATE
SET guarantor_person_id = EXCLUDED.guarantor_person_id,
    patient_record_id = EXCLUDED.patient_record_id,
    scope = EXCLUDED.scope,
    evidence_ref = EXCLUDED.evidence_ref,
    status = EXCLUDED.status,
    ended_reason = EXCLUDED.ended_reason,
    synthetic = EXCLUDED.synthetic;

INSERT INTO identity.proxy_grant
  (tenant_id, proxy_grant_id, grantee_person_id, subject_person_id, scope,
   expires_on, evidence_ref, status, synthetic)
VALUES
  ('northwind-synthetic', 'npx-alex-for-casey', 'np-alex-rivera', 'np-casey-rivera',
   '{scheduling,messaging}', '2029-06-02', 'synthetic-proxy-evidence-0001', 'active', true)
ON CONFLICT (tenant_id, proxy_grant_id) DO UPDATE
SET grantee_person_id = EXCLUDED.grantee_person_id,
    subject_person_id = EXCLUDED.subject_person_id,
    scope = EXCLUDED.scope,
    expires_on = EXCLUDED.expires_on,
    evidence_ref = EXCLUDED.evidence_ref,
    status = EXCLUDED.status,
    synthetic = EXCLUDED.synthetic;

INSERT INTO identity.channel_endpoint
  (tenant_id, endpoint_id, kind, endpoint_value, synthetic)
VALUES
  ('northwind-synthetic', 'nce-rivera-phone', 'phone', '+15550100001', true),
  ('northwind-synthetic', 'nce-rivera-email', 'email', 'rivera-family@synthetic.invalid', true),
  ('riverbend-synthetic', 'rce-quinn-phone', 'phone', '+15550100002', true)
ON CONFLICT (tenant_id, endpoint_id) DO UPDATE
SET kind = EXCLUDED.kind,
    endpoint_value = EXCLUDED.endpoint_value,
    synthetic = EXCLUDED.synthetic;

-- Two persons on one phone and one email; per-person attribution retained.
INSERT INTO identity.endpoint_association
  (tenant_id, endpoint_id, person_id, relationship, verification, evidence_ref,
   source, consent_ref, synthetic)
VALUES
  ('northwind-synthetic', 'nce-rivera-phone', 'np-alex-rivera', 'self', 'verified',
   'synthetic-endpoint-evidence-0001', 'synthetic-intake', 'synthetic-consent-0001', true),
  ('northwind-synthetic', 'nce-rivera-phone', 'np-casey-rivera', 'household', 'asserted',
   NULL, 'synthetic-intake', 'synthetic-consent-0002', true),
  ('northwind-synthetic', 'nce-rivera-email', 'np-alex-rivera', 'self', 'asserted',
   NULL, 'synthetic-web-form', 'synthetic-consent-0001', true),
  ('northwind-synthetic', 'nce-rivera-email', 'np-casey-rivera', 'household', 'asserted',
   NULL, 'synthetic-web-form', NULL, true),
  ('riverbend-synthetic', 'rce-quinn-phone', 'rb-taylor-quinn', 'self', 'asserted',
   NULL, 'synthetic-intake', NULL, true)
ON CONFLICT (tenant_id, endpoint_id, person_id) DO UPDATE
SET relationship = EXCLUDED.relationship,
    verification = EXCLUDED.verification,
    evidence_ref = EXCLUDED.evidence_ref,
    source = EXCLUDED.source,
    consent_ref = EXCLUDED.consent_ref,
    synthetic = EXCLUDED.synthetic;

-- Crosswalk: athena + acquired-legacy + CRM + opaque Stripe reference all
-- resolving to their one person (REQ-ID-004 / REQ-ID-005).
INSERT INTO identity.source_identifier
  (tenant_id, source_system, source_value, person_id, patient_record_id,
   verification, evidence_ref, provenance_source, ingest_ref, synthetic)
VALUES
  ('northwind-synthetic', 'athena', 'ath-100234', 'np-alex-rivera', 'npr-alex-rivera',
   'verified', 'synthetic-crosswalk-evidence-0001', 'synthetic-athena-adapter',
   'synthetic-ingest-0001', true),
  ('northwind-synthetic', 'stripe', 'cus_synthetic0001', 'np-alex-rivera', NULL,
   'asserted', NULL, 'synthetic-stripe-webhook', 'synthetic-ingest-0002', true),
  ('northwind-synthetic', 'hubspot', 'hs-88121', 'np-jordan-kim', NULL,
   'asserted', NULL, 'synthetic-crm-import', 'synthetic-ingest-0003', true),
  ('northwind-synthetic', 'legacy-lakeside', 'lg-000441', 'np-casey-rivera', 'npr-casey-rivera',
   'asserted', NULL, 'synthetic-acquisition-import', 'synthetic-ingest-0004', true),
  ('riverbend-synthetic', 'athena', 'ath-770001', 'rb-taylor-quinn', 'rbr-taylor-quinn',
   'asserted', NULL, 'synthetic-athena-adapter', 'synthetic-ingest-0101', true)
ON CONFLICT (tenant_id, source_system, source_value) DO UPDATE
SET person_id = EXCLUDED.person_id,
    patient_record_id = EXCLUDED.patient_record_id,
    verification = EXCLUDED.verification,
    evidence_ref = EXCLUDED.evidence_ref,
    provenance_source = EXCLUDED.provenance_source,
    ingest_ref = EXCLUDED.ingest_ref,
    synthetic = EXCLUDED.synthetic;

-- Timeline is append-only: seed entries insert once and are never rewritten.
INSERT INTO identity.identity_timeline
  (tenant_id, entry_id, person_id, entry_kind, actor_ref, location_id, source,
   occurred_at, detail, synthetic)
VALUES
  ('northwind-synthetic', 'nti-0001', 'np-alex-rivera', 'registered',
   'synthetic-front-desk-001', 'northwind-nv-henderson', 'synthetic-intake',
   '2026-01-05T09:00:00Z', 'synthetic registration', true),
  ('northwind-synthetic', 'nti-0002', 'np-alex-rivera', 'cross-location-encounter',
   'synthetic-provider-001', 'northwind-fl-coral-gables', 'synthetic-scheduling',
   '2026-02-10T15:30:00Z', 'synthetic cross-location visit', true),
  ('northwind-synthetic', 'nti-0003', 'np-casey-rivera', 'registered',
   'synthetic-front-desk-001', 'northwind-nv-henderson', 'synthetic-intake',
   '2026-01-05T09:10:00Z', 'synthetic registration', true),
  ('riverbend-synthetic', 'rti-0001', 'rb-taylor-quinn', 'registered',
   'synthetic-front-desk-101', 'riverbend-chicago-loop', 'synthetic-intake',
   '2026-01-06T10:00:00Z', 'synthetic registration', true)
ON CONFLICT (tenant_id, entry_id) DO NOTHING;
