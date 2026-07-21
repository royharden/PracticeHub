/**
 * Jurisdiction overlays for consent (WP-018), discharging FWD-SR-018-CONSENT.
 * The consent ledger remains the evidence store; the WP-011 rule packs supply
 * the state-law obligations, effective-dated (ADR-ADJ-002). Every overlay is a
 * thin read over `resolveJurisdiction` — no statute is hardcoded here.
 *
 * Topics consumed (docs/contracts/jurisdiction-resolver.md vocabulary):
 *   records-consent      — MHRA expiry scalar + written-consent (R6-SR-040/041)
 *   chd-rights           — NV SB370 marketing opt-in / sale authorization (R6-SR-020)
 *   ai-disclosure        — FCC 24-17 ai_voice disclosure (R6-REQ-074)
 *   genetic-authorization— GIPA written authorization (R6-SR-031)
 */

import { resolveJurisdiction } from '@practicehub/platform-core';

import type { JurisdictionBasis, JurisdictionRulePack } from '@practicehub/platform-core';

import type { ConsentChannel, ConsentJurisdiction, ConsentPurpose } from './consent.js';

/** Map a recorded consent jurisdiction to the resolver's patient-state fact.
 * `virtual` is not a state — it resolves through the unknown safe defaults. */
export function jurisdictionToPatientState(jurisdiction: ConsentJurisdiction): string | null {
  return jurisdiction === 'virtual' ? null : jurisdiction;
}

/** Basis with the patient-state fact taken from the recorded jurisdiction; the
 * provider-state fact is supplied by the caller (unknown by default). */
export function consentBasis(
  jurisdiction: ConsentJurisdiction,
  providerState: string | null = null,
): JurisdictionBasis {
  return { providerState, patientState: jurisdictionToPatientState(jurisdiction) };
}

export interface RecordsConsentOverlay {
  /** Strictest consent life in days (MHRA min), if the topic sets it. */
  readonly consentExpiryDays?: number;
  readonly requiresWrittenConsent: boolean;
  readonly heightenedConsent: boolean;
  readonly counselReviewPending: boolean;
  readonly defaultsApplied: boolean;
  readonly obligations: readonly string[];
}

export function recordsConsentOverlay(
  packs: readonly JurisdictionRulePack[],
  basis: JurisdictionBasis,
  asOf?: string,
): RecordsConsentOverlay {
  const resolution = resolveJurisdiction(packs, basis, 'records-consent', asOf);
  const expiry = resolution.scalars['consent-expiry-days'];
  return {
    ...(expiry !== undefined ? { consentExpiryDays: expiry } : {}),
    requiresWrittenConsent:
      resolution.obligations.includes('written-consent') ||
      resolution.obligations.includes('hipaa-authorization'),
    heightenedConsent: resolution.obligations.includes('mh-heightened-consent'),
    counselReviewPending: resolution.counselReviewPending,
    defaultsApplied: resolution.defaultsApplied,
    obligations: resolution.obligations,
  };
}

export interface CommunicationOverlay {
  readonly chdOptInRequired: boolean;
  readonly chdSaleSeparateAuth: boolean;
  readonly aiDisclosureRequired: boolean;
  readonly counselReviewPending: boolean;
  readonly defaultsApplied: boolean;
  readonly obligations: readonly string[];
}

/**
 * Communication overlay for a (purpose, channel): marketing pulls the CHD
 * opt-in rules (NV SB370), an ai_voice channel pulls the AI-disclosure rules
 * (FCC 24-17). Both topics union when a marketing ai_voice send applies.
 */
export function communicationOverlay(
  packs: readonly JurisdictionRulePack[],
  basis: JurisdictionBasis,
  purpose: ConsentPurpose,
  channel: ConsentChannel,
  asOf?: string,
): CommunicationOverlay {
  const obligations = new Set<string>();
  let counselReviewPending = false;
  let defaultsApplied = false;
  if (purpose === 'marketing') {
    const chd = resolveJurisdiction(packs, basis, 'chd-rights', asOf);
    chd.obligations.forEach((obligation) => obligations.add(obligation));
    counselReviewPending = counselReviewPending || chd.counselReviewPending;
    defaultsApplied = defaultsApplied || chd.defaultsApplied;
  }
  if (channel === 'ai_voice') {
    const ai = resolveJurisdiction(packs, basis, 'ai-disclosure', asOf);
    ai.obligations.forEach((obligation) => obligations.add(obligation));
    counselReviewPending = counselReviewPending || ai.counselReviewPending;
    defaultsApplied = defaultsApplied || ai.defaultsApplied;
  }
  return {
    chdOptInRequired: obligations.has('chd-opt-in'),
    chdSaleSeparateAuth: obligations.has('chd-sale-separate-authorization'),
    aiDisclosureRequired: obligations.has('ai-disclosure'),
    counselReviewPending,
    defaultsApplied,
    obligations: [...obligations].sort(),
  };
}

export interface GeneticAuthorizationOverlay {
  readonly writtenAuthorizationRequired: boolean;
  readonly informedConsentRequired: boolean;
  readonly counselReviewPending: boolean;
  readonly defaultsApplied: boolean;
  readonly obligations: readonly string[];
}

export function geneticAuthorizationOverlay(
  packs: readonly JurisdictionRulePack[],
  basis: JurisdictionBasis,
  asOf?: string,
): GeneticAuthorizationOverlay {
  const resolution = resolveJurisdiction(packs, basis, 'genetic-authorization', asOf);
  return {
    writtenAuthorizationRequired: resolution.obligations.includes('gipa-written-authorization'),
    informedConsentRequired: resolution.obligations.includes('genetic-informed-consent'),
    counselReviewPending: resolution.counselReviewPending,
    defaultsApplied: resolution.defaultsApplied,
    obligations: resolution.obligations,
  };
}
