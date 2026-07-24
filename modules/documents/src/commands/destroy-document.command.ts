/**
 * Document-destruction command (WP-025). Executing a destruction disposes of a
 * patient's record and is authority-increasing, so it moves under
 * `documents.records`, floored at `simulated`. WP-025 seeds the capability at
 * `scaffolded` (the package ceiling), so the seeded local grant DENIES a live
 * destruction; Riverbend (disabled) is the standing opposite-state proof. The
 * governance action mirrors the audit-store precedent (audit-emit.md decision 2):
 * destruction execution is authority-bearing and floors at simulated.
 *
 * Execution composes the WP-020 retention engine (destruction_evidence shared
 * shape) — the FWD-DOC-025-DESTRUCTION / FWD-AUD-025-DOCS discharge. Eligibility
 * evaluation (the clock resolution + hold scan) is pure and unguarded; only the
 * execution itself is gated.
 */

import type { DestructionOutcome, LegalHold } from '@practicehub/audit-evidence';
import { defineCommandHandler } from '@practicehub/platform-core';

import { executeDocumentDestruction, type planDocumentDestruction } from '../records.js';

export interface DestroyDocumentCommandInput {
  readonly eligibility: ReturnType<typeof planDocumentDestruction>;
  readonly holdsAtExecution: readonly LegalHold[];
  readonly execution: {
    readonly destructionId: string;
    readonly auditId: string;
    readonly authorityRef: string;
    readonly executedBy: string;
    readonly occurredAt: string;
  };
}

export const destroyDocumentCommand = defineCommandHandler<
  DestroyDocumentCommandInput,
  DestructionOutcome
>({
  capabilityId: 'documents.records',
  minimumState: 'simulated',
  handle: (_context, input) =>
    executeDocumentDestruction(input.eligibility, input.holdsAtExecution, input.execution),
});
