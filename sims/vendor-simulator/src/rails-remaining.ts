/**
 * The remaining rail sims (WP-028). Contract:
 * docs/contracts/rail-sim-fleet.md (FROZEN) §2/§3/§5.
 *
 * ADR-003 keeps ONE simulator service hosting every rail behind one
 * scenario-control API, so a rail is a module of that service — these twelve are
 * additive files against the WP-027 framework, exactly as its header anticipated.
 * Nothing here re-implements failure behaviour: primitives are rail-agnostic, so
 * a rail declares only WHAT it is (its neutral `RAIL-###` id, its authority-rail
 * `AUTH-###` JOIN key, its operations, its effect-key contract, its expected
 * volume band) and WHICH of its authority's scenarios it covers, BY ORDINAL.
 *
 * Presets never mirror the private join's scenario strings (the WP-026 lesson):
 * the ordinal is the binding, and each summary is this file's own neutral
 * description of the failure story that ordinal names.
 */

import type { RailSim } from '@practicehub/vendor-sim-kit';

import { effectKeyFactory } from './effect-key.js';

/** Fax transmission rail (Documo-class): pages land, and partial pages are a disclosure fact. */
export const faxSim: RailSim = {
  railId: 'RAIL-005',
  authorityId: 'AUTH-016',
  name: 'fax-sim',
  pinnedVendorVersion: 'fax-api-v1',
  operations: ['send-fax', 'fetch-transmission-status', 'fetch-inbound-fax'],
  presets: [
    {
      presetId: 'partial-pages-then-duplicate-receipt',
      primitiveIds: ['X-11', 'X-04'],
      authorityScenarioIndex: 0,
      summary:
        'Some pages transmit and the rest do not, then the destination confirms the same transmission twice; the disclosure accounting owes the partial page set, and the second confirmation adds no second transmission.',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 12, volumeTolerance: 4, emitsIdleHeartbeat: true },
  effectKeyFor: effectKeyFactory('rail-005'),
};

/** Telehealth media rail (video SDK-class): the platform never operates media infrastructure. */
export const videoSim: RailSim = {
  railId: 'RAIL-006',
  authorityId: 'AUTH-017',
  name: 'video-sim',
  pinnedVendorVersion: 'video-api-v1',
  operations: ['create-session', 'join-session', 'fetch-session-events'],
  presets: [
    {
      presetId: 'media-drop-then-late-event',
      primitiveIds: ['X-16', 'X-08'],
      authorityScenarioIndex: 0,
      summary:
        'The media path drops mid-visit and its event arrives after the fact; a rejoin is a new media session and no late media event may mutate the clinical encounter.',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 8, volumeTolerance: 3, emitsIdleHeartbeat: false },
  effectKeyFor: effectKeyFactory('rail-006'),
};

/** Signature-transport rail (trust-service class). */
export const esignSim: RailSim = {
  railId: 'RAIL-007',
  authorityId: 'AUTH-004',
  name: 'esign-sim-rail',
  pinnedVendorVersion: 'esign-api-v1',
  operations: ['create-envelope', 'send-envelope', 'fetch-envelope-status'],
  presets: [
    {
      presetId: 'callback-lost-then-late',
      primitiveIds: ['X-06', 'X-08'],
      authorityScenarioIndex: 1,
      summary:
        'The signature completes but its callback never lands, and the make-up notice arrives across the fence; the envelope is not re-sent, and the signed artifact is reconciled rather than re-collected.',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 6, volumeTolerance: 2, emitsIdleHeartbeat: false },
  effectKeyFor: effectKeyFactory('rail-007'),
};

/** Public-platform review rail: sentiment-blind invitations and responses. */
export const reviewsSim: RailSim = {
  railId: 'RAIL-010',
  authorityId: 'AUTH-001',
  name: 'reviews-sim',
  pinnedVendorVersion: 'reviews-api-v1',
  operations: ['request-review-invite', 'publish-response', 'fetch-listing'],
  presets: [
    {
      presetId: 'platform-throttle-then-duplicate',
      primitiveIds: ['X-13', 'X-04'],
      authorityScenarioIndex: 2,
      summary:
        'The public platform throttles the invitation and then double-confirms the one it accepted; the eligibility decision is unchanged and no patient is invited twice.',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 4, volumeTolerance: 2, emitsIdleHeartbeat: false },
  effectKeyFor: effectKeyFactory('rail-010'),
};

/** Diagnostic/device interface rail (reference-lab and analyzer class). */
export const labSim: RailSim = {
  railId: 'RAIL-011',
  authorityId: 'AUTH-015',
  name: 'lab-sim',
  pinnedVendorVersion: 'lab-interface-v1',
  operations: ['place-order', 'fetch-result', 'acknowledge-critical-result'],
  presets: [
    {
      presetId: 'corrected-result-then-late-critical',
      primitiveIds: ['X-09', 'X-08'],
      authorityScenarioIndex: 0,
      summary:
        'A result is superseded by a correction and a critical value arrives late; the prior version is preserved with its lineage and the closure obligation reopens rather than resolving itself.',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 30, volumeTolerance: 8, emitsIdleHeartbeat: true },
  effectKeyFor: effectKeyFactory('rail-011'),
};

/** Imaging / outbound referral-destination rail. */
export const imagingSim: RailSim = {
  railId: 'RAIL-012',
  authorityId: 'AUTH-008',
  name: 'imaging-sim',
  pinnedVendorVersion: 'imaging-api-v1',
  operations: ['place-order', 'fetch-report', 'fetch-destination-directory'],
  presets: [
    {
      presetId: 'destination-rejects-then-splits',
      primitiveIds: ['X-12', 'X-11'],
      authorityScenarioIndex: 1,
      summary:
        'The receiving destination refuses the order outright, and a re-routed one completes only in part; neither outcome closes the loop, and the open milestone survives both.',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 10, volumeTolerance: 4, emitsIdleHeartbeat: false },
  effectKeyFor: effectKeyFactory('rail-012'),
};

/** Identity-proofing rail (the transport half of the WP-013 proofing port). */
export const idProofSim: RailSim = {
  railId: 'RAIL-013',
  authorityId: 'AUTH-003',
  name: 'idproof-sim-rail',
  pinnedVendorVersion: 'idproof-api-v1',
  operations: ['start-proofing', 'fetch-proofing-result', 'verify-proxy-relationship'],
  presets: [
    {
      presetId: 'proofing-refused-then-uncertain',
      primitiveIds: ['X-12', 'X-05'],
      authorityScenarioIndex: 1,
      summary:
        'The proofing provider refuses the assertion, and a retry ends uncertain; neither outcome may be read as a verified relationship, and an unresolved proxy claim stays with a human.',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 5, volumeTolerance: 2, emitsIdleHeartbeat: false },
  effectKeyFor: effectKeyFactory('rail-013'),
};

/** Prescribing rail, vendor path (DoseSpot-class embed). */
export const erxVendorSim: RailSim = {
  railId: 'RAIL-014',
  authorityId: 'AUTH-009',
  name: 'erx-vendor-sim',
  pinnedVendorVersion: 'erx-vendor-api-v1',
  operations: ['submit-prescription', 'fetch-transaction-status', 'fetch-pharmacy-directory'],
  presets: [
    {
      presetId: 'vendor-duplicate-then-unknown',
      primitiveIds: ['X-04', 'X-05'],
      authorityScenarioIndex: 0,
      summary:
        'The vendor confirms one transaction twice and then leaves the next in doubt; the pending prescription is reconciled against the vendor record and never re-transmitted on suspicion.',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 20, volumeTolerance: 6, emitsIdleHeartbeat: true },
  effectKeyFor: effectKeyFactory('rail-014'),
};

/**
 * Prescribing rail, native network path (NCPDP SCRIPT class), including the
 * prescription-monitoring query its own authority names among the activation
 * evidence. The rail is transport only — the composer, the signing workflow, and
 * the shadow/live states are module logic (D5.3), and this path stays dark until
 * its certification waits clear.
 */
export const erxNetworkSim: RailSim = {
  railId: 'RAIL-015',
  authorityId: 'AUTH-010',
  name: 'erx-network-sim',
  pinnedVendorVersion: 'erx-network-api-v1',
  operations: [
    'transmit-script',
    'fetch-network-status',
    'query-prescription-monitoring',
    'fetch-directory-entry',
  ],
  presets: [
    {
      presetId: 'uncertain-transmit-then-late-outcome',
      primitiveIds: ['X-05', 'X-08'],
      authorityScenarioIndex: 0,
      summary:
        'The network neither accepts nor refuses, and the real outcome lands later; the correction/reversal path reopens on the late outcome and a blind re-transmit has no code path.',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 20, volumeTolerance: 6, emitsIdleHeartbeat: true },
  effectKeyFor: effectKeyFactory('rail-015'),
};

/** Licensed-content rail: a read authority whose absence disables dependent commands. */
export const compendiumSim: RailSim = {
  railId: 'RAIL-016',
  authorityId: 'AUTH-023',
  name: 'compendium-sim',
  pinnedVendorVersion: 'content-api-v1',
  operations: ['fetch-edition', 'fetch-drug-entry', 'fetch-code-entry'],
  presets: [
    {
      presetId: 'content-unavailable-then-rights-refused',
      primitiveIds: ['X-16', 'X-14'],
      authorityScenarioIndex: 0,
      summary:
        'The licensed edition cannot be read, and the retry is refused for rights rather than reachability; dependent commands are disabled in both cases and historical decisions keep their pinned edition.',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 1, volumeTolerance: 0, emitsIdleHeartbeat: true },
  effectKeyFor: effectKeyFactory('rail-016'),
};

/** Payer eligibility/portal rail. */
export const payerPortalSim: RailSim = {
  railId: 'RAIL-017',
  authorityId: 'AUTH-011',
  name: 'payerportal-sim',
  pinnedVendorVersion: 'payer-portal-v1',
  operations: ['check-eligibility', 'fetch-benefit-detail'],
  presets: [
    {
      presetId: 'duplicate-then-reordered-responses',
      primitiveIds: ['X-04', 'X-07'],
      authorityScenarioIndex: 0,
      summary:
        'The payer answers the same request twice and then out of order; each response stays versioned evidence with an explicit freshness, and the newest arrival is not automatically the newest truth.',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 40, volumeTolerance: 10, emitsIdleHeartbeat: false },
  effectKeyFor: effectKeyFactory('rail-017'),
};

/** Claim-submission clearinghouse rail. */
export const clearinghouseSim: RailSim = {
  railId: 'RAIL-018',
  authorityId: 'AUTH-012',
  name: 'clearinghouse-sim',
  pinnedVendorVersion: 'clearinghouse-api-v1',
  operations: ['submit-claim-batch', 'fetch-acknowledgment', 'fetch-batch-status'],
  presets: [
    {
      presetId: 'batch-splits-mid-transmission',
      primitiveIds: ['X-11', 'X-05'],
      authorityScenarioIndex: 0,
      summary:
        'A batch lands only in part and the remainder ends uncertain; the frozen attempt owns the claims it carried, and no claim may be submitted a second time to resolve the doubt.',
    },
  ],
  heartbeat: { expectedEffectsPerWindow: 15, volumeTolerance: 5, emitsIdleHeartbeat: true },
  effectKeyFor: effectKeyFactory('rail-018'),
};

/** The rails WP-028 adds, in rail-id order. */
export const remainingRailSimsV1: readonly RailSim[] = [
  faxSim,
  videoSim,
  esignSim,
  reviewsSim,
  labSim,
  imagingSim,
  idProofSim,
  erxVendorSim,
  erxNetworkSim,
  compendiumSim,
  payerPortalSim,
  clearinghouseSim,
];
