/**
 * Pre-auth elevation unit suite (WP-014; REQ-PORT-002 / REQ-PORT-009 authn
 * half). Contract: docs/contracts/session-api.md. The exhaustive property:
 * NO combination of possession signals authenticates — only a consumed
 * verified-channel challenge does.
 */
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import { issueChallenge, consumeChallenge, type AuthChallenge } from './authn.js';
import {
  assertElevationBasis,
  attemptElevation,
  beginElevation,
  completeElevation,
  declineOrFailElevation,
  detectWrongPersonResume,
  elevationInsufficientSignals,
  resumePreAuthSession,
  type PreAuthSession,
} from './elevation.js';
import type { EndpointAssociation } from './endpoints.js';

const tenant = 'northwind-synthetic' as TenantId;
const alex = 'np-alex-rivera' as PersonId;
const casey = 'np-casey-rivera' as PersonId;

const verifiedAssociation: EndpointAssociation = {
  tenantId: tenant,
  endpointId: 'nce-alex-portal-email',
  personId: alex,
  relationship: 'self',
  verification: 'verified',
  evidenceRef: 'synthetic-endpoint-evidence-0002',
  source: 'synthetic-portal-enrollment',
  synthetic: true,
};

const preAuth: PreAuthSession = {
  preAuthRef: 'npa-webchat-0001',
  tenantId: tenant,
  caseRef: 'case-7f3a',
  approvedPublicTopics: ['hours', 'services', 'insurance-accepted'],
  consentedLeadFields: { interest: 'membership' },
  synthetic: true,
};

function pendingElevation(): AuthChallenge {
  return issueChallenge([verifiedAssociation], {
    challengeId: 'nch-elev-0001',
    tenantId: tenant,
    personId: alex,
    endpointId: 'nce-alex-portal-email',
    purpose: 'elevation',
    method: 'otp',
    issuedAt: '2026-03-05T18:00:00Z',
    expiresAt: '2026-03-05T18:10:00Z',
    maxAttempts: 3,
    synthetic: true,
  });
}

function allSignalSubsets(): (typeof elevationInsufficientSignals)[number][][] {
  const subsets: (typeof elevationInsufficientSignals)[number][][] = [];
  const count = 2 ** elevationInsufficientSignals.length;
  for (let mask = 0; mask < count; mask += 1) {
    subsets.push(elevationInsufficientSignals.filter((_, index) => mask & (1 << index)));
  }
  return subsets;
}

describe('the structural exclusion — possession never authenticates', () => {
  it('EVERY subset of possession signals (all 64) fails without a consumed challenge', () => {
    for (const subset of allSignalSubsets()) {
      expect(() => assertElevationBasis({ presentedSignals: subset })).toThrow(
        /can never authenticate/,
      );
    }
  });

  it('an unconsumed or wrong-purpose challenge does not authenticate either', () => {
    expect(() =>
      assertElevationBasis({ presentedSignals: [], consumedChallenge: pendingElevation() }),
    ).toThrow(/consumed verified-channel challenge/);
    const loginChallenge = consumeChallenge(
      issueChallenge([verifiedAssociation], {
        challengeId: 'nch-login-0009',
        tenantId: tenant,
        personId: alex,
        endpointId: 'nce-alex-portal-email',
        purpose: 'portal-login',
        method: 'otp',
        issuedAt: '2026-03-05T18:00:00Z',
        expiresAt: '2026-03-05T18:10:00Z',
        maxAttempts: 3,
        synthetic: true,
      }),
      '2026-03-05T18:01:00Z',
    ).challenge;
    expect(() =>
      assertElevationBasis({ presentedSignals: [], consumedChallenge: loginChallenge }),
    ).toThrow(/not elevation/);
  });
});

describe('REQ-PORT-002 — elevate webchat identity before PHI disclosure', () => {
  it('beginElevation states why verification is needed (AC-2)', () => {
    const prompt = beginElevation(preAuth, pendingElevation());
    expect(prompt.explanation).toContain('verification');
    expect(prompt.challenge.purpose).toBe('elevation');
  });

  it('completeElevation links the governed identity; marketing analytics get NO identity/clinical detail (AC-2)', () => {
    const consumed = consumeChallenge(pendingElevation(), '2026-03-05T18:01:00Z').challenge;
    const link = completeElevation(preAuth, {
      presentedSignals: ['cookie'],
      consumedChallenge: consumed,
    });
    expect(link.governedPersonId).toBe(alex);
    expect(link.verifiedBy).toBe('verified-channel-challenge');
    const serialized = JSON.stringify(link.marketingAnalyticsPayload);
    expect(serialized).not.toContain(alex);
    expect(serialized).not.toContain('clinical');
    expect(link.marketingAnalyticsPayload).toEqual({
      preAuthRef: 'npa-webchat-0001',
      event: 'identity-elevated',
    });
  });

  it('declined or failed verification withholds person-specific content and offers human paths (AC-3)', () => {
    const directive = declineOrFailElevation(preAuth);
    expect(directive).toEqual({
      preAuthRef: 'npa-webchat-0001',
      personSpecificWithheld: true,
      humanPathOffered: true,
      secureChannelPathOffered: true,
    });
  });

  it('an expired challenge attempt resolves to the decline directive, never a third path', () => {
    const attempt = attemptElevation(preAuth, pendingElevation(), '2026-03-05T19:00:00Z');
    expect(attempt.outcome).toBe('declined');
  });
});

describe('REQ-PORT-009 — resume without replaying PHI', () => {
  it('a resumed pre-auth shows public topics, consented lead facts, and the neutral case reference only (AC-1)', () => {
    const resumed = resumePreAuthSession(preAuth);
    expect(resumed.visible).toEqual({
      approvedPublicTopics: ['hours', 'services', 'insurance-accepted'],
      consentedLeadFields: { interest: 'membership' },
      caseRef: 'case-7f3a',
    });
    expect(resumed.personSpecificRequires).toBe('fresh-verification');
    expect(JSON.stringify(resumed)).not.toContain('np-');
  });

  it('successful fresh verification retrieves governed context without an analytics copy (AC-2)', () => {
    const attempt = attemptElevation(preAuth, pendingElevation(), '2026-03-05T18:01:00Z');
    expect(attempt.outcome).toBe('elevated');
    if (attempt.outcome === 'elevated') {
      expect(attempt.link.governedPersonId).toBe(alex);
      expect(JSON.stringify(attempt.link.marketingAnalyticsPayload)).not.toContain(alex);
    }
  });

  it('a wrong-person resume protects the old context and starts a new public conversation (AC-3)', () => {
    const attempt = attemptElevation(preAuth, pendingElevation(), '2026-03-05T18:01:00Z');
    if (attempt.outcome !== 'elevated') {
      throw new Error('expected elevation');
    }
    const directive = detectWrongPersonResume(preAuth, casey, attempt.link, 'npa-webchat-0002');
    expect(directive).not.toBeNull();
    expect(directive?.priorContextProtected).toBe(true);
    expect(directive?.newPublicSession.consentedLeadFields).toEqual({});
    expect(directive?.newPublicSession.caseRef).not.toBe(preAuth.caseRef);
    expect(detectWrongPersonResume(preAuth, alex, attempt.link, 'npa-webchat-0003')).toBeNull();
  });
});
