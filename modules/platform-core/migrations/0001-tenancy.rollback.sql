-- WP-010 rollback (schema-drop rollback per the package row). Not applied by
-- tooling; run manually as the database owner to revert 0001-tenancy.sql.
-- platform_core.synthetic_tenant predates WP-010 (plan-000 bootstrap) and is
-- retained; only its WP-010 RLS additions are reverted.

DROP TABLE IF EXISTS platform_core.tenant_config;
DROP TABLE IF EXISTS platform_core.location;
DROP TABLE IF EXISTS platform_core.legal_entity;
DROP TABLE IF EXISTS platform_core.tenant;

DROP POLICY IF EXISTS tenant_isolation ON platform_core.synthetic_tenant;
ALTER TABLE platform_core.synthetic_tenant NO FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_core.synthetic_tenant DISABLE ROW LEVEL SECURITY;

REVOKE USAGE ON SCHEMA platform_core FROM module_platform_core;
DROP ROLE IF EXISTS practicehub_app;
DROP ROLE IF EXISTS module_platform_core;
