/**
 * Local clinical-contract double for WP-062. WP-060/061 trees are not written.
 * This is not the frozen WP-032 coexistence port; it is the encounters leaf
 * shape for SOAP, amendment, copy-forward, and attestation.
 */

export interface ClinicalScope {
  readonly tenantId: string;
  readonly personId: string;
  readonly encounterId: string;
  readonly noteId: string;
}

export interface SoapBody {
  readonly subjective: string;
  readonly objective: string;
  readonly assessment: string;
  readonly plan: string;
}

export const noteStates = [
  'proposal-draft',
  'approved-for-transmission',
  'signed-in-authority',
  'amendment-pending',
  'conflict',
  'rejected',
] as const;
export type NoteState = (typeof noteStates)[number];

/** Assigned-clinician Athena attestation. Application approval is not this. */
export interface AthenaAttestation {
  readonly assignedSignerRef: string;
  readonly sourceVersion: string;
  readonly signedAt: string;
  readonly attestationRef: string;
  readonly synthetic: true;
}
