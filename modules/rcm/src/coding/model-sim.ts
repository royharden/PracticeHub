import { createHash } from 'node:crypto';

import { RcmShadowError } from '../contracts.js';

import type {
  CodingGatewayDecision,
  CodingGatewayPort,
  CodingGatewayRequest,
  CodingModelPin,
} from './gateway-port.js';

/** One scripted model-sim answer per encounter subject. Synthetic only. */
export type ModelSimScript =
  | { readonly kind: 'suggest'; readonly body: string }
  | { readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'stale'; readonly reason: string }
  | { readonly kind: 'contained' };

export const MODEL_SIM_CODING_PIN: CodingModelPin = {
  modelRef: 'model-sim:coding',
  pinnedModelVersion: 'model-sim-coding-1',
  promptTemplateVersion: 'rcm-coding-prompt-1',
  bindingVersion: 1,
  grantVersion: 1,
};

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export interface ModelSimCodingGateway extends CodingGatewayPort {
  readonly calls: readonly CodingGatewayRequest[];
}

/**
 * A deterministic stand-in for the gateway in `dev` mode (D5.5). It records every call so tests can
 * prove the kill switch stops traffic before it reaches the gateway.
 */
export function createModelSimCodingGateway(
  scripts: Readonly<Record<string, ModelSimScript>>,
  pin: CodingModelPin = MODEL_SIM_CODING_PIN,
): ModelSimCodingGateway {
  const calls: CodingGatewayRequest[] = [];
  const outputs = new Map<string, { tenantId: string; body: string; hash: string }>();
  return {
    pin,
    calls,
    invoke(request: CodingGatewayRequest): Promise<CodingGatewayDecision> {
      calls.push(request);
      const script = scripts[request.subjectRef];
      if (script === undefined || script.kind === 'blocked') {
        return Promise.resolve({
          kind: 'blocked',
          interactionRef: request.interactionRef,
          reason: script?.reason ?? 'invalid-request',
        });
      }
      if (script.kind === 'stale') {
        return Promise.resolve({
          kind: 'stale',
          interactionRef: request.interactionRef,
          reason: script.reason,
        });
      }
      if (script.kind === 'contained') {
        return Promise.resolve({
          kind: 'contained',
          interactionRef: request.interactionRef,
          fallbackRef: `fallback:human:${request.useCase}`,
        });
      }
      const outputRef = `object:model-sim:${request.interactionRef}`;
      const hash = sha256(script.body);
      outputs.set(outputRef, { tenantId: request.tenantId, body: script.body, hash });
      return Promise.resolve({
        kind: 'completed',
        interactionRef: request.interactionRef,
        outputRef,
        outputHash: hash,
      });
    },
    readOutput(tenantId: string, outputRef: string, outputHash: string): Promise<string> {
      const stored = outputs.get(outputRef);
      if (stored?.tenantId !== tenantId || stored.hash !== outputHash) {
        return Promise.reject(
          new RcmShadowError('CODING_OUTPUT_SCOPE', 'output object is not readable in scope'),
        );
      }
      return Promise.resolve(stored.body);
    },
  };
}
