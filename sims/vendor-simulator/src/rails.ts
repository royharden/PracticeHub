/**
 * The first five rail sims (WP-027). Contract:
 * docs/contracts/vendor-sim-scenario-api.md (FROZEN) §4/§7.
 *
 * ADR-003 is normative that ONE `vendor-sim` service hosts every rail mock
 * behind one scenario-control API, so a rail is a module of this service rather
 * than a package of its own; WP-028's thirteen remaining rails are additive
 * files against the same framework.
 *
 * A rail declares WHAT it is (its neutral `RAIL-###` id, its authority-rail
 * `AUTH-###` JOIN key, its operations, its effect-key contract) and WHICH
 * scenarios of its authority row it covers — by ORDINAL, never by copying the
 * private join's scenario strings (the WP-026 "neutral id only" lesson). The
 * failure behaviour itself belongs to the rail-agnostic primitive catalog, so
 * every primitive drives every rail without per-rail special cases.
 */

import type { RailSim } from '@practicehub/vendor-sim-kit';

import { effectKeyFactory } from './effect-key.js';
import { remainingRailSimsV1 } from './rails-remaining.js';

/** Practice-management coexistence rail (athena-class). */
export const athenaSim: RailSim = {
  railId: 'RAIL-002',
  authorityId: 'AUTH-002',
  name: 'athena-sim',
  pinnedVendorVersion: 'pm-api-v1',
  operations: ['read-appointment', 'write-appointment', 'read-patient-summary'],
  presets: [
    {
      presetId: 'coexistence-version-conflict',
      primitiveIds: ['X-15', 'X-18'],
      authorityScenarioIndex: 0,
      summary:
        'The incumbent moved the resource under a cutover: a stale write conflicts, and the answer arrives from an unpinned version that must reconcile rather than overwrite.',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 60, volumeTolerance: 15, emitsIdleHeartbeat: true },
  effectKeyFor: effectKeyFactory('rail-002'),
};

/** CPaaS messaging + voice rail (twilio-class). */
export const twilioSim: RailSim = {
  railId: 'RAIL-003',
  authorityId: 'AUTH-001',
  name: 'twilio-sim',
  pinnedVendorVersion: 'cpaas-api-v1',
  operations: ['send-message', 'place-call', 'fetch-transcript'],
  presets: [
    {
      presetId: 'duplicate-then-late-receipt',
      primitiveIds: ['X-04', 'X-08'],
      authorityScenarioIndex: 0,
      summary:
        'The carrier double-fires a delivery receipt and then reports a late outcome across the fence; one message, three receipts, no second send.',
    },
    {
      presetId: 'transcript-unavailable',
      primitiveIds: ['X-16'],
      authorityScenarioIndex: 1,
      summary:
        'The voice artifact cannot be fetched: the call effect stands, its transcript does not, and nothing may be inferred from the absence.',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 120, volumeTolerance: 30, emitsIdleHeartbeat: true },
  effectKeyFor: effectKeyFactory('rail-003'),
};

/** Payment-processor rail (stripe-class). */
export const stripeSim: RailSim = {
  railId: 'RAIL-008',
  authorityId: 'AUTH-006',
  name: 'stripe-sim',
  pinnedVendorVersion: 'payments-api-v1',
  operations: ['create-payment-intent', 'refund', 'fetch-balance-transaction'],
  presets: [
    {
      presetId: 'webhook-gap-then-duplicate',
      primitiveIds: ['X-06', 'X-04'],
      authorityScenarioIndex: 0,
      summary:
        'The money moves but its webhook never lands, and the make-up delivery arrives twice; the ledger still holds exactly one payment effect.',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 25, volumeTolerance: 8, emitsIdleHeartbeat: true },
  effectKeyFor: effectKeyFactory('rail-008'),
};

/** Email service provider rail (deliverability/ESP-class). */
export const espSim: RailSim = {
  railId: 'RAIL-009',
  authorityId: 'AUTH-018',
  name: 'esp-sim',
  pinnedVendorVersion: 'esp-api-v1',
  operations: ['send-email', 'fetch-suppression-list'],
  presets: [
    {
      presetId: 'bounce-then-late-complaint',
      primitiveIds: ['X-12', 'X-08'],
      authorityScenarioIndex: 0,
      summary:
        'The address bounces (no effect lands) and a complaint arrives late; both suppress future sends and neither can resubscribe anyone.',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 50, volumeTolerance: 15, emitsIdleHeartbeat: false },
  effectKeyFor: effectKeyFactory('rail-009'),
};

/** AI model provider rail (D5.5 `dev` provider mode only). */
export const modelSim: RailSim = {
  railId: 'RAIL-022',
  authorityId: 'AUTH-019',
  name: 'model-sim',
  pinnedVendorVersion: 'model-api-v1',
  operations: ['complete', 'embed'],
  presets: [
    {
      presetId: 'prompt-version-drift',
      primitiveIds: ['X-18', 'X-17'],
      authorityScenarioIndex: 0,
      summary:
        'The provider answers from a model version other than the pinned one, then returns a payload its own contract forbids; a stale output can never regain tool authority.',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 35, volumeTolerance: 10, emitsIdleHeartbeat: false },
  effectKeyFor: effectKeyFactory('rail-022'),
};

/**
 * The rails this service registers, in rail-id order — the WP-027 five plus the
 * WP-028 remainder. One registry, one boot unit (ADR-003): every gate, probe,
 * and fixture floor reads this list, so a rail cannot be delivered half-way.
 */
export const railSimsV1: readonly RailSim[] = [
  athenaSim,
  twilioSim,
  stripeSim,
  espSim,
  modelSim,
  ...remainingRailSimsV1,
].sort((left, right) => left.railId.localeCompare(right.railId));
