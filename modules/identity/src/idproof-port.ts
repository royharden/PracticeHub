/**
 * Identity-proofing port (WP-013). The module declares the port; simulators
 * and, behind adapters, real identity-proofing vendors implement it. The
 * local stub lives in sims/idproof-sim (WP-028 replaces it with the full
 * vendor-sim framework rail).
 */

import type { PersonId, TenantId } from '@practicehub/contracts';

export const identityProofingMethods = ['document', 'knowledge-based', 'in-person'] as const;
export type IdentityProofingMethod = (typeof identityProofingMethods)[number];

export interface IdentityProofingRequest {
  readonly tenantId: TenantId;
  readonly personId: PersonId;
  readonly method: IdentityProofingMethod;
  readonly synthetic: true;
}

export interface IdentityProofingResult {
  readonly verified: boolean;
  /** Evidence reference a `verified` person fact records (fails closed when absent). */
  readonly evidenceRef: string;
  readonly failureReason?: string;
  readonly synthetic: true;
}

export interface IdentityProofingPort {
  prove(request: IdentityProofingRequest): IdentityProofingResult;
}
