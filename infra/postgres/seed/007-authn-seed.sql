-- WP-014 synthetic authn seed. Applied by `pnpm local:seed` after module
-- migrations (tables come from modules/identity/migrations/0005-authn.sql).
-- Idempotent upserts; synthetic data only. Standing proofs this seed carries:
--   * the only staff session at rest is aal2 (staff MFA structural probe in
--     `pnpm local:test`);
--   * per-role session policies live as attributed config revisions
--     (REQ-ID-024 AC-3), and Riverbend deliberately carries NONE — the
--     fail-to-stricter default is that tenant's posture;
--   * one RELEASED ATO lockdown retains its triggering signals verbatim
--     (REQ-ID-029 AC-3 forensic record) with release evidence + attribution;
--   * Riverbend's ACTIVE lockdown keeps the cross-tenant negatives exercised.

-- Per-role session policies (config data, never code; REQ-ID-024 AC-3).
INSERT INTO platform_core.tenant_config
  (tenant_id, legal_entity_id, location_id, namespace, key, value, phi_class,
   counsel_owned, change_control_ref, revision, changed_by, synthetic)
VALUES
  ('northwind-synthetic', NULL, NULL, 'policy', 'session-policy:role=front-desk',
   '{"idleTimeoutSeconds": 300, "maxConcurrentSessions": 1, "onLimitExceeded": "block-new", "maxFailedAttempts": 5, "stepUpRecencySeconds": 300}'::jsonb,
   'none', false, NULL, 1, 'synthetic-it-admin-001', true),
  ('northwind-synthetic', NULL, NULL, 'policy', 'session-policy:role=provider',
   '{"idleTimeoutSeconds": 1800, "maxConcurrentSessions": 3, "onLimitExceeded": "terminate-oldest", "maxFailedAttempts": 5, "stepUpRecencySeconds": 600}'::jsonb,
   'none', false, NULL, 1, 'synthetic-it-admin-001', true),
  ('northwind-synthetic', NULL, NULL, 'policy', 'session-policy:role=portal-member',
   '{"idleTimeoutSeconds": 900, "maxConcurrentSessions": 2, "onLimitExceeded": "terminate-oldest", "maxFailedAttempts": 3, "stepUpRecencySeconds": 300}'::jsonb,
   'none', false, NULL, 1, 'synthetic-it-admin-001', true)
ON CONFLICT ON CONSTRAINT tenant_config_scope_key DO UPDATE
SET value = EXCLUDED.value,
    phi_class = EXCLUDED.phi_class,
    counsel_owned = EXCLUDED.counsel_owned,
    change_control_ref = EXCLUDED.change_control_ref,
    changed_at = now(),
    changed_by = EXCLUDED.changed_by,
    synthetic = EXCLUDED.synthetic;

-- Alex's sole-verified portal channel: the endpoint a portal challenge may be
-- delivered to (verified association; the shared Rivera household endpoints
-- stay untouched as the WP-013 standing proof).
INSERT INTO identity.channel_endpoint
  (tenant_id, endpoint_id, kind, endpoint_value, synthetic)
VALUES
  ('northwind-synthetic', 'nce-alex-portal-email', 'email', 'alex.rivera@synthetic.invalid', true)
ON CONFLICT (tenant_id, endpoint_id) DO UPDATE
SET kind = EXCLUDED.kind,
    endpoint_value = EXCLUDED.endpoint_value,
    synthetic = EXCLUDED.synthetic;

INSERT INTO identity.endpoint_association
  (tenant_id, endpoint_id, person_id, relationship, verification, evidence_ref,
   source, consent_ref, synthetic)
VALUES
  ('northwind-synthetic', 'nce-alex-portal-email', 'np-alex-rivera', 'self', 'verified',
   'synthetic-endpoint-evidence-0002', 'synthetic-portal-enrollment', 'synthetic-consent-0001', true)
ON CONFLICT (tenant_id, endpoint_id, person_id) DO UPDATE
SET relationship = EXCLUDED.relationship,
    verification = EXCLUDED.verification,
    evidence_ref = EXCLUDED.evidence_ref,
    source = EXCLUDED.source,
    consent_ref = EXCLUDED.consent_ref,
    synthetic = EXCLUDED.synthetic;

-- Staff credentials: opaque secret references only, enrollment attributed and
-- evidenced. Morgan carries password + TOTP — the MFA pair a staff session
-- requires.
INSERT INTO identity.auth_credential
  (tenant_id, credential_id, person_id, audience, kind, status, secret_ref,
   enrolled_by, evidence_ref, synthetic)
VALUES
  ('northwind-synthetic', 'ncr-morgan-password', 'np-morgan-lee', 'staff', 'password',
   'active', 'synthetic-vault:staff-pw-0001', 'synthetic-it-admin-001',
   'synthetic-enrollment-evidence-0001', true),
  ('northwind-synthetic', 'ncr-morgan-totp', 'np-morgan-lee', 'staff', 'totp',
   'active', 'synthetic-vault:staff-totp-0001', 'synthetic-it-admin-001',
   'synthetic-enrollment-evidence-0002', true)
ON CONFLICT (tenant_id, credential_id) DO UPDATE
SET person_id = EXCLUDED.person_id,
    audience = EXCLUDED.audience,
    kind = EXCLUDED.kind,
    status = EXCLUDED.status,
    secret_ref = EXCLUDED.secret_ref,
    enrolled_by = EXCLUDED.enrolled_by,
    evidence_ref = EXCLUDED.evidence_ref,
    synthetic = EXCLUDED.synthetic;

INSERT INTO identity.auth_device
  (tenant_id, device_id, person_id, label, status, revoked_reason, first_seen_at, synthetic)
VALUES
  ('northwind-synthetic', 'nde-morgan-workstation', 'np-morgan-lee',
   'synthetic front-desk workstation', 'active', NULL, '2026-03-01T08:00:00Z', true),
  ('northwind-synthetic', 'nde-alex-phone', 'np-alex-rivera',
   'synthetic member phone', 'active', NULL, '2026-03-02T18:00:00Z', true)
ON CONFLICT (tenant_id, device_id) DO UPDATE
SET person_id = EXCLUDED.person_id,
    label = EXCLUDED.label,
    status = EXCLUDED.status,
    revoked_reason = EXCLUDED.revoked_reason,
    first_seen_at = EXCLUDED.first_seen_at,
    synthetic = EXCLUDED.synthetic;

-- Server-side sessions: the staff session is aal2 (the structural MFA CHECK
-- and the local:test probe both read this); the portal session is aal1 with a
-- recorded step-up.
INSERT INTO identity.auth_session
  (tenant_id, session_id, person_id, principal, staff_account_id, device_id,
   assurance, status, created_at, last_activity_at, step_up_at, revoked_reason, synthetic)
VALUES
  ('northwind-synthetic', 'nsn-morgan-0001', 'np-morgan-lee', 'staff', 'nsa-morgan-lee',
   'nde-morgan-workstation', 'aal2', 'active',
   '2026-03-05T08:00:00Z', '2026-03-05T08:20:00Z', NULL, NULL, true),
  ('northwind-synthetic', 'nsn-alex-0001', 'np-alex-rivera', 'portal', NULL,
   'nde-alex-phone', 'aal1', 'active',
   '2026-03-05T18:00:00Z', '2026-03-05T18:05:00Z', '2026-03-05T18:04:00Z', NULL, true)
ON CONFLICT (tenant_id, session_id) DO UPDATE
SET person_id = EXCLUDED.person_id,
    principal = EXCLUDED.principal,
    staff_account_id = EXCLUDED.staff_account_id,
    device_id = EXCLUDED.device_id,
    assurance = EXCLUDED.assurance,
    status = EXCLUDED.status,
    created_at = EXCLUDED.created_at,
    last_activity_at = EXCLUDED.last_activity_at,
    step_up_at = EXCLUDED.step_up_at,
    revoked_reason = EXCLUDED.revoked_reason,
    synthetic = EXCLUDED.synthetic;

-- A consumed portal-login challenge over the verified channel (single-use,
-- expiring, attempt-bounded by construction).
INSERT INTO identity.auth_challenge
  (tenant_id, challenge_id, person_id, endpoint_id, purpose, method,
   issued_at, expires_at, consumed_at, attempt_count, max_attempts, synthetic)
VALUES
  ('northwind-synthetic', 'nch-alex-login-0001', 'np-alex-rivera', 'nce-alex-portal-email',
   'portal-login', 'magic-link', '2026-03-05T17:58:00Z', '2026-03-05T18:08:00Z',
   '2026-03-05T18:00:00Z', 1, 3, true),
  ('northwind-synthetic', 'nch-alex-stepup-0001', 'np-alex-rivera', 'nce-alex-portal-email',
   'step-up', 'otp', '2026-03-05T18:03:00Z', '2026-03-05T18:13:00Z',
   '2026-03-05T18:04:00Z', 1, 3, true)
ON CONFLICT (tenant_id, challenge_id) DO UPDATE
SET person_id = EXCLUDED.person_id,
    endpoint_id = EXCLUDED.endpoint_id,
    purpose = EXCLUDED.purpose,
    method = EXCLUDED.method,
    issued_at = EXCLUDED.issued_at,
    expires_at = EXCLUDED.expires_at,
    consumed_at = EXCLUDED.consumed_at,
    attempt_count = EXCLUDED.attempt_count,
    max_attempts = EXCLUDED.max_attempts,
    synthetic = EXCLUDED.synthetic;

-- Lockdown cases: Northwind's is RELEASED with evidence + attribution and the
-- triggering signals retained verbatim (forensic record); Riverbend's stays
-- ACTIVE — opposite-posture data the cross-tenant negatives read.
INSERT INTO identity.account_lockdown
  (tenant_id, lockdown_id, person_id, trigger_kind, signals, high_risk_frozen,
   notified_endpoint_id, notification_fallback, status, release_requirement,
   released_by, released_evidence_ref, synthetic)
VALUES
  ('northwind-synthetic', 'nld-alex-0001', 'np-alex-rivera', 'ato-suspicion',
   '[{"kind": "new-device-burst", "detail": "synthetic: 4 new devices in one window", "observedAt": "2026-03-04T02:10:00Z"}]'::jsonb,
   true, 'nce-alex-portal-email', false, 'released', 'step-up',
   'synthetic-it-admin-001', 'synthetic-stepup-evidence-0001', true),
  ('riverbend-synthetic', 'rld-taylor-0001', 'rb-taylor-quinn', 'failed-attempts',
   '[{"kind": "mass-failed-logins", "detail": "synthetic: threshold reached", "observedAt": "2026-03-04T03:00:00Z"}]'::jsonb,
   true, NULL, false, 'active', 'step-up', NULL, NULL, true)
ON CONFLICT (tenant_id, lockdown_id) DO UPDATE
SET person_id = EXCLUDED.person_id,
    trigger_kind = EXCLUDED.trigger_kind,
    signals = EXCLUDED.signals,
    high_risk_frozen = EXCLUDED.high_risk_frozen,
    notified_endpoint_id = EXCLUDED.notified_endpoint_id,
    notification_fallback = EXCLUDED.notification_fallback,
    status = EXCLUDED.status,
    release_requirement = EXCLUDED.release_requirement,
    released_by = EXCLUDED.released_by,
    released_evidence_ref = EXCLUDED.released_evidence_ref,
    synthetic = EXCLUDED.synthetic;
