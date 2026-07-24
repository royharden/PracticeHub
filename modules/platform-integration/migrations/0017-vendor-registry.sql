-- WP-026 platform-integration migration (M07: the vendor registry the runtime
-- vendor-BAA egress guard reads, its append-only lifecycle log, the egress
-- decision activity feed, and the content-license gate). Contract:
-- docs/contracts/adapter-registry-api.md (FROZEN). Architecture: ADR-014
-- (adapter framework + vendor-BAA guard). Compliance: R6-REQ-008 (BAA inventory
-- registry), R6-REQ-009 (egress matrix a-f), R6-REQ-080/081 (content-license
-- gate), R6-REQ-103 (AI vendor no-training + zero-retention); REQ-PLAT-001/005/029.
-- Idempotent: safe to re-apply; the DB suite re-applies it as its idempotency
-- proof. Rollback: modules/platform-integration/migrations/0017-vendor-registry.rollback.sql.
-- Depends on modules/platform-core/migrations/0001-tenancy.sql (tenant table +
-- practicehub_app role); the migration runner orders module migrations by file
-- number across modules.
-- The section between the rls:generated markers is emitted by
-- renderRlsMigrationSection('platform_integration', vendorRegistryRlsSpecs,
-- platformIntegrationSchemaRlsSpecs); a drift test compares this file against a
-- fresh emission.

CREATE SCHEMA IF NOT EXISTS platform_integration;

-- Module role pattern (ARCHITECTURE: no cross-module table writes, DB-role
-- enforced): platform_integration-schema access grants only through
-- module_platform_integration; practicehub_app (created by 0001-tenancy.sql)
-- receives the module role and owns nothing.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_platform_integration') THEN
    CREATE ROLE module_platform_integration NOLOGIN;
  END IF;
END
$roles$;

GRANT module_platform_integration TO practicehub_app;
GRANT USAGE ON SCHEMA platform_integration TO module_platform_integration;

-- The vendor registry projection (R6-REQ-008): one row per vendor, the FOLD of
-- the append-only lifecycle log below — the live data the egress guard reads
-- (REQ-PLAT-001 AC-6: a registry update takes effect with no deployment).
-- Structural rules, enforced by CHECK rather than review memory:
--   * an executed BAA carries an effective + expiry date (an executed row with
--     no dates is ambiguous and unrepresentable — the guard fails closed on it);
--   * the BAA window is not inverted;
--   * permitted PHI categories are drawn from the closed vocabulary and are
--     evaluated independently by the guard (GIPA/NV-SB370/BIPA govern GEN/CHD/
--     BIO separately from CLIN).
CREATE TABLE IF NOT EXISTS platform_integration.vendor (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  vendor_id text NOT NULL CHECK (vendor_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  vendor_class text NOT NULL CHECK (
    vendor_class IN ('ehr', 'crm', 'payments', 'cpaas', 'voice-ai-platform', 'voice-ai-llm',
                     'voice-ai-stt', 'voice-ai-tts', 'telephony-carrier', 'fax', 'email',
                     'e-signature', 'labs', 'erx', 'clearinghouse', 'analytics', 'ai-general',
                     'cloud-infra', 'wearables', 'genetics', 'imaging')
  ),
  is_ai_vendor boolean NOT NULL,
  enforcement_point text NOT NULL CHECK (enforcement_point <> ''),
  baa_status text NOT NULL CHECK (baa_status IN ('required', 'executed', 'tbd')),
  baa_effective date,
  baa_expiry date,
  no_training_on_phi boolean NOT NULL DEFAULT false,
  zero_retention boolean NOT NULL DEFAULT false,
  permitted_categories text[] NOT NULL DEFAULT '{}' CHECK (
    permitted_categories <@ ARRAY['ID', 'CLIN', 'GEN', 'CHD', 'BIO', 'med', 'PAY']::text[]
  ),
  status text NOT NULL CHECK (status IN ('active', 'suspended')),
  version integer NOT NULL CHECK (version >= 1),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, vendor_id),
  CONSTRAINT vendor_executed_carries_dates CHECK (
    baa_status <> 'executed' OR (baa_effective IS NOT NULL AND baa_expiry IS NOT NULL)
  ),
  CONSTRAINT vendor_window_not_inverted CHECK (
    baa_effective IS NULL OR baa_expiry IS NULL OR baa_effective <= baa_expiry
  )
);

-- The append-only lifecycle log (REQ-PLAT-001 AC-1: BAA scope/dates/clauses/
-- categories versioned over time). The vendor projection above is its fold.
-- Structural rules: a registered event declares class/ai/enforcement; a
-- permission-increasing event (registered / baa-executed / baa-renewed /
-- category-expanded) names its compliance sign-off (REQ-PLAT-001 exception 4);
-- refs are grammar-checked so prose (and raw PHI) has no field to land in.
-- Append-only by REVOKE below — corrections are new events, never edits.
CREATE TABLE IF NOT EXISTS platform_integration.vendor_event (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  vendor_id text NOT NULL CHECK (vendor_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  version integer NOT NULL CHECK (version >= 1),
  kind text NOT NULL CHECK (
    kind IN ('registered', 'baa-executed', 'baa-renewed', 'category-expanded',
             'baa-lapsed', 'suspended', 'reinstated')
  ),
  vendor_class text CHECK (
    vendor_class IS NULL OR vendor_class IN ('ehr', 'crm', 'payments', 'cpaas',
      'voice-ai-platform', 'voice-ai-llm', 'voice-ai-stt', 'voice-ai-tts',
      'telephony-carrier', 'fax', 'email', 'e-signature', 'labs', 'erx',
      'clearinghouse', 'analytics', 'ai-general', 'cloud-infra', 'wearables',
      'genetics', 'imaging')
  ),
  is_ai_vendor boolean,
  enforcement_point text,
  baa_status text CHECK (baa_status IS NULL OR baa_status IN ('required', 'executed', 'tbd')),
  baa_effective date,
  baa_expiry date,
  no_training_on_phi boolean,
  zero_retention boolean,
  permitted_categories text[] CHECK (
    permitted_categories IS NULL
    OR permitted_categories <@ ARRAY['ID', 'CLIN', 'GEN', 'CHD', 'BIO', 'med', 'PAY']::text[]
  ),
  evidence_ref text CHECK (evidence_ref IS NULL OR evidence_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  approved_by text CHECK (approved_by IS NULL OR approved_by ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, vendor_id, version),
  CONSTRAINT vendor_event_registered_complete CHECK (
    kind <> 'registered'
    OR (vendor_class IS NOT NULL AND is_ai_vendor IS NOT NULL AND enforcement_point IS NOT NULL)
  ),
  CONSTRAINT vendor_event_permission_increase_signed CHECK (
    kind NOT IN ('registered', 'baa-executed', 'baa-renewed', 'category-expanded')
    OR approved_by IS NOT NULL
  )
);

-- The egress-decision activity feed (REQ-PLAT-001 AC-8): every allow AND every
-- block the guard renders, tied to the vendor entry, PHI-free (refs, class,
-- categories, reason — never the raw payload). A block to an UNKNOWN vendor
-- (the no-registry-row case) must be recordable, so vendor_id is a soft ref,
-- not a foreign key. Append-only by REVOKE below.
CREATE TABLE IF NOT EXISTS platform_integration.egress_decision (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  decision_id text NOT NULL CHECK (decision_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  vendor_id text NOT NULL CHECK (vendor_id ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  decision text NOT NULL CHECK (decision IN ('allow', 'deny')),
  phi_class text NOT NULL CHECK (
    phi_class IN ('none', 'demographic', 'PHI', 'PHI-restricted', 'secret')
  ),
  categories text[] NOT NULL DEFAULT '{}' CHECK (
    categories <@ ARRAY['ID', 'CLIN', 'GEN', 'CHD', 'BIO', 'med', 'PAY']::text[]
  ),
  reason text NOT NULL CHECK (reason ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  incident_opened boolean NOT NULL DEFAULT false,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, decision_id)
);

-- The content-license gate (R6-REQ-080 CPT / R6-REQ-081 drug compendium):
-- licensed reference content may only be consulted while a valid, in-date
-- license is on record. An active license carries its dates; the gate fails
-- closed on absence/pending/lapse/expiry (a lapse DISABLES dependent commands).
CREATE TABLE IF NOT EXISTS platform_integration.content_license (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  license_id text NOT NULL CHECK (license_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  content_family text NOT NULL CHECK (
    content_family IN ('cpt', 'drug-compendium', 'ncci', 'other')
  ),
  status text NOT NULL CHECK (status IN ('active', 'pending', 'lapsed')),
  effective date,
  expiry date,
  rights_ref text NOT NULL CHECK (rights_ref ~ '^[a-z0-9][a-z0-9:._/-]{0,199}$'),
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, license_id),
  CONSTRAINT content_license_active_carries_dates CHECK (
    status <> 'active' OR (effective IS NOT NULL AND expiry IS NOT NULL)
  )
);

-- Deterministic grants for this migration's tables.
GRANT SELECT, INSERT, UPDATE ON platform_integration.vendor TO module_platform_integration;
GRANT SELECT, INSERT ON platform_integration.vendor_event TO module_platform_integration;
GRANT SELECT, INSERT ON platform_integration.egress_decision TO module_platform_integration;
GRANT SELECT, INSERT, UPDATE ON platform_integration.content_license TO module_platform_integration;

-- Append-only postures: the lifecycle log and the egress-decision feed are
-- never edited or deleted by any app role (corrections are new events/decisions);
-- the vendor and license projections fold forward — they never delete. Re-asserted
-- on every pass.
REVOKE UPDATE, DELETE ON platform_integration.vendor_event FROM module_platform_integration;
REVOKE UPDATE, DELETE ON platform_integration.egress_decision FROM module_platform_integration;
REVOKE DELETE ON platform_integration.vendor FROM module_platform_integration;
REVOKE DELETE ON platform_integration.content_license FROM module_platform_integration;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE platform_integration.content_license ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_integration.content_license FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON platform_integration.content_license;
CREATE POLICY tenant_isolation ON platform_integration.content_license
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE platform_integration.egress_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_integration.egress_decision FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON platform_integration.egress_decision;
CREATE POLICY tenant_isolation ON platform_integration.egress_decision
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE platform_integration.vendor ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_integration.vendor FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON platform_integration.vendor;
CREATE POLICY tenant_isolation ON platform_integration.vendor
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE platform_integration.vendor_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_integration.vendor_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON platform_integration.vendor_event;
CREATE POLICY tenant_isolation ON platform_integration.vendor_event
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

DO $coverage$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname)
    INTO offender
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'platform_integration'
     AND c.relkind = 'r'
     AND (NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR c.relname NOT IN ('content_license', 'egress_decision', 'vendor', 'vendor_event'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema platform_integration: %', offender;
  END IF;
END
$coverage$;
-- rls:generated:end
