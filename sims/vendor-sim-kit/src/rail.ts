/**
 * Rail declaration + the request/response shapes of the frozen scenario API
 * (docs/contracts/vendor-sim-scenario-api.md §2/§4/§6).
 */

import type { RailSimulatorKillPoint } from '@practicehub/platform-integration';

import type { InjectionOutcomeClass } from './primitives.js';
import type { SimEffectState } from './store.js';

export interface RailScenarioPreset {
  readonly presetId: string;
  readonly primitiveIds: readonly string[];
  /**
   * Ordinal of the scenario in this authority's row of the PRIVATE
   * authority-rail join. An index leaks no private prose while letting the
   * private `verify:adapters` step prove a bijection between named scenarios and
   * declared presets (the WP-026 "neutral id only" lesson).
   */
  readonly authorityScenarioIndex: number;
  readonly summary: string;
}

export interface RailRequest {
  readonly railId: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  /** Ref-grammar pointer to the caller's payload; the sim stores the ref, never a value. */
  readonly payloadRef: string;
  /** Caller-supplied instant — the sim owns no clock, so every run is reproducible. */
  readonly requestedAt: string;
  /** Hashed and discarded; there is no field in the ledger that can hold it. */
  readonly payload?: unknown;
  readonly synthetic: true;
}

export interface RailSim {
  /** `RAIL-###` — the neutral rail id. */
  readonly railId: string;
  /** `AUTH-###` — the authority-rail JOIN key. */
  readonly authorityId: string;
  readonly name: string;
  readonly pinnedVendorVersion: string;
  readonly operations: readonly string[];
  readonly presets: readonly RailScenarioPreset[];
  /** The rail's external-effect key for this request (its effect-key contract). */
  effectKeyFor(operation: string, request: RailRequest): string;
}

export const railResponseStatuses = [
  'accepted',
  'deduplicated',
  'uncertain',
  'rejected',
  'throttled',
  'unauthorized',
  'conflict',
  'unavailable',
  'malformed',
] as const;
export type RailResponseStatus = (typeof railResponseStatuses)[number];

export interface RailResponse {
  readonly railId: string;
  readonly operation: string;
  readonly status: RailResponseStatus;
  readonly effectKey: string;
  readonly idempotencyKey: string;
  readonly receiptRef: string | null;
  /** Set when the ledger resolved this request to an effect that already landed. */
  readonly duplicateOf: string | null;
  readonly requiresReconciliation: boolean;
  /**
   * Structural, LITERAL `false`: no dispatch path re-sends an external effect
   * for an idempotency key the ledger has already seen (the WP-026 late-outcome
   * device — an invariant the type system enforces, not a runtime hope).
   */
  readonly resendsExternalEffect: false;
  readonly injectedPrimitiveId: string | null;
  readonly outcomeClass: InjectionOutcomeClass | null;
  readonly declaredDelayMs: number;
  readonly retryAfterSeconds: number | null;
  readonly vendorVersion: string;
  readonly attempts: number;
  readonly effectState: SimEffectState;
  readonly synthetic: true;
}

export class SimProcessKill extends Error {
  public constructor(
    public readonly killPoint: RailSimulatorKillPoint,
    public readonly railId: string,
    public readonly idempotencyKey: string,
  ) {
    super(`rail ${railId} process-killed at ${killPoint} (idempotency-key ${idempotencyKey})`);
    this.name = 'SimProcessKill';
  }
}

export class RailSimError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RailSimError';
  }
}
