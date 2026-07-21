-- WP-015 rollback: drop the PDP tables (policy-data revert per the package
-- row — the identity.access-policy capability stays disabled/scaffolded, so
-- no live surface exists to roll back). Order respects FKs.
DROP TABLE IF EXISTS identity.gipa_authorization;
DROP TABLE IF EXISTS identity.partition_tag;
DROP TABLE IF EXISTS identity.person_flag;
DROP TABLE IF EXISTS identity.authority_record;
DROP TABLE IF EXISTS identity.access_override;
DROP TABLE IF EXISTS identity.role_assignment;
DROP TABLE IF EXISTS identity.role_template;
