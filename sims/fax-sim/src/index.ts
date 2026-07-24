/**
 * Inbound-fax simulator STUB (WP-024). Implements the module-declared
 * `InboundFaxPort` deterministically for tests and fixtures — a fax rail that
 * hands the documents module synthetic inbound-fax deliveries so the
 * intake/quarantine/unmatched flows can be exercised end-to-end without a real
 * fax network. WP-049 (fax flows: inbound routing + IDP thresholds) builds the
 * real routing over this rail; the full vendor-sim framework rail (scenario
 * API, failure injection) is a later capability walk. Synthetic-only by
 * construction: every delivery carries the literal `synthetic: true` watermark.
 */

import type { InboundFaxDelivery, InboundFaxPort } from '@practicehub/documents';

export type FaxSimScenario = 'matched' | 'unmatched' | 'wrong-patient';

interface FaxSimSpec {
  readonly faxId: string;
  readonly senderRef: string;
  readonly pageCount: number;
  readonly content: string;
}

const scenarioSpecs: Record<FaxSimScenario, FaxSimSpec> = {
  matched: {
    faxId: 'synthetic-fax-0001',
    senderRef: 'synthetic-sender:referring-clinic-0007',
    pageCount: 3,
    content: 'synthetic-fax-content:matched-referral-summary',
  },
  unmatched: {
    faxId: 'synthetic-fax-0002',
    senderRef: 'synthetic-sender:unknown-origin',
    pageCount: 1,
    content: 'synthetic-fax-content:unmatched-no-known-patient',
  },
  'wrong-patient': {
    faxId: 'synthetic-fax-0003',
    senderRef: 'synthetic-sender:misdirected-office',
    pageCount: 5,
    content: 'synthetic-fax-content:unsolicited-wrong-patient-records',
  },
};

/**
 * Build a deterministic inbound-fax rail that delivers one synthetic fax for
 * the requested scenario. `receivedAt` is caller-supplied so seeds and tests
 * stay deterministic (no wall clock).
 */
export function createFaxSimStub(scenario: FaxSimScenario, receivedAt: string): InboundFaxPort {
  const spec = scenarioSpecs[scenario];
  return {
    poll(): readonly InboundFaxDelivery[] {
      return [
        {
          faxId: spec.faxId,
          senderRef: spec.senderRef,
          pageCount: spec.pageCount,
          bytes: spec.content,
          mediaType: 'application/pdf',
          receivedAt,
          synthetic: true,
        },
      ];
    },
  };
}
