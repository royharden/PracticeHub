/**
 * AuthN unit suite (WP-014, REQ-ID-024 + R6-REQ-005). Contract:
 * docs/contracts/session-api.md.
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
  mfaCredentialKinds,
  recordActivity,
  recordStepUp,
  recoverLockout,
  registerFailedAttempt,
  requireStepUp,
  resolveSessionPolicy,
  revokeDevice,
  sessionPolicyKey,
  strictestSessionPolicy,
  AuthnInvariantError,
  type AuthChallenge,
  type AuthCredential,
  type AuthDevice,
  type AuthSession,
  type SessionPolicy,
  type StaffSessionRequest,
} from './authn.js';
import type { EndpointAssociation } from './endpoints.js';

const tenant = 'northwind-synthetic' as TenantId;
const morgan = 'np-morgan-lee' as PersonId;
const alex = 'np-alex-rivera' as PersonId;
const context: TenancyContext = { tenantId: tenant };

const password: AuthCredential = {
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
};
const totp: AuthCredential = {
  ...password,
  credentialId: 'ncr-morgan-totp',
  kind: 'totp',
  secretRef: 'synthetic-vault:staff-totp-0001',
  evidenceRef: 'synthetic-enrollment-evidence-0002',
};
const device: AuthDevice = {
  deviceId: 'nde-morgan-workstation',
  tenantId: tenant,
  personId: morgan,
  label: 'synthetic workstation',
  status: 'active',
  firstSeenAt: '2026-03-01T08:00:00Z',
  synthetic: true,
};

const staffRequest: StaffSessionRequest = {
  sessionId: 'nsn-test-0001',
  tenantId: tenant,
  personId: morgan,
  staffAccountId: 'nsa-morgan-lee',
  staffAccountStatus: 'active',
  device,
  presentedCredentials: [password, totp],
  atIso: '2026-03-05T08:00:00Z',
  synthetic: true,
};

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
const assertedAssociation: EndpointAssociation = {
  tenantId: tenant,
  endpointId: 'nce-rivera-email',
  personId: alex,
  relationship: 'self',
  verification: 'asserted',
  source: 'synthetic-web-form',
  synthetic: true,
};

function policyEntry(role: string, value: unknown, revision = 1): ConfigEntry {
  return {
    tenantId: tenant,
    namespace: 'policy',
    key: sessionPolicyKey(role),
    value,
    phiClass: 'none',
    counselOwned: false,
    revision,
    changedBy: 'synthetic-it-admin-001',
  };
}

const frontDeskPolicyValue = {
  idleTimeoutSeconds: 300,
  maxConcurrentSessions: 1,
  onLimitExceeded: 'block-new',
  maxFailedAttempts: 5,
  stepUpRecencySeconds: 300,
};

function session(overrides: Partial<AuthSession>): AuthSession {
  return {
    sessionId: 'nsn-base',
    tenantId: tenant,
    personId: morgan,
    principal: 'staff',
    staffAccountId: 'nsa-morgan-lee',
    deviceId: device.deviceId,
    assurance: 'aal2',
    status: 'active',
    createdAt: '2026-03-05T08:00:00Z',
    lastActivityAt: '2026-03-05T08:00:00Z',
    synthetic: true,
    ...overrides,
  };
}

describe('staff session issuance — MFA mandatory (ADR-006 Decision 1)', () => {
  it('issues aal2 with password + TOTP on an active account and device', () => {
    const issued = issueStaffSession(staffRequest);
    expect(issued.assurance).toBe('aal2');
    expect(issued.principal).toBe('staff');
    expect(issued.staffAccountId).toBe('nsa-morgan-lee');
    expect(issued.deviceId).toBe(device.deviceId);
  });

  it('issues aal2 with password + WebAuthn equally', () => {
    const webauthn: AuthCredential = {
      ...totp,
      credentialId: 'ncr-morgan-webauthn',
      kind: 'webauthn',
    };
    const issued = issueStaffSession({
      ...staffRequest,
      presentedCredentials: [password, webauthn],
    });
    expect(issued.assurance).toBe('aal2');
  });

  it('a staff session without a second factor is unrepresentable', () => {
    expect(() => issueStaffSession({ ...staffRequest, presentedCredentials: [password] })).toThrow(
      /second factor .*mandatory|mandatory/,
    );
  });

  it('a revoked second factor does not satisfy MFA', () => {
    expect(() =>
      issueStaffSession({
        ...staffRequest,
        presentedCredentials: [password, { ...totp, status: 'revoked' }],
      }),
    ).toThrow(AuthnInvariantError);
  });

  it('every MFA kind is a SECOND factor — password alone never appears in the list', () => {
    expect(mfaCredentialKinds).not.toContain('password');
  });

  it('a suspended or offboarded staff account cannot authenticate', () => {
    for (const status of ['suspended', 'offboarded'] as const) {
      expect(() => issueStaffSession({ ...staffRequest, staffAccountStatus: status })).toThrow(
        AuthnInvariantError,
      );
    }
  });

  it("a revoked device or another person's device is refused", () => {
    expect(() =>
      issueStaffSession({
        ...staffRequest,
        device: { ...device, status: 'revoked', revokedReason: 'lost' },
      }),
    ).toThrow(AuthnInvariantError);
    expect(() =>
      issueStaffSession({ ...staffRequest, device: { ...device, personId: alex } }),
    ).toThrow(AuthnInvariantError);
  });
});

describe('portal challenges — verified channel only', () => {
  const challengeRequest = {
    challengeId: 'nch-test-0001',
    tenantId: tenant,
    personId: alex,
    endpointId: 'nce-alex-portal-email',
    purpose: 'portal-login' as const,
    method: 'magic-link' as const,
    issuedAt: '2026-03-05T17:58:00Z',
    expiresAt: '2026-03-05T18:08:00Z',
    maxAttempts: 3,
    synthetic: true,
  };

  it('issues over a verified association of the same person', () => {
    const challenge = issueChallenge([verifiedAssociation], challengeRequest);
    expect(challenge.attemptCount).toBe(0);
  });

  it('refuses an asserted-only association — a challenge never travels an unverified channel', () => {
    expect(() =>
      issueChallenge([assertedAssociation], {
        ...challengeRequest,
        endpointId: 'nce-rivera-email',
      }),
    ).toThrow(/VERIFIED/);
  });

  it("refuses another person's endpoint even when verified", () => {
    expect(() =>
      issueChallenge([{ ...verifiedAssociation, personId: morgan }], challengeRequest),
    ).toThrow(AuthnInvariantError);
  });

  it('a non-expiring or unbounded challenge is unrepresentable', () => {
    expect(() =>
      issueChallenge([verifiedAssociation], {
        ...challengeRequest,
        expiresAt: challengeRequest.issuedAt,
      }),
    ).toThrow(/expiring by construction/);
    expect(() =>
      issueChallenge([verifiedAssociation], { ...challengeRequest, maxAttempts: 0 }),
    ).toThrow(/attempt bound/);
  });

  it('consumption is single-use and expiry-checked', () => {
    const challenge = issueChallenge([verifiedAssociation], challengeRequest);
    const consumed = consumeChallenge(challenge, '2026-03-05T18:00:00Z');
    expect(consumed.outcome).toBe('consumed');
    expect(consumeChallenge(consumed.challenge, '2026-03-05T18:01:00Z').outcome).toBe(
      'rejected-replayed',
    );
    expect(consumeChallenge(challenge, '2026-03-05T18:30:00Z').outcome).toBe('rejected-expired');
  });

  it('portal sessions issue at aal1 from a consumed portal-login challenge of the same person', () => {
    const consumed = consumeChallenge(
      issueChallenge([verifiedAssociation], challengeRequest),
      '2026-03-05T18:00:00Z',
    ).challenge;
    const portalDevice: AuthDevice = { ...device, deviceId: 'nde-alex-phone', personId: alex };
    const issued = issuePortalSession({
      sessionId: 'nsn-alex-test',
      tenantId: tenant,
      personId: alex,
      consumedChallenge: consumed,
      device: portalDevice,
      atIso: '2026-03-05T18:00:30Z',
      synthetic: true,
    });
    expect(issued.principal).toBe('portal');
    expect(issued.assurance).toBe('aal1');
    expect(issued.staffAccountId).toBeUndefined();
    expect(() =>
      issuePortalSession({
        sessionId: 'nsn-morgan-hijack',
        tenantId: tenant,
        personId: morgan,
        consumedChallenge: consumed,
        device: { ...portalDevice, personId: morgan },
        atIso: '2026-03-05T18:00:30Z',
        synthetic: true,
      }),
    ).toThrow(AuthnInvariantError);
  });
});

describe('session policy — per role, fail-to-stricter (REQ-ID-024)', () => {
  it('resolves the configured per-role policy', () => {
    const policy = resolveSessionPolicy(
      [policyEntry('front-desk', frontDeskPolicyValue)],
      context,
      'front-desk',
    );
    expect(policy).toMatchObject({
      ...frontDeskPolicyValue,
      role: 'front-desk',
      defaultsApplied: false,
    });
  });

  it('different roles resolve different policies — never one global setting', () => {
    const entries = [
      policyEntry('front-desk', frontDeskPolicyValue),
      policyEntry('provider', {
        ...frontDeskPolicyValue,
        idleTimeoutSeconds: 1800,
        maxConcurrentSessions: 3,
        onLimitExceeded: 'terminate-oldest',
      }),
    ];
    expect(resolveSessionPolicy(entries, context, 'front-desk').idleTimeoutSeconds).toBe(300);
    expect(resolveSessionPolicy(entries, context, 'provider').idleTimeoutSeconds).toBe(1800);
  });

  it('an absent policy fails to the strictest defaults, never to unlimited (exception 3)', () => {
    const policy = resolveSessionPolicy([], context, 'front-desk');
    expect(policy.defaultsApplied).toBe(true);
    expect(policy.maxConcurrentSessions).toBe(1);
    expect(policy.onLimitExceeded).toBe('block-new');
    expect(policy.idleTimeoutSeconds).toBe(strictestSessionPolicy.idleTimeoutSeconds);
  });

  it('a malformed policy value fails to the strictest defaults', () => {
    const policy = resolveSessionPolicy(
      [policyEntry('front-desk', { idleTimeoutSeconds: 'forever' })],
      context,
      'front-desk',
    );
    expect(policy.defaultsApplied).toBe(true);
  });

  it('a new revision applies on the next resolution — no restart (AC-3)', () => {
    const entries = [policyEntry('front-desk', frontDeskPolicyValue)];
    const before = resolveSessionPolicy(entries, context, 'front-desk');
    const after = resolveSessionPolicy(
      [
        ...entries,
        policyEntry('front-desk', { ...frontDeskPolicyValue, idleTimeoutSeconds: 240 }, 2),
      ],
      context,
      'front-desk',
    );
    expect(before.idleTimeoutSeconds).toBe(300);
    expect(after.idleTimeoutSeconds).toBe(240);
    expect(after.defaultsApplied).toBe(false);
  });
});

describe('concurrent-session limits (REQ-ID-024 AC-2)', () => {
  const policy: SessionPolicy = {
    role: 'provider',
    ...strictestSessionPolicy,
    maxConcurrentSessions: 2,
    onLimitExceeded: 'terminate-oldest',
    defaultsApplied: false,
  };

  it('admits under the limit without noise', () => {
    const decision = enforceConcurrentSessionLimit(
      [session({ sessionId: 'nsn-a' })],
      morgan,
      policy,
    );
    expect(decision).toEqual({ admit: true, terminateSessionIds: [], notification: null });
  });

  it('terminate-oldest terminates the oldest and notifies the user', () => {
    const decision = enforceConcurrentSessionLimit(
      [
        session({ sessionId: 'nsn-old', createdAt: '2026-03-05T07:00:00Z' }),
        session({ sessionId: 'nsn-new', createdAt: '2026-03-05T08:00:00Z' }),
      ],
      morgan,
      policy,
    );
    expect(decision.admit).toBe(true);
    expect(decision.terminateSessionIds).toEqual(['nsn-old']);
    expect(decision.notification?.action).toBe('oldest-terminated');
  });

  it('block-new blocks the new session and notifies the user', () => {
    const decision = enforceConcurrentSessionLimit([session({ sessionId: 'nsn-only' })], morgan, {
      ...policy,
      maxConcurrentSessions: 1,
      onLimitExceeded: 'block-new',
    });
    expect(decision.admit).toBe(false);
    expect(decision.notification?.action).toBe('new-session-blocked');
  });

  it("another person's sessions never count against the limit", () => {
    const decision = enforceConcurrentSessionLimit(
      [session({ sessionId: 'nsn-alex', personId: alex })],
      morgan,
      { ...policy, maxConcurrentSessions: 1 },
    );
    expect(decision.admit).toBe(true);
  });
});

describe('activity-aware idle timeout (REQ-ID-024 AC-1 + exception 2)', () => {
  const policy: SessionPolicy = {
    role: 'front-desk',
    ...strictestSessionPolicy,
    idleTimeoutSeconds: 300,
    defaultsApplied: false,
  };

  it('an active session inside the window stays active', () => {
    expect(evaluateIdle(session({}), policy, '2026-03-05T08:03:00Z')).toEqual({ state: 'active' });
  });

  it('the boundary yields a stay-active prompt before locking (exception 2)', () => {
    expect(evaluateIdle(session({}), policy, '2026-03-05T08:04:30Z')).toEqual({
      state: 'stay-active-prompt',
    });
  });

  it('past the timeout the session locks and requires re-authentication (AC-1)', () => {
    expect(evaluateIdle(session({}), policy, '2026-03-05T08:05:00Z')).toEqual({
      state: 'locked',
      requiresReauthentication: true,
    });
  });

  it('recorded activity refreshes the clock — activity-aware, not elapsed-only', () => {
    const refreshed = recordActivity(session({}), '2026-03-05T08:04:00Z');
    expect(evaluateIdle(refreshed, policy, '2026-03-05T08:07:00Z')).toEqual({ state: 'active' });
    expect(() =>
      recordActivity(session({ status: 'revoked', revokedReason: 'x' }), '2026-03-05T08:04:00Z'),
    ).toThrow(AuthnInvariantError);
  });
});

describe('device revocation (REQ-ID-024 AC-4)', () => {
  it('terminates every session tied to the device in one pass', () => {
    const sessions = [
      session({ sessionId: 'nsn-a' }),
      session({ sessionId: 'nsn-b', deviceId: 'nde-other' }),
      session({ sessionId: 'nsn-c' }),
    ];
    const revoked = revokeDevice(sessions, device.deviceId, 'synthetic-it-admin-001');
    expect(revoked.map((entry) => entry.status)).toEqual(['revoked', 'active', 'revoked']);
    expect(revoked[0]?.revokedReason).toContain('synthetic-it-admin-001');
  });

  it('requires an attributed revoker', () => {
    expect(() => revokeDevice([session({})], device.deviceId, '')).toThrow(AuthnInvariantError);
  });
});

describe('step-up (R6-REQ-005; mechanism for WP-015 sensitive views)', () => {
  const policy: SessionPolicy = {
    role: 'portal-member',
    ...strictestSessionPolicy,
    stepUpRecencySeconds: 300,
    defaultsApplied: false,
  };

  it('an aal1 session without step-up requires a challenge', () => {
    const evaluation = requireStepUp(
      session({ principal: 'portal', assurance: 'aal1' }),
      policy,
      '2026-03-05T18:05:00Z',
    );
    expect(evaluation.satisfied).toBe(false);
  });

  it('a recent step-up satisfies; a stale one does not', () => {
    const stepped = recordStepUp(session({ principal: 'portal', assurance: 'aal1' }), {
      challengeId: 'nch-stepup',
      tenantId: tenant,
      personId: alex,
      endpointId: 'nce-alex-portal-email',
      purpose: 'step-up',
      method: 'otp',
      issuedAt: '2026-03-05T18:03:00Z',
      expiresAt: '2026-03-05T18:13:00Z',
      consumedAt: '2026-03-05T18:04:00Z',
      attemptCount: 1,
      maxAttempts: 3,
      synthetic: true,
    });
    expect(requireStepUp(stepped, policy, '2026-03-05T18:05:00Z').satisfied).toBe(true);
    expect(requireStepUp(stepped, policy, '2026-03-05T18:20:00Z').satisfied).toBe(false);
  });

  it('a consumed non-step-up challenge cannot record a step-up', () => {
    expect(() =>
      recordStepUp(session({}), {
        challengeId: 'nch-login',
        tenantId: tenant,
        personId: alex,
        endpointId: 'nce-alex-portal-email',
        purpose: 'portal-login',
        method: 'otp',
        issuedAt: '2026-03-05T18:03:00Z',
        expiresAt: '2026-03-05T18:13:00Z',
        consumedAt: '2026-03-05T18:04:00Z',
        attemptCount: 1,
        maxAttempts: 3,
        synthetic: true,
      }),
    ).toThrow(AuthnInvariantError);
  });
});

describe('lockout + recovery (gate: lockout-recovery path)', () => {
  const policy: SessionPolicy = {
    role: 'portal-member',
    ...strictestSessionPolicy,
    maxFailedAttempts: 3,
    defaultsApplied: false,
  };
  const lockedState = { personId: alex, attempts: 3, lockedOut: true } as const;
  const recoveryChallenge: AuthChallenge = {
    challengeId: 'nch-recovery',
    tenantId: tenant,
    personId: alex,
    endpointId: 'nce-alex-portal-email',
    purpose: 'recovery',
    method: 'otp',
    issuedAt: '2026-03-05T19:00:00Z',
    expiresAt: '2026-03-05T19:10:00Z',
    consumedAt: '2026-03-05T19:01:00Z',
    attemptCount: 1,
    maxAttempts: 3,
    synthetic: true,
  };

  it('locks at the policy threshold', () => {
    let state = { personId: alex, attempts: 0, lockedOut: false };
    state = registerFailedAttempt(state, policy);
    state = registerFailedAttempt(state, policy);
    expect(state.lockedOut).toBe(false);
    state = registerFailedAttempt(state, policy);
    expect(state.lockedOut).toBe(true);
  });

  it('staff recovery = attributed admin unlock + MFA re-verification, both mandatory', () => {
    expect(
      recoverLockout(lockedState, {
        path: 'staff-admin-unlock',
        adminRef: 'synthetic-it-admin-001',
        mfaReverified: true,
      }),
    ).toMatchObject({ recovered: true, attemptsReset: 0 });
    expect(() =>
      recoverLockout(lockedState, {
        path: 'staff-admin-unlock',
        adminRef: '',
        mfaReverified: true,
      }),
    ).toThrow(AuthnInvariantError);
    expect(() =>
      recoverLockout(lockedState, {
        path: 'staff-admin-unlock',
        adminRef: 'synthetic-it-admin-001',
        mfaReverified: false,
      }),
    ).toThrow(AuthnInvariantError);
  });

  it("portal recovery = this person's consumed verified-channel recovery challenge", () => {
    expect(
      recoverLockout(lockedState, {
        path: 'portal-verified-channel',
        consumedRecovery: recoveryChallenge,
      }),
    ).toMatchObject({ recovered: true });
    expect(() =>
      recoverLockout(lockedState, {
        path: 'portal-verified-channel',
        consumedRecovery: { ...recoveryChallenge, personId: morgan },
      }),
    ).toThrow(AuthnInvariantError);
    const unconsumedRecovery: AuthChallenge = {
      challengeId: recoveryChallenge.challengeId,
      tenantId: recoveryChallenge.tenantId,
      personId: recoveryChallenge.personId,
      endpointId: recoveryChallenge.endpointId,
      purpose: recoveryChallenge.purpose,
      method: recoveryChallenge.method,
      issuedAt: recoveryChallenge.issuedAt,
      expiresAt: recoveryChallenge.expiresAt,
      attemptCount: 0,
      maxAttempts: recoveryChallenge.maxAttempts,
      synthetic: true,
    };
    expect(() =>
      recoverLockout(lockedState, {
        path: 'portal-verified-channel',
        consumedRecovery: unconsumedRecovery,
      }),
    ).toThrow(AuthnInvariantError);
  });

  it('supervised manual recovery exists but fails closed without supervisor + evidence (REQ-ID-029 exception 2)', () => {
    expect(
      recoverLockout(lockedState, {
        path: 'portal-supervised-manual',
        supervisorRef: 'synthetic-supervisor-001',
        evidenceRef: 'synthetic-manual-idv-0001',
      }),
    ).toMatchObject({ recovered: true, recoveryPath: 'portal-supervised-manual' });
    expect(() =>
      recoverLockout(lockedState, {
        path: 'portal-supervised-manual',
        supervisorRef: '',
        evidenceRef: 'x',
      }),
    ).toThrow(AuthnInvariantError);
  });

  it('an unlocked account has nothing to recover', () => {
    expect(() =>
      recoverLockout(
        { personId: alex, attempts: 1, lockedOut: false },
        {
          path: 'staff-admin-unlock',
          adminRef: 'synthetic-it-admin-001',
          mfaReverified: true,
        },
      ),
    ).toThrow(AuthnInvariantError);
  });
});
