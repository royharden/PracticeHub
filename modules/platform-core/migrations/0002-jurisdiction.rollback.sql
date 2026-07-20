-- WP-011 rollback: drop the jurisdiction registry and location-capture tables.
-- Pack-version reverts (the package's rollback contract) do NOT use this file:
-- reverting a rule change is deleting the newest (jurisdiction, version) rows,
-- which restores the prior version as active. This file is the full
-- schema-object rollback only.
DROP TABLE IF EXISTS platform_core.location_capture;
DROP TABLE IF EXISTS platform_core.jurisdiction_rule;
DROP TABLE IF EXISTS platform_core.jurisdiction_rule_pack;
