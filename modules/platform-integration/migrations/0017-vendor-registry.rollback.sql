-- Rollback for 0017-vendor-registry.sql (WP-026, M07). Drops the vendor
-- registry, its lifecycle log, the egress-decision feed, the content-license
-- gate, and the schema; the module role is left in place (other objects may not
-- exist, and roles are cluster-global — dropping it is a separate, deliberate op).
DROP TABLE IF EXISTS platform_integration.egress_decision;
DROP TABLE IF EXISTS platform_integration.vendor_event;
DROP TABLE IF EXISTS platform_integration.content_license;
DROP TABLE IF EXISTS platform_integration.vendor;
DROP SCHEMA IF EXISTS platform_integration;
