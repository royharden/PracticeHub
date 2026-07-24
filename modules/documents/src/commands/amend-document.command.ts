/**
 * Document amendment command (WP-025). Amending, correcting, or e-sign-executing
 * a patient's record CHANGES the record of a person — it is authority-increasing,
 * so it moves under `documents.records`, floored at `simulated`. WP-025 seeds the
 * capability at `scaffolded` (the package ceiling), so the seeded local grant
 * DENIES a live amendment; Riverbend (disabled) is the standing opposite-state
 * proof.
 *
 * PROTECTIVE / patient-right writes are NEVER routed here and never gated: the
 * `original` version (created at intake) and a patient's `statement-of-
 * disagreement` (HIPAA §164.526 — the patient may always append a disagreement,
 * even to a denied correction) are appended through `appendDocumentVersion`
 * directly, the WP-024 protective-write precedent.
 */

import { defineCommandHandler } from '@practicehub/platform-core';

import { DocumentError } from '../document.js';
import {
  appendDocumentVersion,
  type DocumentVersion,
  type DocumentVersionInput,
} from '../records.js';

export interface AmendDocumentCommandInput {
  readonly versions: readonly DocumentVersion[];
  readonly version: DocumentVersionInput;
}

const gatedKinds: readonly DocumentVersionInput['kind'][] = [
  'amendment',
  'correction',
  'esign-execution',
];

export const amendDocumentCommand = defineCommandHandler<
  AmendDocumentCommandInput,
  { readonly version: DocumentVersion; readonly versions: readonly DocumentVersion[] }
>({
  capabilityId: 'documents.records',
  minimumState: 'simulated',
  handle: (_context, input) => {
    if (!gatedKinds.includes(input.version.kind)) {
      throw new DocumentError(
        `amendDocument handles record-altering versions only; ${JSON.stringify(input.version.kind)} ` +
          'is a protective/patient-right write — append it ungated',
      );
    }
    return appendDocumentVersion(input.versions, input.version);
  },
});
