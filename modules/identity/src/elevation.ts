/**
 * Pre-auth identity elevation (WP-014; the authn half of REQ-PORT-002 /
 * REQ-PORT-009). Contract: docs/contracts/session-api.md (FROZEN).
 *
 * The gate property mirrors WP-013's merge-sufficiency exclusion: possession
 * signals — a cookie, a transcript, a campaign link, knowledge of prior
 * questions, an asserted name — can NEVER authenticate a person, alone or in
 * any combination. Elevation happens only through a fresh verified-channel
 * factor, and a browser session never becomes durable clinical authority.
 *
 * The webchat THREAD substance (store, routing, analytics pipeline) is
 * WP-042/WP-044 scope (FWD-AUTH-042-INTAKE / FWD-AUTH-044-WEBCHAT).
 */

import type { PersonId, TenantId } from '@practicehub/contracts';

import { consumeChallenge, AuthnInvariantError, type AuthChallenge } from './authn.js';
import { assertIdentityId } from './identity.js';

/**
 * A public webchat session before any verification: approved public content,
 * consented lead fields, and a NEUTRAL case reference only. The shape has
 * nowhere to put PHI, a person id, or clinical context — pre-auth continuity
 * is structurally public (REQ-PORT-009 AC-1).
 */
export interface PreAuthSession {
  readonly preAuthRef: string;
  readonly tenantId: TenantId;
  /** Neutral continuation handle — carries no identity or clinical meaning. */
  readonly caseRef: string;
  readonly approvedPublicTopics: readonly string[];
  readonly consentedLeadFields: Readonly<Record<string, string>>;
  readonly synthetic: boolean;
}

/**
 * Possession/inference signals that are structurally NEVER
 * elevation-sufficient (REQ-PORT-002 exception; REQ-PORT-009 exception).
 */
export const elevationInsufficientSignals = [
  'cookie',
  'browser-session',
  'transcript-possession',
  'campaign-link',
  'conversational-knowledge',
  'name-assertion',
] as const;
export type ElevationInsufficientSignal = (typeof elevationInsufficientSignals)[number];

export interface ElevationBasis {
  /** Signals that were present; recorded, contribute nothing to authentication. */
  readonly presentedSignals: readonly ElevationInsufficientSignal[];
  /** The only thing that authenticates: a consumed verified-channel challenge. */
  readonly consumedChallenge?: AuthChallenge;
}

/**
 * The structural exclusion: no set of possession signals authenticates.
 * Only a consumed elevation challenge (delivered over a verified endpoint
 * association by `issueChallenge`) does.
 */
export function assertElevationBasis(basis: ElevationBasis): AuthChallenge {
  const challenge = basis.consumedChallenge;
  if (challenge === undefined || challenge.consumedAt === undefined) {
    throw new AuthnInvariantError(
      'identity elevation requires a consumed verified-channel challenge; ' +
        `possession signals (${basis.presentedSignals.join(', ') || 'none'}) can never ` +
        'authenticate a person or proxy (session-api.md structural exclusion)',
    );
  }
  if (challenge.purpose !== 'elevation') {
    throw new AuthnInvariantError(
      `challenge ${challenge.challengeId} was issued for ${challenge.purpose}, not elevation`,
    );
  }
  return challenge;
}

export interface ElevationPrompt {
  readonly preAuthRef: string;
  /** REQ-PORT-002 AC-2: the person sees why verification is needed. */
  readonly explanation: string;
  readonly challenge: AuthChallenge;
}

/**
 * Begin elevation when person-specific content is requested: state why
 * verification is needed and hand back the pending verified-channel
 * challenge. The challenge must have been issued by `issueChallenge` (which
 * enforces the verified-association rule).
 */
export function beginElevation(
  preAuth: PreAuthSession,
  pendingChallenge: AuthChallenge,
): ElevationPrompt {
  assertIdentityId(preAuth.preAuthRef, 'preAuthRef');
  if (pendingChallenge.purpose !== 'elevation') {
    throw new AuthnInvariantError(
      `challenge ${pendingChallenge.challengeId} was issued for ${pendingChallenge.purpose}; ` +
        'elevation needs an elevation-purpose challenge',
    );
  }
  return {
    preAuthRef: preAuth.preAuthRef,
    explanation:
      'Person-specific information needs identity verification so a marketing/browser ' +
      'session never becomes clinical authority; a code will be sent to your verified contact.',
    challenge: pendingChallenge,
  };
}

export interface ElevatedLink {
  readonly preAuthRef: string;
  /** The governed identity the VERIFIED session now links to. */
  readonly governedPersonId: PersonId;
  readonly verifiedBy: 'verified-channel-challenge';
  /**
   * What marketing analytics may receive about this elevation (REQ-PORT-002
   * AC-2): the pre-auth reference and an elevation marker ONLY — structurally
   * excludes the governed identity and any clinical detail.
   */
  readonly marketingAnalyticsPayload: {
    readonly preAuthRef: string;
    readonly event: 'identity-elevated';
  };
}

/** Complete elevation from a consumed elevation challenge. */
export function completeElevation(preAuth: PreAuthSession, basis: ElevationBasis): ElevatedLink {
  const challenge = assertElevationBasis(basis);
  return {
    preAuthRef: preAuth.preAuthRef,
    governedPersonId: challenge.personId,
    verifiedBy: 'verified-channel-challenge',
    marketingAnalyticsPayload: { preAuthRef: preAuth.preAuthRef, event: 'identity-elevated' },
  };
}

export interface ElevationDeclineDirective {
  readonly preAuthRef: string;
  readonly personSpecificWithheld: true;
  readonly humanPathOffered: true;
  readonly secureChannelPathOffered: true;
}

/**
 * Verification failed or was declined (REQ-PORT-002 AC-3): person-specific
 * information stays withheld and the person is offered a human or
 * secure-channel path — the conversation may continue on public content.
 */
export function declineOrFailElevation(preAuth: PreAuthSession): ElevationDeclineDirective {
  return {
    preAuthRef: preAuth.preAuthRef,
    personSpecificWithheld: true,
    humanPathOffered: true,
    secureChannelPathOffered: true,
  };
}

export interface ResumedPreAuth {
  readonly session: PreAuthSession;
  /** REQ-PORT-009 AC-1: what a resume may show before fresh verification. */
  readonly visible: {
    readonly approvedPublicTopics: readonly string[];
    readonly consentedLeadFields: Readonly<Record<string, string>>;
    readonly caseRef: string;
  };
  readonly personSpecificRequires: 'fresh-verification';
}

/**
 * Resume an abandoned pre-auth conversation (REQ-PORT-009 AC-1/AC-2): public
 * context and the neutral case reference come back; person-specific work
 * requires fresh verification — a prior browser session is not durable
 * authority, so there is nothing here that COULD replay PHI.
 */
export function resumePreAuthSession(prior: PreAuthSession): ResumedPreAuth {
  return {
    session: prior,
    visible: {
      approvedPublicTopics: prior.approvedPublicTopics,
      consentedLeadFields: prior.consentedLeadFields,
      caseRef: prior.caseRef,
    },
    personSpecificRequires: 'fresh-verification',
  };
}

export interface WrongPersonResumeDirective {
  readonly priorContextProtected: true;
  readonly newPublicSession: PreAuthSession;
}

/**
 * The resumed session belongs to someone else (REQ-PORT-009 AC-3): elevation
 * resolved a DIFFERENT person than the prior conversation's subject — the old
 * context stays protected and a fresh public conversation starts.
 */
export function detectWrongPersonResume(
  prior: PreAuthSession,
  priorSubjectPersonId: PersonId,
  elevated: ElevatedLink,
  newPreAuthRef: string,
): WrongPersonResumeDirective | null {
  if (elevated.governedPersonId === priorSubjectPersonId) {
    return null;
  }
  return {
    priorContextProtected: true,
    newPublicSession: {
      preAuthRef: newPreAuthRef,
      tenantId: prior.tenantId,
      caseRef: `${newPreAuthRef}-case`,
      approvedPublicTopics: prior.approvedPublicTopics,
      consentedLeadFields: {},
      synthetic: prior.synthetic,
    },
  };
}

/**
 * Convenience composition for the e2e path: attempt to consume the elevation
 * challenge and either complete the link or return the decline directive —
 * the two REQ-PORT-002 outcomes, with no third path.
 */
export function attemptElevation(
  preAuth: PreAuthSession,
  pendingChallenge: AuthChallenge,
  atIso: string,
  presentedSignals: readonly ElevationInsufficientSignal[] = [],
):
  | { outcome: 'elevated'; link: ElevatedLink }
  | { outcome: 'declined'; directive: ElevationDeclineDirective } {
  const consumption = consumeChallenge(pendingChallenge, atIso);
  if (consumption.outcome !== 'consumed') {
    return { outcome: 'declined', directive: declineOrFailElevation(preAuth) };
  }
  return {
    outcome: 'elevated',
    link: completeElevation(preAuth, {
      presentedSignals,
      consumedChallenge: consumption.challenge,
    }),
  };
}
