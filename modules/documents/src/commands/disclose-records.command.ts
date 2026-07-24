/**
 * Records-disclosure command (WP-025). Releasing a patient's records to a
 * recipient is a DISCLOSURE (egress of PHI) — authority-increasing, so it moves
 * under `documents.records`, floored at `simulated`. WP-025 seeds the capability
 * at `scaffolded` (the package ceiling), so the seeded local grant DENIES a live
 * disclosure; Riverbend (disabled) is the standing opposite-state proof.
 *
 * The command wraps compilation because the authority-bearing act IS producing
 * the disclosure: scope limits are applied and the send-time genetic re-check
 * runs through the injected guard (WP-015 assembleRecordsExport,
 * FWD-PDP-025-EXPORT). Closing a transmitted disclosure with delivery evidence
 * is a protective follow-up and is not routed here.
 */

import { defineCommandHandler } from '@practicehub/platform-core';

import {
  compileRecordsDisclosure,
  type GeneticExportAuthorization,
  type RecordsDisclosure,
  type RecordsExportGuard,
  type RecordsExportItem,
  type RecordsRequest,
} from '../records.js';

export interface DiscloseRecordsCommandInput {
  readonly request: RecordsRequest;
  readonly candidates: readonly RecordsExportItem[];
  readonly guard: RecordsExportGuard;
  readonly authorizations: readonly GeneticExportAuthorization[];
}

export const discloseRecordsCommand = defineCommandHandler<
  DiscloseRecordsCommandInput,
  RecordsDisclosure
>({
  capabilityId: 'documents.records',
  minimumState: 'simulated',
  handle: (_context, input) =>
    compileRecordsDisclosure(input.request, input.candidates, input.guard, input.authorizations),
});
