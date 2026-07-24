/**
 * Document filing command (WP-024). Filing a received/unmatched/quarantined
 * document to a patient chart ATTACHES PHI to a person record — it is
 * authority-increasing, so it moves under `documents.intake`, floored at
 * `simulated`. WP-024 seeds the capability at `scaffolded` (the package
 * ceiling), so the seeded local grant DENIES a live filing — the activation
 * walk belongs to the package that takes M06 into the reference loops.
 * Riverbend (disabled) is the standing opposite-state proof.
 *
 * PROTECTIVE / automatic writes — quarantine, hold, disposition-at-expiry
 * (destroy/return), redirect — are NEVER routed here and never capability-gated:
 * containing a misdirected record and disposing of an over-held one must always
 * land (the audit-store `audit.emit` and consent-revoke precedent). Callers
 * append those through `appendDocumentEvent` directly.
 */

import { defineCommandHandler } from '@practicehub/platform-core';

import {
  appendDocumentEvent,
  DocumentError,
  type DocumentEvent,
  type DocumentEventInput,
} from '../document.js';

export interface FileDocumentCommandInput {
  readonly log: readonly DocumentEvent[];
  readonly event: DocumentEventInput;
}

export const fileDocumentCommand = defineCommandHandler<
  FileDocumentCommandInput,
  { readonly event: DocumentEvent; readonly log: readonly DocumentEvent[] }
>({
  capabilityId: 'documents.intake',
  minimumState: 'simulated',
  handle: (_context, input) => {
    if (input.event.eventType !== 'filed') {
      throw new DocumentError(
        `fileDocument handles only 'filed'; ${JSON.stringify(input.event.eventType)} is a ` +
          'protective write — append it ungated',
      );
    }
    return appendDocumentEvent(input.log, input.event);
  },
});
