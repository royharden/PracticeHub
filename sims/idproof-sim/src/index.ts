/**
 * Identity-proofing simulator STUB (WP-013). Implements the module-declared
 * `IdentityProofingPort` deterministically for tests and fixtures; WP-028
 * replaces this with the full vendor-sim framework rail (scenario API,
 * failure injection). Synthetic-only by construction: requests carry the
 * literal `synthetic: true` watermark or they do not type-check, and the
 * stub refuses any request without it at runtime.
 */

import type {
  IdentityProofingPort,
  IdentityProofingRequest,
  IdentityProofingResult,
} from '@practicehub/identity';

export type IdProofScenario = 'pass' | 'fail';

export function createIdProofStub(scenario: IdProofScenario = 'pass'): IdentityProofingPort {
  return {
    prove(request: IdentityProofingRequest): IdentityProofingResult {
      if (request.synthetic !== true) {
        throw new Error('idproof-sim accepts synthetic requests only');
      }
      if (scenario === 'fail') {
        return {
          verified: false,
          evidenceRef: `synthetic-idproof:${request.personId}:${request.method}:refused`,
          failureReason: 'synthetic-scenario-fail',
          synthetic: true,
        };
      }
      return {
        verified: true,
        evidenceRef: `synthetic-idproof:${request.personId}:${request.method}`,
        synthetic: true,
      };
    },
  };
}
