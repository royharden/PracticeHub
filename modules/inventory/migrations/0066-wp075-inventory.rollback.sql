DROP TABLE IF EXISTS inventory.recall_unit;
DROP TABLE IF EXISTS inventory.dispense_unit;
DROP TABLE IF EXISTS inventory.dispense;
DROP TABLE IF EXISTS inventory.unit;
DROP TABLE IF EXISTS inventory.lot;
DROP TABLE IF EXISTS inventory.product;
DROP SCHEMA IF EXISTS inventory;
REVOKE module_inventory FROM practicehub_app;
