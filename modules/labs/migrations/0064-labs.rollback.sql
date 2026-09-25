-- WP-064 labs rollback. Drops the module tables and schema.
DROP TABLE IF EXISTS labs.expected_result_age;
DROP TABLE IF EXISTS labs.critical_closure;
DROP TABLE IF EXISTS labs.lab_result;
DROP TABLE IF EXISTS labs.lab_order;
DROP SCHEMA IF EXISTS labs;
