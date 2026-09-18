-- Unapplied companion for 0038-membership.sql. Not executed in this increment.
DROP TABLE IF EXISTS membership.lifecycle_event;
DROP TABLE IF EXISTS membership.vintage;
DROP TABLE IF EXISTS membership.account;
DROP SCHEMA IF EXISTS membership;
REVOKE module_membership FROM practicehub_app;
DROP ROLE IF EXISTS module_membership;
