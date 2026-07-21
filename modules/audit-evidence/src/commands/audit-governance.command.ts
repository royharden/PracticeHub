/**
 * Destruction execution and legal-hold release are authority-bearing writes:
 * they move under `platform.audit-store`, floored at `simulated`. WP-020
 * seeds the capability at `scaffolded` (the package ceiling), so the seeded
 * local grant DENIES live destruction and hold release — the activation walk
 * belongs to the package that takes M04 into the reference loops. Riverbend
 * (disabled) is the standing opposite-state proof. `audit.emit` itself is
 * NEVER capability-gated (contract decision 2): the store must always be able
 * to record a deny, so only the governance actions live here.
 */

import { defineCommandHandler } from '@practicehub/platform-core';

import {
  executeDestruction,
  releaseLegalHold,
  type DestructionEligibility,
  type DestructionOutcome,
  type LegalHold,
} from '../retention.js';
import type { AuditEmitInput } from '../audit.js';

export interface ExecuteDestructionCommandInput {
  readonly eligibility: DestructionEligibility;
  readonly holdsAtExecution: readonly LegalHold[];
  readonly execution: {
    readonly destructionId: string;
    readonly auditId: string;
    readonly authorityRef: string;
    readonly executedBy: string;
    readonly occurredAt: string;
  };
}

export const executeDestructionCommand = defineCommandHandler<
  ExecuteDestructionCommandInput,
  DestructionOutcome
>({
  capabilityId: 'platform.audit-store',
  minimumState: 'simulated',
  handle: (_context, input) =>
    executeDestruction(input.eligibility, input.holdsAtExecution, input.execution),
});

export interface ReleaseLegalHoldCommandInput {
  readonly hold: LegalHold;
  readonly release: {
    readonly releasedBy: string;
    readonly releaseEvidenceRef: string;
    readonly auditId: string;
    readonly occurredAt: string;
  };
}

export const releaseLegalHoldCommand = defineCommandHandler<
  ReleaseLegalHoldCommandInput,
  { readonly hold: LegalHold; readonly auditInput: AuditEmitInput }
>({
  capabilityId: 'platform.audit-store',
  minimumState: 'simulated',
  handle: (_context, input) => releaseLegalHold(input.hold, input.release),
});
