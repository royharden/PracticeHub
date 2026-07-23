-- WP-017 synthetic elevation seed. Applied by `pnpm local:seed` after module
-- migrations (tables come from modules/identity/migrations/0013-elevation.sql).
-- Idempotent; synthetic data only. Standing proofs this seed carries:
--   * a REVIEWED break-glass grant (nbg-0001, active) beside an UNREVIEWED one
--     (nbg-0002, expired) — the review queue: one grant has its independent
--     review (reviewer <> accessor), one is still awaiting it (R6-REQ-003);
--   * a planned offboarding (noff-0001) with two reassignments AND an abrupt
--     provider departure (noff-0002) whose revoked_scopes carry the EPCS token
--     (REQ-ID-028), each reassignment carrying a context package;
--   * an OPEN snooping investigation (nac-0001, signals recorded verbatim)
--     beside a REMEDIATED one (nac-0002) — REQ-ADM-019;
--   * a REVOKED recertification attestation (nrc-0001) beside a CONFIRMED one
--     (nrc-0002) — REQ-ADM-018;
--   * Riverbend rows (a break-glass grant + an anomaly case) for the
--     cross-tenant negatives; the identity.break-glass capability sits at the
--     package ceiling scaffolded (northwind) / disabled (Riverbend).

-- A Riverbend staff account (rb-taylor-quinn as staff) so the cross-tenant
-- break-glass negative has a valid FK target on tenant 2.
INSERT INTO identity.staff_account
  (tenant_id, staff_account_id, person_id, status, synthetic)
VALUES
  ('riverbend-synthetic', 'rsa-taylor-quinn', 'rb-taylor-quinn', 'active', true)
ON CONFLICT (tenant_id, staff_account_id) DO UPDATE
SET person_id = EXCLUDED.person_id,
    status = EXCLUDED.status,
    synthetic = EXCLUDED.synthetic;

-- Break-glass grants: an active reviewed one and an expired unreviewed one on
-- Northwind; one on Riverbend for the cross-tenant negative. Append-only.
INSERT INTO identity.break_glass_grant
  (tenant_id, grant_id, staff_account_id, accessor_person_id, subject_person_id,
   scope, reason_code, justification_ref, severity, initiated_by, effective_at,
   expires_at, review_due_at, synthetic)
VALUES
  ('northwind-synthetic', 'nbg-0001', 'nsa-morgan-lee', 'np-morgan-lee', 'np-alex-rivera',
   '["clinical-notes","results"]'::jsonb, 'emergency-care',
   'synthetic-break-glass-reason-0001', 'standard', 'synthetic-it-admin-001',
   '2026-03-25T10:00:00Z', '2026-03-25T11:00:00Z', '2026-03-26T11:00:00Z', true),
  ('northwind-synthetic', 'nbg-0002', 'nsa-morgan-lee', 'np-morgan-lee', 'np-casey-rivera',
   '["genetic"]'::jsonb, 'patient-safety',
   'synthetic-break-glass-reason-0002', 'elevated-genetic', 'synthetic-it-admin-001',
   '2026-03-20T14:00:00Z', '2026-03-20T15:00:00Z', '2026-03-21T15:00:00Z', true),
  ('riverbend-synthetic', 'rbg-0101', 'rsa-taylor-quinn', 'rb-taylor-quinn', 'rb-taylor-quinn',
   '["scheduling"]'::jsonb, 'coverage-gap',
   'synthetic-break-glass-reason-0101', 'standard', 'synthetic-it-admin-101',
   '2026-03-25T10:00:00Z', '2026-03-25T10:30:00Z', '2026-03-26T10:30:00Z', true)
ON CONFLICT (tenant_id, grant_id) DO NOTHING;

-- The independent review for nbg-0001 (reviewer np-jordan-kim <> accessor
-- np-morgan-lee). nbg-0002 deliberately has NO review — the standing
-- "unreviewed break-glass ages on the worklist" proof.
INSERT INTO identity.break_glass_review
  (tenant_id, review_id, grant_id, subject_person_id, accessor_person_id,
   reviewer_person_id, reviewer_role, outcome, evidence_ref, reviewed_at, synthetic)
VALUES
  ('northwind-synthetic', 'nbgr-0001', 'nbg-0001', 'np-alex-rivera', 'np-morgan-lee',
   'np-jordan-kim', 'compliance-privacy-officer', 'access-appropriate',
   'synthetic-review-evidence-0001', '2026-03-26T09:00:00Z', true)
ON CONFLICT (tenant_id, review_id) DO NOTHING;

-- Offboarding cases: a planned one and an abrupt provider departure (EPCS
-- token revoked). Append-only.
INSERT INTO identity.offboarding_case
  (tenant_id, offboarding_id, staff_account_id, staff_person_id, kind, reason_ref,
   revoked_scopes, evidence_ref, executed_by, executed_at, synthetic)
VALUES
  ('northwind-synthetic', 'noff-0001', 'nsa-morgan-lee', 'np-morgan-lee', 'planned',
   'synthetic-offboarding-reason-0001',
   ARRAY['sessions', 'role-grants', 'on-call-slots', 'device-tokens']::text[],
   'synthetic-offboarding-evidence-0001', 'synthetic-it-admin-001',
   '2026-03-25T17:00:00Z', true),
  ('northwind-synthetic', 'noff-0002', 'nsa-morgan-lee', 'np-morgan-lee', 'abrupt-departure',
   'synthetic-offboarding-reason-0002',
   ARRAY['sessions', 'credentials', 'epcs-token', 'on-call-slots', 'device-tokens']::text[],
   'synthetic-offboarding-evidence-0002', 'synthetic-it-admin-001',
   '2026-03-22T08:00:00Z', true)
ON CONFLICT (tenant_id, offboarding_id) DO NOTHING;

-- One reassignment per owned item, each carrying a context package. Append-only.
INSERT INTO identity.offboarding_reassignment
  (tenant_id, reassignment_id, offboarding_id, owned_ref, owned_kind, to_owner_ref,
   context_package_ref, synthetic)
VALUES
  ('northwind-synthetic', 'noff-0001-ra-0', 'noff-0001', 'thread:th-0001', 'thread',
   'staff-account:nsa-morgan-lee', 'synthetic-context-package-0001', true),
  ('northwind-synthetic', 'noff-0001-ra-1', 'noff-0001', 'panel:pn-north', 'panel',
   'staff-account:nsa-morgan-lee', 'synthetic-context-package-0002', true),
  ('northwind-synthetic', 'noff-0002-ra-0', 'noff-0002', 'oncall:slot-weekend', 'on-call-slot',
   'staff-account:nsa-morgan-lee', 'synthetic-context-package-0003', true)
ON CONFLICT (tenant_id, reassignment_id) DO NOTHING;

-- Access-anomaly investigations: an OPEN snooping case (signals verbatim) on
-- Northwind, a REMEDIATED one, and an open one on Riverbend. The case record
-- resolves (UPDATE) but never vanishes (DELETE revoked).
INSERT INTO identity.access_anomaly_case
  (tenant_id, anomaly_id, pattern, subject_staff_person_id, signals, detected_at,
   status, containment_ref, disposition, remediation_evidence_ref, resolved_by, synthetic)
VALUES
  ('northwind-synthetic', 'nac-0001', 'snooping-access', 'np-morgan-lee',
   '[{"signalRef":"sig-0001","detail":"access:acc-9001:clinical-notes","observedAt":"2026-03-24T10:00:00Z"}]'::jsonb,
   '2026-03-24T11:00:00Z', 'open', NULL, NULL, NULL, NULL, true),
  ('northwind-synthetic', 'nac-0002', 'credential-sharing', 'np-morgan-lee',
   '[{"signalRef":"sig-0002","detail":"credential-sharing:2-locations","observedAt":"2026-03-23T10:00:00Z"}]'::jsonb,
   '2026-03-23T11:00:00Z', 'remediated', 'synthetic-rate-limit-0001', 'confirmed-violation',
   'synthetic-remediation-evidence-0001', 'synthetic-compliance-officer-001', true),
  ('riverbend-synthetic', 'rac-0101', 'concurrent-session', 'rb-taylor-quinn',
   '[{"signalRef":"sig-0101","detail":"concurrent-devices:4","observedAt":"2026-03-24T10:00:00Z"}]'::jsonb,
   '2026-03-24T11:00:00Z', 'open', NULL, NULL, NULL, NULL, true)
ON CONFLICT (tenant_id, anomaly_id) DO UPDATE
SET pattern = EXCLUDED.pattern,
    subject_staff_person_id = EXCLUDED.subject_staff_person_id,
    signals = EXCLUDED.signals,
    detected_at = EXCLUDED.detected_at,
    status = EXCLUDED.status,
    containment_ref = EXCLUDED.containment_ref,
    disposition = EXCLUDED.disposition,
    remediation_evidence_ref = EXCLUDED.remediation_evidence_ref,
    resolved_by = EXCLUDED.resolved_by,
    synthetic = EXCLUDED.synthetic;

-- Recertification attestations: one REVOKED (drift remediated) and one
-- CONFIRMED. Append-only evidence of the periodic access review workflow.
INSERT INTO identity.access_recertification
  (tenant_id, attestation_id, cycle_ref, staff_account_id, grant_ref, attester_person_id,
   attester_role, decision, evidence_ref, attested_at, synthetic)
VALUES
  ('northwind-synthetic', 'nrc-0001', 'recert-2026q1', 'nsa-morgan-lee',
   'practicehub:medications:edit', 'np-taylor-manager', 'practice-manager', 'revoked',
   'synthetic-attestation-evidence-0001', '2026-03-26T09:00:00Z', true),
  ('northwind-synthetic', 'nrc-0002', 'recert-2026q1', 'nsa-morgan-lee',
   'practicehub:scheduling:view', 'np-taylor-manager', 'practice-manager', 'confirmed',
   'synthetic-attestation-evidence-0002', '2026-03-26T09:05:00Z', true)
ON CONFLICT (tenant_id, attestation_id) DO NOTHING;
