/**
 * PLACEHOLDERS for the idproof-sim and esign-sim rails. A module may never depend on a sim service
 * (FWD-SIM-028-PORTS), so the drills bind these deterministic doubles to the ports the module
 * declares. They mirror sims/idproof-sim `createIdProofStub` (pass/fail) and sims/esign-sim
 * `createEsignStub` (signed), and add the outage each rail must survive. The loop-level binding
 * to the real rails replaces them (FWD-SIM-028-PORTS; FWD-DOC-025-ESIGN-RAIL).
 */

import type { IdentityProofingPort } from '../idproof-port.js';
import type {
  ConsentEsignRail,
  ConsentSignatureEvidence,
  ConsentSignatureRequest,
} from './ports.js';

export type IdProofDrillScenario = 'pass' | 'fail' | 'outage';

export function createIdProofDrillDouble(scenario: IdProofDrillScenario): IdentityProofingPort {
  return {
    prove(request) {
      if (request.synthetic !== true) {
        throw new Error('idproof double accepts synthetic requests only');
      }
      if (scenario === 'outage') {
        throw new Error('idproof rail timeout (injected outage)');
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

/** An e-sign rail whose availability the drill flips; while down, every request throws. */
export interface EsignRailDouble extends ConsentEsignRail {
  setDown(down: boolean): void;
  requests(): readonly ConsentSignatureRequest[];
}

export function createEsignRailDouble(): EsignRailDouble {
  let down = false;
  const seen: ConsentSignatureRequest[] = [];
  return {
    setDown(value: boolean): void {
      down = value;
    },
    requests(): readonly ConsentSignatureRequest[] {
      return [...seen];
    },
    request(input: ConsentSignatureRequest): ConsentSignatureEvidence {
      if (input.synthetic !== true) throw new Error('esign double accepts synthetic requests only');
      if (down) throw new Error('esign rail unavailable (injected outage)');
      seen.push(input);
      return {
        requestId: input.requestId,
        tenantId: input.tenantId,
        documentId: input.documentId,
        versionNo: input.versionNo,
        status: 'signed',
        signerRefs: input.signerRefs,
        method: input.method,
        certificateHash: `synthetic-esign-cert:${input.requestId}`,
        signedAt: '2026-03-09T08:30:00Z',
        evidenceRef: `synthetic-esign-evidence:${input.requestId}`,
        synthetic: true,
      };
    },
  };
}
