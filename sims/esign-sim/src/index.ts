/**
 * E-signature simulator STUB (WP-025). Implements the module-declared `EsignPort`
 * deterministically for tests and fixtures — an e-sign rail that returns a
 * synthetic signature evidence chain so the documents module can record signed
 * artifacts without a real e-sign vendor. CPaaS/video/e-sign are INTEGRATED,
 * never built (D5.4), so this is a stub for a later vendor adapter behind the
 * same port (FWD-DOC-025-ESIGN-RAIL). Synthetic-only by construction: every
 * request carries the literal `synthetic: true` watermark or it does not
 * type-check, and the stub refuses any request without it at runtime.
 *
 * Closure invariant (ADR-010): `request` TRANSMITS. Only a `signed` scenario
 * carries the certificate hash + signed instant that let it become a document
 * version; `pending` and `declined` never do — the failure-injection surface.
 */

import {
  hashContent,
  type EsignPort,
  type SignatureEvidence,
  type SignatureRequest,
} from '@practicehub/documents';

export type EsignScenario = 'signed' | 'pending' | 'declined';

/**
 * Create a deterministic e-sign stub. The scenario fixes the outcome of every
 * request; `poll` returns the outcome recorded for a prior request id (or throws
 * for an unknown id). The certificate hash is the sha-256 of the signed content
 * address — a real rail's evidence is opaque, but a deterministic hash keeps
 * tests byte-stable.
 */
export function createEsignStub(scenario: EsignScenario = 'signed'): EsignPort {
  const outcomes = new Map<string, SignatureEvidence>();

  function outcomeFor(input: SignatureRequest): SignatureEvidence {
    if (input.synthetic !== true) {
      throw new Error('esign-sim accepts synthetic requests only');
    }
    const base = {
      requestId: input.requestId,
      tenantId: input.tenantId,
      documentId: input.documentId,
      versionNo: input.versionNo,
      signerRefs: input.signerRefs,
      method: input.method,
      synthetic: true as const,
    };
    if (scenario === 'signed') {
      return {
        ...base,
        status: 'signed',
        certificateHash: hashContent(
          `synthetic-esign-cert:${input.requestId}:${input.contentHash}`,
        ),
        signedAt: '2026-03-09T08:30:00Z',
        evidenceRef: `synthetic-esign-evidence:${input.requestId}`,
      };
    }
    return { ...base, status: scenario };
  }

  return {
    request(input: SignatureRequest): SignatureEvidence {
      const outcome = outcomeFor(input);
      outcomes.set(input.requestId, outcome);
      return outcome;
    },
    poll(requestId: string): SignatureEvidence {
      const outcome = outcomes.get(requestId);
      if (outcome === undefined) {
        throw new Error(`esign-sim has no outcome for request ${requestId}`);
      }
      return outcome;
    },
  };
}
