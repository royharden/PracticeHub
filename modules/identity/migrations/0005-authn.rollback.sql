-- Rollback for 0005-authn.sql (WP-014): drop the authn tables. The
-- `identity.authn` capability stays disabled/scaffolded (no live surface),
-- so dropping the tables is the whole feature-flag-off posture per the
-- package row. The identity core (0004) is untouched.

DROP TABLE IF EXISTS identity.account_lockdown;
DROP TABLE IF EXISTS identity.auth_challenge;
DROP TABLE IF EXISTS identity.auth_session;
DROP TABLE IF EXISTS identity.auth_device;
DROP TABLE IF EXISTS identity.auth_credential;
