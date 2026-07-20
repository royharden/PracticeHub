-- WP-010 platform_core tenancy migration.
-- Contract: docs/contracts/tenancy-types.md (FROZEN). Architecture: ADR-005.
-- Idempotent: safe to re-apply; the DB suite re-applies it as its idempotency proof.
-- Rollback: modules/platform-core/migrations/0001-tenancy.rollback.sql (drop schema objects).
-- The section between the rls:generated markers is emitted by
-- renderRlsMigrationSection('platform_core', platformCoreRlsSpecs); a drift
-- test compares this file against a fresh emission.

CREATE SCHEMA IF NOT EXISTS platform_core;

-- Module role pattern (ARCHITECTURE: no cross-module table writes, DB-role
-- enforced): each module schema grants only through its own NOLOGIN role;
-- practicehub_app is the runtime login and receives module roles. The app
-- role can never bypass RLS and owns nothing.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'module_platform_core') THEN
    CREATE ROLE module_platform_core NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'practicehub_app') THEN
    CREATE ROLE practicehub_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT;
  END IF;
END
$roles$;

-- Synthetic-only local credential (compose stack binds to 127.0.0.1).
ALTER ROLE practicehub_app WITH PASSWORD 'practicehub_app_synthetic_local';
GRANT module_platform_core TO practicehub_app;
GRANT USAGE ON SCHEMA platform_core TO module_platform_core;

CREATE TABLE IF NOT EXISTS platform_core.tenant (
  tenant_id text PRIMARY KEY CHECK (tenant_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  synthetic boolean NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_core.legal_entity (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  legal_entity_id text NOT NULL CHECK (legal_entity_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('PC', 'PLLC', 'LLC', 'MSO', 'other')),
  cpom_state text CHECK (cpom_state ~ '^[A-Z]{2}$'),
  counsel_ratification_ref text,
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, legal_entity_id),
  -- R6-SR-110: a CPOM-shaped entity is a counsel-ratified config record.
  CONSTRAINT legal_entity_cpom_counsel_ratified
    CHECK (cpom_state IS NULL OR counsel_ratification_ref IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS platform_core.location (
  tenant_id text NOT NULL,
  location_id text NOT NULL CHECK (location_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  legal_entity_id text NOT NULL,
  name text NOT NULL,
  state_code text NOT NULL CHECK (state_code ~ '^[A-Z]{2}$'),
  kind text NOT NULL CHECK (kind IN ('physical', 'virtual')),
  synthetic boolean NOT NULL,
  PRIMARY KEY (tenant_id, location_id),
  -- Composite key: a location can never attach to another tenant's entity.
  CONSTRAINT location_entity_same_tenant
    FOREIGN KEY (tenant_id, legal_entity_id)
    REFERENCES platform_core.legal_entity (tenant_id, legal_entity_id)
);

CREATE TABLE IF NOT EXISTS platform_core.tenant_config (
  tenant_id text NOT NULL REFERENCES platform_core.tenant (tenant_id),
  legal_entity_id text,
  location_id text,
  namespace text NOT NULL CHECK (
    namespace IN ('branding', 'sending-identity', 'portal-domain', 'disclosure', 'template', 'policy')
  ),
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9/:=*.-]{0,127}$'),
  value jsonb NOT NULL,
  phi_class text NOT NULL CHECK (phi_class IN ('none', 'demographic')),
  counsel_owned boolean NOT NULL DEFAULT false,
  change_control_ref text,
  revision integer NOT NULL CHECK (revision >= 1),
  -- REQ-ADM-027 AC-3: every config revision is timestamped and attributed.
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text NOT NULL CHECK (changed_by ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  synthetic boolean NOT NULL,
  CONSTRAINT tenant_config_scope_key
    UNIQUE NULLS NOT DISTINCT (tenant_id, legal_entity_id, location_id, namespace, key, revision),
  CONSTRAINT tenant_config_location_requires_entity
    CHECK (location_id IS NULL OR legal_entity_id IS NOT NULL),
  -- R6-SR-110: counsel-owned entries fail closed without change control.
  CONSTRAINT tenant_config_counsel_change_control
    CHECK (counsel_owned = false OR change_control_ref IS NOT NULL),
  CONSTRAINT tenant_config_entity_same_tenant
    FOREIGN KEY (tenant_id, legal_entity_id)
    REFERENCES platform_core.legal_entity (tenant_id, legal_entity_id),
  CONSTRAINT tenant_config_location_same_tenant
    FOREIGN KEY (tenant_id, location_id)
    REFERENCES platform_core.location (tenant_id, location_id)
);

-- Idempotent upgrade path (review-004 remediation, REQ-ADM-027 AC-3): a
-- database whose tenant_config predates the attribution columns gains them
-- here; the backfill default is dropped so new writes must name their actor.
ALTER TABLE platform_core.tenant_config
  ADD COLUMN IF NOT EXISTS changed_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE platform_core.tenant_config
  ADD COLUMN IF NOT EXISTS changed_by text NOT NULL
    DEFAULT 'synthetic-migration-backfill'
    CHECK (changed_by ~ '^[a-z0-9][a-z0-9-]{0,63}$');
ALTER TABLE platform_core.tenant_config
  ALTER COLUMN changed_by DROP DEFAULT;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA platform_core TO module_platform_core;
ALTER DEFAULT PRIVILEGES IN SCHEMA platform_core
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO module_platform_core;

-- rls:generated:begin
-- Generated by @practicehub/platform-core generateRlsDdl/generateRlsCoverageGuard.
-- Regenerate via renderRlsMigrationSection; the drift test fails on divergence.
ALTER TABLE platform_core.legal_entity ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_core.legal_entity FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON platform_core.legal_entity;
CREATE POLICY tenant_isolation ON platform_core.legal_entity
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE platform_core.location ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_core.location FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON platform_core.location;
CREATE POLICY tenant_isolation ON platform_core.location
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE platform_core.synthetic_tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_core.synthetic_tenant FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON platform_core.synthetic_tenant;
CREATE POLICY tenant_isolation ON platform_core.synthetic_tenant
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE platform_core.tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_core.tenant FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON platform_core.tenant;
CREATE POLICY tenant_isolation ON platform_core.tenant
  USING (tenant_id = current_setting('practicehub.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('practicehub.tenant_id', true));

ALTER TABLE platform_core.tenant_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_core.tenant_config FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON platform_core.tenant_config;
CREATE POLICY tenant_isolation ON platform_core.tenant_config
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
   WHERE n.nspname = 'platform_core'
     AND c.relkind = 'r'
     AND (NOT c.relrowsecurity
          OR NOT c.relforcerowsecurity
          OR c.relname NOT IN ('capability_event', 'capability_grant', 'jurisdiction_rule', 'jurisdiction_rule_pack', 'legal_entity', 'location', 'location_capture', 'synthetic_tenant', 'tenant', 'tenant_config'));
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'rls coverage failure in schema platform_core: %', offender;
  END IF;
END
$coverage$;
-- rls:generated:end
