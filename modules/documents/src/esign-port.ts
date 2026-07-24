/**
 * E-signature port (WP-025). Contract: docs/contracts/records-search-api.md
 * §E-sign. The documents module OWNS this port; an e-sign rail (the esign-sim
 * stub locally, an integrated e-sign vendor adapter in a later capability walk)
 * implements it and returns a signature evidence chain. CPaaS/video/e-sign are
 * INTEGRATED, never built (D5.4) — so the module only owns the port + the
 * evidence-chain shape it records, never a signing implementation.
 *
 * The closure invariant (ADR-010 Decision 3): requesting a signature TRANSMITS
 * — it does not close. An `esign-execution` document version may be recorded
 * only once the rail returns complete `SignatureEvidence` (the signed outcome);
 * a pending/declined request never becomes a version.
 *
 * PHI discipline: the evidence carries REFERENCES and hashes only — signer
 * refs, a signing-method label, a certificate-chain hash, and an evidence ref.
 * No signed document bytes and no raw signer PHI ever enter this shape; the
 * signed artifact itself lives in the blob store, content-addressed.
 */

/** How a signature was captured (closed vocabulary — never free text). */
export const signatureMethods = [
  'click-to-sign',
  'drawn-signature',
  'typed-signature',
  'knowledge-based',
] as const;
export type SignatureMethod = (typeof signatureMethods)[number];

/** The synthetic request handed to the e-sign rail. */
export interface SignatureRequest {
  readonly requestId: string;
  readonly tenantId: string;
  readonly documentId: string;
  /** The version of the document being sent for signature. */
  readonly versionNo: number;
  /** Content address of the artifact being signed (integrity anchor). */
  readonly contentHash: string;
  readonly signerRefs: readonly string[];
  readonly method: SignatureMethod;
  readonly synthetic: true;
}

/**
 * The signed outcome the rail returns. A `status` of `signed` is the CLOSURE —
 * it carries the certificate-chain hash and the signed instant; `pending` and
 * `declined` never carry them and never become a version.
 */
export type SignatureOutcomeStatus = 'signed' | 'pending' | 'declined';

export interface SignatureEvidence {
  readonly requestId: string;
  readonly tenantId: string;
  readonly documentId: string;
  readonly versionNo: number;
  readonly status: SignatureOutcomeStatus;
  readonly signerRefs: readonly string[];
  readonly method: SignatureMethod;
  /** sha-256 of the certificate/evidence chain — present only when `signed`. */
  readonly certificateHash?: string;
  /** ISO-8601 UTC instant the signature completed — present only when `signed`. */
  readonly signedAt?: string;
  /** The rail's opaque evidence pointer (ref grammar). */
  readonly evidenceRef?: string;
  readonly synthetic: true;
}

/** A pollable e-signature rail. `request` transmits; `poll` returns the outcome. */
export interface EsignPort {
  request(input: SignatureRequest): SignatureEvidence;
  poll(requestId: string): SignatureEvidence;
}
