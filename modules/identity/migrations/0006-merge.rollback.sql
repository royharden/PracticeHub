-- Rollback for 0006-merge.sql (WP-016): drop the merge-governance tables in
-- dependency order. The identity schema, module role, and every WP-013/WP-014
-- table survive — this reverses only the WP-016 schema effects.

DROP TABLE IF EXISTS identity.merge_lineage;
DROP TABLE IF EXISTS identity.merge_event;
DROP TABLE IF EXISTS identity.merge_case_person;
DROP TABLE IF EXISTS identity.merge_case;
