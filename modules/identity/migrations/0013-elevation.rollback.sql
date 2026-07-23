-- Rollback for 0013-elevation.sql (WP-017). Drops the six elevation tables in
-- dependency order (children before parents); the identity schema, the
-- module_identity role, and the earlier tables stay intact. Per the package
-- row rollback expectation "revoke elevations": no live surface exists (the
-- identity.break-glass capability stays disabled/scaffolded), so dropping the
-- tables is the full revert.
DROP TABLE IF EXISTS identity.break_glass_review;
DROP TABLE IF EXISTS identity.offboarding_reassignment;
DROP TABLE IF EXISTS identity.access_recertification;
DROP TABLE IF EXISTS identity.access_anomaly_case;
DROP TABLE IF EXISTS identity.offboarding_case;
DROP TABLE IF EXISTS identity.break_glass_grant;
