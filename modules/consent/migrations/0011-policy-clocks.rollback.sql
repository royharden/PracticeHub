-- Rollback for 0011-policy-clocks.sql (WP-019). `clock configs versioned`: drop
-- the policy/clock tables; the WP-018 consent ledger (consent_event/consent_state)
-- is untouched. Drop the projection before the event log it references.
DROP TABLE IF EXISTS consent.obligation_clock;
DROP TABLE IF EXISTS consent.obligation_clock_event;
DROP TABLE IF EXISTS consent.policy_document;
DROP TABLE IF EXISTS consent.obligation_clock_policy;
