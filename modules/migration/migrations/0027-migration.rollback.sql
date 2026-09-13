-- WP-110 rollback removes only M27 staging evidence. It never touches a target domain.
DROP SCHEMA IF EXISTS migration CASCADE;
DROP ROLE IF EXISTS module_migration;
