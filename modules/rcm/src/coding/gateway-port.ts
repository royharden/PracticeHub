/**
 * The slice of the M08 AI gateway (modules/ai-gateway, WP-100) that the coding worklist uses.
 * `@practicehub/rcm` does not depend on `@practicehub/ai-gateway` yet, so these types restate
 * the gateway's decision union by shape. An `AiGateway` adapter binds here once the package
 * dependency is added (see the WP-087 READY receipt).
 */

import type { CODING_SUGGESTION_USE_CASE } from './types.js';

/** The fields the worklist controls; the adapter fills the gateway's evidence ids and snapshots. */
export interface CodingGatewayRequest {
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly useCase: typeof CODING_SUGGESTION_USE_CASE;
  readonly actorRef: string;
  readonly purpose: 'coding-suggestion-for-human-review';
  readonly interactionRef: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly mode: 'dev';
  readonly contentRefs: readonly { readonly bodyRef: string; readonly bodyHash: string }[];
  readonly synthetic: true;
}

/** Mirrors `AiGatewayDecision` in modules/ai-gateway/src/types.ts, restricted to what WP-087 reads. */
export type CodingGatewayDecision =
  | {
      readonly kind: 'completed';
      readonly interactionRef: string;
      readonly outputRef: string;
      readonly outputHash: string;
    }
  | {
      readonly kind: 'blocked';
      readonly interactionRef: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'stale';
      readonly interactionRef: string;
      readonly reason: string;
    }
  | {
      readonly kind: 'contained';
      readonly interactionRef: string;
      readonly fallbackRef: string;
    };

/** The model binding and grant versions the gateway pinned for this use case. */
export interface CodingModelPin {
  readonly modelRef: string;
  readonly pinnedModelVersion: string;
  readonly promptTemplateVersion: string;
  readonly bindingVersion: number;
  readonly grantVersion: number;
}

export interface CodingGatewayPort {
  readonly pin: CodingModelPin;
  invoke(request: CodingGatewayRequest): Promise<CodingGatewayDecision>;
  /** Reads a completed decision's output object; refuses when the hash does not match. */
  readOutput(tenantId: string, outputRef: string, outputHash: string): Promise<string>;
}

/** The M08 kill switch as seen by this worklist (WP-105 console; WP-100 containment). */
export interface CodingKillSwitchPort {
  engaged(tenantId: string, useCase: typeof CODING_SUGGESTION_USE_CASE): boolean;
}
