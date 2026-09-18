# WP-123 security-review prep pack (EW-SEC-01)

Exclusive leaf. Consumes `docs/architecture/tenancy-partition-threat-model.md` (WP-010). Does not rewrite it.

Prep pack:

1. Threat rows with disposition `consumed` | `in-pack` | `forward` | `residual` and a work-package owner.
2. Pen-test scope: in-scope product surfaces vs out-of-scope vendor networks (D5).
3. Remediation loop: every finding wires to `WP-NNN` or is refused.

Schema-free. No SQL. Canonical REQ-PLAT AC/EX remain forwarded.
