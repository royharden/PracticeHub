-- Rollback for 0070-oig-exception-report.sql. The coverage guards in 0019/0021/0022/0070
-- name oig_exception_report; naming a table that no longer exists is harmless (NOT IN list).
DROP TABLE IF EXISTS payments_ledger.oig_exception_report;
