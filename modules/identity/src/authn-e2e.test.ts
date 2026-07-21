/**
 * AuthN end-to-end journeys (the WP-014 verification gate: "authn e2e incl.
 * step-up; lockout-recovery path"). Each journey drives the real domain
 * functions across the full path — issuance through policy enforcement
 * through recovery — with no step stubbed.
 */
import { describe, expect, it } from 'vitest';

import type { PersonId, TenancyContext, TenantId } from '@practicehub/contracts';
import type { ConfigEntry } from '@practicehub/platform-core';

import {
  consumeChallenge,
  enforceConcurrentSessionLimit,
  evaluateIdle,
  issueChallenge,
  issuePortalSession,
  issueStaffSession,
  lockIdleSession,
  recordActivity,
  recordStepUp,
  recoverLockout,
  registerFailedAttempt,
  requireStepUp,
  resolveSessionPolicy,
  sessionPolicyKey,
  type AuthCredential,
  type AuthDevice,
  type FailedAttemptState,
} from './authn.js';
import { raiseAtoLockdown, releaseLockdown } from './ato.js';
import type { EndpointAssociation } from './endpoints.js';

const tenant = 'northwind-synthetic' as TenantId;
const context: TenancyContext = { tenantId: tenant };
const morgan = 'np-morgan-lee' as PersonId;
const alex = 'np-alex-rivera' as PersonId;

const staffCredentials: readonly AuthCredential[] = [
  {
    credentialId: 'ncr-morgan-password',
    tenantId: tenant,
    personId: morgan,
    audience: 'staff',
    kind: 'password',
    status: 'active',
    secretRef: 'synthetic-vault:staff-pw-0001',
    enrolledBy: 'synthetic-it-admin-001',
    evidenceRef: 'synthetic-enrollment-evidence-0001',
    synthetic: true,
  },
  {
    credentialId: 'ncr-morgan-totp',
    tenantId: tenant,
    personId: morgan,
    audience: 'staff',
    kind: 'totp',
    status: 'active',
    secretRef: 'synthetic-vault:staff-totp-0001',
    enrolledBy: 'synthetic-it-admin-001',
    evidenceRef: 'synthetic-enrollment-evidence-0002',
    synthetic: true,
  },
];
const workstation: AuthDevice = {
  deviceId: 'nde-morgan-workstation',
  tenantId: tenant,
  personId: morgan,
  label: 'synthetic workstation',
  status: 'active',
  firstSeenAt: '2026-03-01T08:00:00Z',
  synthetic: true,
};
const alexPhone: AuthDevice = {
  deviceId: 'nde-alex-phone',
  tenantId: tenant,
  personId: alex,
  label: 'synthetic member phone',
  status: 'active',
  firstSeenAt: '2026-03-02T18:00:00Z',
  synthetic: true,
};
const alexVerifiedEmail: EndpointAssociation = {
  tenantId: tenant,
  endpointId: 'nce-alex-portal-email',
  personId: alex,
  relationship: 'self',
  verification: 'verified',
  evidenceRef: 'synthetic-endpoint-evidence-0002',
  source: 'synthetic-portal-enrollment',
  synthetic: true,
};

const policyEntries: readonly ConfigEntry[] = [
  {
    tenantId: tenant,
    namespace: 'policy',
    key: sessionPolicyKey('front-desk'),
    value: {
      idleTimeoutSeconds: 300,
      maxConcurrentSessions: 1,
      onLimitExceeded: 'block-new',
      maxFailedAttempts: 5,
      stepUpRecencySeconds: 300,
    },
    phiClass: 'none',
    counselOwned: false,
    revision: 1,
    changedBy: 'synthetic-it-admin-001',
  },
  {
    tenantId: tenant,
    namespace: 'policy',
    key: sessionPolicyKey('portal-member'),
    value: {
      idleTimeoutSeconds: 900,
      maxConcurrentSessions: 2,
      onLimitExceeded: 'terminate-oldest',
      maxFailedAttempts: 3,
      stepUpRecencySeconds: 300,
    },
    phiClass: 'none',
    counselOwned: false,
    revision: 1,
    changedBy: 'synthetic-it-admin-001',
  },
];

describe('staff journey: MFA login → activity → idle lock → re-auth (REQ-ID-024)', () => {
  it('runs the full path end to end', () => {
    const policy = resolveSessionPolicy(policyEntries, context, 'front-desk');

    // Login with password + TOTP; the concurrent limit admits the first session.
    const admission = enforceConcurrentSessionLimit([], morgan, policy);
    expect(admission.admit).toBe(true);
    let session = issueStaffSession({
      sessionId: 'nsn-e2e-staff-0001',
      tenantId: tenant,
      personId: morgan,
      staffAccountId: 'nsa-morgan-lee',
      staffAccountStatus: 'active',
      device: workstation,
      presentedCredentials: staffCredentials,
      atIso: '2026-03-05T08:00:00Z',
      synthetic: true,
    });
    expect(session.assurance).toBe('aal2');

    // Activity keeps the session alive across the raw timeout span.
    session = recordActivity(session, '2026-03-05T08:04:00Z');
    expect(evaluateIdle(session, policy, '2026-03-05T08:07:00Z')).toEqual({ state: 'active' });

    // The shared-workstation policy locks it after true idleness; re-auth is required.
    const idle = evaluateIdle(session, policy, '2026-03-05T08:09:30Z');
    expect(idle).toEqual({ state: 'locked', requiresReauthentication: true });
    session = lockIdleSession(session);
    expect(session.status).toBe('locked');

    // Re-authentication is a fresh MFA issuance, and the block-new limit
    // holds while the locked session is not counted (it is not active).
    const readmission = enforceConcurrentSessionLimit([session], morgan, policy);
    expect(readmission.admit).toBe(true);
    const fresh = issueStaffSession({
      sessionId: 'nsn-e2e-staff-0002',
      tenantId: tenant,
      personId: morgan,
      staffAccountId: 'nsa-morgan-lee',
      staffAccountStatus: 'active',
      device: workstation,
      presentedCredentials: staffCredentials,
      atIso: '2026-03-05T08:10:00Z',
      synthetic: true,
    });
    expect(fresh.status).toBe('active');
  });
});

describe('portal journey: magic-link login → sensitive view → step-up (gate: authn e2e incl. step-up)', () => {
  it('runs the full path end to end', () => {
    const policy = resolveSessionPolicy(policyEntries, context, 'portal-member');

    // Magic-link challenge over the verified channel, consumed once.
    const login = consumeChallenge(
      issueChallenge([alexVerifiedEmail], {
        challengeId: 'nch-e2e-login',
        tenantId: tenant,
        personId: alex,
        endpointId: 'nce-alex-portal-email',
        purpose: 'portal-login',
        method: 'magic-link',
        issuedAt: '2026-03-05T17:58:00Z',
        expiresAt: '2026-03-05T18:08:00Z',
        maxAttempts: 3,
        synthetic: true,
      }),
      '2026-03-05T18:00:00Z',
    );
    expect(login.outcome).toBe('consumed');
    let session = issuePortalSession({
      sessionId: 'nsn-e2e-portal-0001',
      tenantId: tenant,
      personId: alex,
      consumedChallenge: login.challenge,
      device: alexPhone,
      atIso: '2026-03-05T18:00:30Z',
      synthetic: true,
    });
    expect(session.assurance).toBe('aal1');

    // A sensitive view demands step-up: not satisfied at aal1 without one.
    const demand = requireStepUp(session, policy, '2026-03-05T18:02:00Z');
    expect(demand.satisfied).toBe(false);

    // Fresh OTP over the same verified channel satisfies it inside the window.
    const stepUp = consumeChallenge(
      issueChallenge([alexVerifiedEmail], {
        challengeId: 'nch-e2e-stepup',
        tenantId: tenant,
        personId: alex,
        endpointId: 'nce-alex-portal-email',
        purpose: 'step-up',
        method: 'otp',
        issuedAt: '2026-03-05T18:02:30Z',
        expiresAt: '2026-03-05T18:12:30Z',
        maxAttempts: 3,
        synthetic: true,
      }),
      '2026-03-05T18:03:00Z',
    );
    session = recordStepUp(session, stepUp.challenge);
    expect(requireStepUp(session, policy, '2026-03-05T18:05:00Z').satisfied).toBe(true);

    // The window closes: the next sensitive view demands a fresh step-up.
    expect(requireStepUp(session, policy, '2026-03-05T18:20:00Z').satisfied).toBe(false);
  });
});

describe('lockout-recovery journey (gate: lockout-recovery path)', () => {
  it('portal: failed attempts → lockout → verified-channel recovery → fresh login', () => {
    const policy = resolveSessionPolicy(policyEntries, context, 'portal-member');
    let state: FailedAttemptState = { personId: alex, attempts: 0, lockedOut: false };
    for (let attempt = 0; attempt < policy.maxFailedAttempts; attempt += 1) {
      state = registerFailedAttempt(state, policy);
    }
    expect(state.lockedOut).toBe(true);

    const recovery = consumeChallenge(
      issueChallenge([alexVerifiedEmail], {
        challengeId: 'nch-e2e-recovery',
        tenantId: tenant,
        personId: alex,
        endpointId: 'nce-alex-portal-email',
        purpose: 'recovery',
        method: 'otp',
        issuedAt: '2026-03-05T19:00:00Z',
        expiresAt: '2026-03-05T19:10:00Z',
        maxAttempts: 3,
        synthetic: true,
      }),
      '2026-03-05T19:01:00Z',
    );
    const recovered = recoverLockout(state, {
      path: 'portal-verified-channel',
      consumedRecovery: recovery.challenge,
    });
    expect(recovered).toMatchObject({ recovered: true, attemptsReset: 0 });

    // Recovered state readmits a fresh login over the same verified channel.
    const relogin = consumeChallenge(
      issueChallenge([alexVerifiedEmail], {
        challengeId: 'nch-e2e-relogin',
        tenantId: tenant,
        personId: alex,
        endpointId: 'nce-alex-portal-email',
        purpose: 'portal-login',
        method: 'magic-link',
        issuedAt: '2026-03-05T19:05:00Z',
        expiresAt: '2026-03-05T19:15:00Z',
        maxAttempts: 3,
        synthetic: true,
      }),
      '2026-03-05T19:06:00Z',
    );
    expect(relogin.outcome).toBe('consumed');
  });

  it('staff: lockout → admin unlock + MFA re-verification → fresh MFA login', () => {
    const policy = resolveSessionPolicy(policyEntries, context, 'front-desk');
    let state: FailedAttemptState = { personId: morgan, attempts: 0, lockedOut: false };
    for (let attempt = 0; attempt < policy.maxFailedAttempts; attempt += 1) {
      state = registerFailedAttempt(state, policy);
    }
    expect(state.lockedOut).toBe(true);
    expect(
      recoverLockout(state, {
        path: 'staff-admin-unlock',
        adminRef: 'synthetic-it-admin-001',
        mfaReverified: true,
      }).recovered,
    ).toBe(true);
    const session = issueStaffSession({
      sessionId: 'nsn-e2e-staff-0003',
      tenantId: tenant,
      personId: morgan,
      staffAccountId: 'nsa-morgan-lee',
      staffAccountStatus: 'active',
      device: workstation,
      presentedCredentials: staffCredentials,
      atIso: '2026-03-05T09:00:00Z',
      synthetic: true,
    });
    expect(session.assurance).toBe('aal2');
  });
});

describe('ATO journey: lockdown → verified-channel notification → proportional restore (REQ-ID-029)', () => {
  it('runs the full path end to end', () => {
    const activePortalSession = issuePortalSession({
      sessionId: 'nsn-e2e-ato-victim',
      tenantId: tenant,
      personId: alex,
      consumedChallenge: consumeChallenge(
        issueChallenge([alexVerifiedEmail], {
          challengeId: 'nch-e2e-ato-login',
          tenantId: tenant,
          personId: alex,
          endpointId: 'nce-alex-portal-email',
          purpose: 'portal-login',
          method: 'otp',
          issuedAt: '2026-03-04T01:00:00Z',
          expiresAt: '2026-03-04T01:10:00Z',
          maxAttempts: 3,
          synthetic: true,
        }),
        '2026-03-04T01:01:00Z',
      ).challenge,
      device: alexPhone,
      atIso: '2026-03-04T01:02:00Z',
      synthetic: true,
    });

    const result = raiseAtoLockdown(
      'nld-e2e-0001',
      tenant,
      alex,
      [
        {
          kind: 'credential-stuffing',
          detail: 'synthetic: stuffing wave',
          observedAt: '2026-03-04T02:00:00Z',
        },
      ],
      [activePortalSession],
      [alexVerifiedEmail],
      [],
      true,
    );
    expect(result.sessions[0]?.status).toBe('revoked');
    expect(result.notification.endpointId).toBe('nce-alex-portal-email');
    expect(result.lockdown.releaseRequirement).toBe('re-identity-proofing');

    const released = releaseLockdown(result.lockdown, {
      requirementMet: 're-identity-proofing',
      evidenceRef: 'synthetic-idproof-redo-0001',
      releasedBy: 'synthetic-it-admin-001',
    });
    expect(released.status).toBe('released');
    expect(released.signals).toEqual(result.lockdown.signals);
  });
});
