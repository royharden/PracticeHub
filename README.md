# PracticeHub

A multi-tenant practice-operations platform, built as a modular monolith with
per-module capability-state activation. This repository is a filtered public
snapshot of the platform code.

## Layout

- `apps/` — deployable API and web front-ends
- `modules/` — domain modules (schema-per-module, row-level tenancy)
- `packages/` — shared libraries and test kit
- `adapters/` — vendor-facing adapters (vendor SDKs live only here)
- `sims/` — local vendor simulators for offline development
- `tools/` — build orchestration and verification validators
- `infra/` — local Docker topology and database bootstrap

## Development

Local-first and synthetic-data only; the stack runs under Docker Compose.
Requirements, planning, and internal tooling are kept out of this snapshot, so a
fresh clone is a code reference rather than a one-command build.

## Status

Early and actively developed. No release and no support guarantees yet.

## License

No license has been chosen yet — all rights reserved. Please do not reuse
without permission.
