/**
 * Executable 4-class fixture packs for the WP-014 requirement slice
 * (REQ-ID-024, REQ-ID-029, and the authn halves of REQ-PORT-002/REQ-PORT-009).
 * Every case runs against the real domain functions — a fixture that merely
 * "exists" without encoding its acceptance criterion cannot pass here.
 */
import { fileURLToPath } from 'node:url';

import { loadRequirementFixturePack, requiredFixtureClasses } from '@practicehub/testkit';
import { describe, expect, it } from 'vitest';

import type { TenancyContext, TenantId } from '@practicehub/contracts';
import type { ConfigEntry } from '@practicehub/platform-core';

import {
  consumeChallenge,
  enforceConcurrentSessionLimit,
  evaluateIdle,
  issueChallenge,
  issuePortalSession,
  issueStaffSession,
  recoverLockout,
  registerFailedAttempt,
  requireStepUp,
  resolveSessionPolicy,
  revokeDevice,
  sessionPolicyKey,
  type AuthChallenge,
  type AuthSession,
  type FailedAttemptState,
  type LockoutRecovery,
  type PortalSessionRequest,
  type SessionPolicy,
  type StaffSessionRequest,
} from './authn.js';
import {
  invokeCohortProtection,
  raiseAtoLockdown,
  releaseLockdown,
  selectNotificationChannel,
  tuneAtoThresholds,
  type AtoSignal,
  type AtoThresholds,
  type LockdownRelease,
} from './ato.js';
import {
  assertElevationBasis,
  attemptElevation,
  beginElevation,
  detectWrongPersonResume,
  resumePreAuthSession,
  type ElevatedLink,
  type ElevationInsufficientSignal,
  type PreAuthSession,
} from './elevation.js';
import type { EndpointAssociation } from './endpoints.js';

const fixturesDirectory = fileURLToPath(new URL('../fixtures', import.meta.url));

interface PolicySeed {
  readonly role: string;
  readonly value: unknown;
  readonly revision?: number;
}

interface FixtureCase {
  readonly name: string;
  readonly op:
    | 'policy-resolve'
    | 'staff-issue'
    | 'portal-issue'
    | 'concurrent'
    | 'idle'
    | 'device-revoke'
    | 'lockout'
    | 'recover'
    | 'challenge-issue'
    | 'challenge-consume'
    | 'step-up'
    | 'ato-raise'
    | 'ato-release'
    | 'ato-cohort'
    | 'ato-tune'
    | 'notify-select'
    | 'elevate-basis'
    | 'elevate-begin'
    | 'elevate-attempt'
    | 'resume'
    | 'wrong-person';
  readonly expectError?: string;
  // policy-resolve
  readonly role?: string;
  readonly expectPolicy?: Partial<SessionPolicy>;
  // staff-issue / portal-issue
  readonly staffRequest?: StaffSessionRequest;
  readonly portalRequest?: PortalSessionRequest;
  readonly expectAssurance?: string;
  // concurrent
  readonly personId?: string;
  readonly policy?: SessionPolicy;
  readonly expectAdmit?: boolean;
  readonly expectTerminate?: readonly string[];
  readonly expectNotificationAction?: string | null;
  // idle / step-up
  readonly sessionId?: string;
  readonly atIso?: string;
  readonly expectState?: string;
  readonly expectSatisfied?: boolean;
  // device-revoke
  readonly deviceId?: string;
  readonly revokedBy?: string;
  readonly expectStatuses?: readonly string[];
  // lockout / recover
  readonly failedAttempts?: number;
  readonly expectLockedOut?: boolean;
  readonly lockedState?: FailedAttemptState;
  readonly recovery?: LockoutRecovery;
  readonly expectRecoveredPath?: string;
  // challenge-issue / challenge-consume
  readonly challengeRequest?: Omit<AuthChallenge, 'consumedAt' | 'attemptCount'>;
  readonly challenge?: AuthChallenge;
  readonly expectOutcome?: string;
  // ato ops
  readonly signals?: readonly AtoSignal[];
  readonly recentlyChangedEndpointIds?: readonly string[];
  readonly expectRequirement?: string;
  readonly expectRevokedSessionIds?: readonly string[];
  readonly expectEndpoint?: string;
  readonly expectChannelBasis?: string;
  readonly expectContactChangeTreatedAsIncident?: boolean;
  readonly release?: LockdownRelease;
  readonly expectStatus?: string;
  readonly cohortPersonIds?: readonly string[];
  readonly invokedBy?: string;
  readonly currentThresholds?: AtoThresholds;
  readonly nextThresholds?: AtoThresholds;
  readonly expectRelaxations?: readonly string[];
  // elevation ops
  readonly presentedSignals?: readonly ElevationInsufficientSignal[];
  readonly withConsumedChallenge?: boolean;
  readonly expectExplanationContains?: string;
  readonly expectElevatedPersonId?: string;
  readonly expectSerializedExcludes?: readonly string[];
  readonly expectHumanPath?: boolean;
  readonly expectVisibleCaseRef?: string;
  readonly priorSubjectPersonId?: string;
  readonly expectProtected?: boolean | null;
}

interface AuthnFixture {
  readonly synthetic: true;
  readonly requirementId: string;
  readonly class: string;
  readonly policies?: readonly PolicySeed[];
  readonly associations?: readonly EndpointAssociation[];
  readonly sessions?: readonly AuthSession[];
  readonly preAuth?: PreAuthSession;
  readonly cases: readonly FixtureCase[];
}

const tenant = 'northwind-synthetic' as TenantId;
const context: TenancyContext = { tenantId: tenant };

function policyEntries(seeds: readonly PolicySeed[] = []): ConfigEntry[] {
  return seeds.map((seed) => ({
    tenantId: tenant,
    namespace: 'policy' as const,
    key: sessionPolicyKey(seed.role),
    value: seed.value,
    phiClass: 'none' as const,
    counselOwned: false,
    revision: seed.revision ?? 1,
    changedBy: 'synthetic-it-admin-001',
  }));
}

function requiredCase<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`fixture case requires ${label}`);
  }
  return value;
}

function elevationChallenge(fixture: AuthnFixture, consumed: boolean): AuthChallenge {
  const challenge = issueChallenge(fixture.associations ?? [], {
    challengeId: 'nch-fixture-elev',
    tenantId: tenant,
    personId: (fixture.associations?.[0]?.personId ??
      'np-alex-rivera') as AuthChallenge['personId'],
    endpointId: fixture.associations?.[0]?.endpointId ?? 'nce-alex-portal-email',
    purpose: 'elevation',
    method: 'otp',
    issuedAt: '2026-03-05T18:00:00Z',
    expiresAt: '2026-03-05T18:10:00Z',
    maxAttempts: 3,
    synthetic: true,
  });
  return consumed ? consumeChallenge(challenge, '2026-03-05T18:01:00Z').challenge : challenge;
}

function runCase(fixture: AuthnFixture, fixtureCase: FixtureCase): void {
  const wrap = <T>(invoke: () => T): T | undefined => {
    if (fixtureCase.expectError !== undefined) {
      expect(invoke).toThrow(new RegExp(fixtureCase.expectError));
      return undefined;
    }
    return invoke();
  };
  switch (fixtureCase.op) {
    case 'policy-resolve': {
      const policy = resolveSessionPolicy(
        policyEntries(fixture.policies),
        context,
        requiredCase(fixtureCase.role, 'role'),
      );
      expect(policy).toMatchObject(fixtureCase.expectPolicy ?? {});
      break;
    }
    case 'staff-issue': {
      const issued = wrap(() =>
        issueStaffSession(requiredCase(fixtureCase.staffRequest, 'staffRequest')),
      );
      if (issued !== undefined && fixtureCase.expectAssurance !== undefined) {
        expect(issued.assurance).toBe(fixtureCase.expectAssurance);
      }
      break;
    }
    case 'portal-issue': {
      const issued = wrap(() =>
        issuePortalSession(requiredCase(fixtureCase.portalRequest, 'portalRequest')),
      );
      if (issued !== undefined && fixtureCase.expectAssurance !== undefined) {
        expect(issued.assurance).toBe(fixtureCase.expectAssurance);
      }
      break;
    }
    case 'concurrent': {
      const decision = enforceConcurrentSessionLimit(
        fixture.sessions ?? [],
        requiredCase(fixtureCase.personId, 'personId') as AuthSession['personId'],
        requiredCase(fixtureCase.policy, 'policy'),
      );
      expect(decision.admit).toBe(fixtureCase.expectAdmit);
      if (fixtureCase.expectTerminate !== undefined) {
        expect(decision.terminateSessionIds).toEqual(fixtureCase.expectTerminate);
      }
      if (fixtureCase.expectNotificationAction !== undefined) {
        expect(decision.notification?.action ?? null).toBe(fixtureCase.expectNotificationAction);
      }
      break;
    }
    case 'idle': {
      const session = (fixture.sessions ?? []).find(
        (candidate) => candidate.sessionId === fixtureCase.sessionId,
      );
      const evaluation = evaluateIdle(
        requiredCase(session, 'sessionId matching a fixture session'),
        requiredCase(fixtureCase.policy, 'policy'),
        requiredCase(fixtureCase.atIso, 'atIso'),
      );
      expect(evaluation.state).toBe(fixtureCase.expectState);
      break;
    }
    case 'device-revoke': {
      const revoked = wrap(() =>
        revokeDevice(
          fixture.sessions ?? [],
          requiredCase(fixtureCase.deviceId, 'deviceId'),
          requiredCase(fixtureCase.revokedBy, 'revokedBy'),
        ),
      );
      if (revoked !== undefined && fixtureCase.expectStatuses !== undefined) {
        expect(revoked.map((session) => session.status)).toEqual(fixtureCase.expectStatuses);
      }
      break;
    }
    case 'lockout': {
      let state: FailedAttemptState = {
        personId: requiredCase(fixtureCase.personId, 'personId') as FailedAttemptState['personId'],
        attempts: 0,
        lockedOut: false,
      };
      for (let count = 0; count < (fixtureCase.failedAttempts ?? 0); count += 1) {
        state = registerFailedAttempt(state, requiredCase(fixtureCase.policy, 'policy'));
      }
      expect(state.lockedOut).toBe(fixtureCase.expectLockedOut);
      break;
    }
    case 'recover': {
      const result = wrap(() =>
        recoverLockout(
          requiredCase(fixtureCase.lockedState, 'lockedState'),
          requiredCase(fixtureCase.recovery, 'recovery'),
        ),
      );
      if (result !== undefined) {
        expect(result.recovered).toBe(true);
        if (fixtureCase.expectRecoveredPath !== undefined) {
          expect(result.recoveryPath).toBe(fixtureCase.expectRecoveredPath);
        }
      }
      break;
    }
    case 'challenge-issue': {
      wrap(() =>
        issueChallenge(
          fixture.associations ?? [],
          requiredCase(fixtureCase.challengeRequest, 'challengeRequest'),
        ),
      );
      break;
    }
    case 'challenge-consume': {
      const consumption = consumeChallenge(
        requiredCase(fixtureCase.challenge, 'challenge'),
        requiredCase(fixtureCase.atIso, 'atIso'),
      );
      expect(consumption.outcome).toBe(fixtureCase.expectOutcome);
      break;
    }
    case 'step-up': {
      const session = (fixture.sessions ?? []).find(
        (candidate) => candidate.sessionId === fixtureCase.sessionId,
      );
      const evaluation = requireStepUp(
        requiredCase(session, 'sessionId matching a fixture session'),
        requiredCase(fixtureCase.policy, 'policy'),
        requiredCase(fixtureCase.atIso, 'atIso'),
      );
      expect(evaluation.satisfied).toBe(fixtureCase.expectSatisfied);
      break;
    }
    case 'ato-raise': {
      const result = wrap(() =>
        raiseAtoLockdown(
          'nld-fixture-0001',
          tenant,
          requiredCase(fixtureCase.personId, 'personId') as AuthSession['personId'],
          fixtureCase.signals ?? [],
          fixture.sessions ?? [],
          fixture.associations ?? [],
          fixtureCase.recentlyChangedEndpointIds ?? [],
          true,
        ),
      );
      if (result !== undefined) {
        if (fixtureCase.expectRequirement !== undefined) {
          expect(result.lockdown.releaseRequirement).toBe(fixtureCase.expectRequirement);
        }
        expect(result.lockdown.signals).toEqual(fixtureCase.signals);
        if (fixtureCase.expectRevokedSessionIds !== undefined) {
          expect(
            result.sessions
              .filter((session) => session.status === 'revoked')
              .map((session) => session.sessionId),
          ).toEqual(fixtureCase.expectRevokedSessionIds);
        }
        if (fixtureCase.expectEndpoint !== undefined) {
          expect(result.notification.endpointId).toBe(fixtureCase.expectEndpoint);
        }
      }
      break;
    }
    case 'ato-release': {
      const lockdown = raiseAtoLockdown(
        'nld-fixture-0002',
        tenant,
        requiredCase(fixtureCase.personId, 'personId') as AuthSession['personId'],
        requiredCase(fixtureCase.signals, 'signals'),
        [],
        fixture.associations ?? [],
        [],
        true,
      ).lockdown;
      const released = wrap(() =>
        releaseLockdown(lockdown, requiredCase(fixtureCase.release, 'release')),
      );
      if (released !== undefined && fixtureCase.expectStatus !== undefined) {
        expect(released.status).toBe(fixtureCase.expectStatus);
        expect(released.signals).toEqual(fixtureCase.signals);
      }
      break;
    }
    case 'ato-cohort': {
      const directive = wrap(() =>
        invokeCohortProtection(
          (fixtureCase.cohortPersonIds ?? []) as readonly AuthSession['personId'][],
          requiredCase(fixtureCase.invokedBy, 'invokedBy'),
        ),
      );
      if (directive !== undefined) {
        expect(directive.rateLimit).toBe(true);
        expect(directive.forcedCredentialResetPersonIds).toEqual(fixtureCase.cohortPersonIds);
      }
      break;
    }
    case 'ato-tune': {
      const record = wrap(() =>
        tuneAtoThresholds(
          requiredCase(fixtureCase.currentThresholds, 'currentThresholds'),
          requiredCase(fixtureCase.nextThresholds, 'nextThresholds'),
          requiredCase(fixtureCase.invokedBy, 'invokedBy'),
        ),
      );
      if (record !== undefined) {
        expect(record.logged).toBe(true);
        if (fixtureCase.expectRelaxations !== undefined) {
          expect(record.relaxations).toEqual(fixtureCase.expectRelaxations);
        }
      }
      break;
    }
    case 'notify-select': {
      const directive = wrap(() =>
        selectNotificationChannel(
          fixture.associations ?? [],
          requiredCase(fixtureCase.personId, 'personId') as AuthSession['personId'],
          fixtureCase.recentlyChangedEndpointIds ?? [],
        ),
      );
      if (directive !== undefined) {
        if (fixtureCase.expectEndpoint !== undefined) {
          expect(directive.endpointId).toBe(fixtureCase.expectEndpoint);
        }
        if (fixtureCase.expectChannelBasis !== undefined) {
          expect(directive.channelBasis).toBe(fixtureCase.expectChannelBasis);
        }
        if (fixtureCase.expectContactChangeTreatedAsIncident !== undefined) {
          expect(directive.contactChangeTreatedAsIncident).toBe(
            fixtureCase.expectContactChangeTreatedAsIncident,
          );
        }
      }
      break;
    }
    case 'elevate-basis': {
      wrap(() =>
        assertElevationBasis({
          presentedSignals: fixtureCase.presentedSignals ?? [],
          ...(fixtureCase.withConsumedChallenge === undefined
            ? {}
            : {
                consumedChallenge: elevationChallenge(fixture, fixtureCase.withConsumedChallenge),
              }),
        }),
      );
      break;
    }
    case 'elevate-begin': {
      const prompt = beginElevation(
        requiredCase(fixture.preAuth, 'preAuth'),
        elevationChallenge(fixture, false),
      );
      if (fixtureCase.expectExplanationContains !== undefined) {
        expect(prompt.explanation).toContain(fixtureCase.expectExplanationContains);
      }
      break;
    }
    case 'elevate-attempt': {
      const attempt = attemptElevation(
        requiredCase(fixture.preAuth, 'preAuth'),
        elevationChallenge(fixture, false),
        requiredCase(fixtureCase.atIso, 'atIso'),
        fixtureCase.presentedSignals ?? [],
      );
      expect(attempt.outcome).toBe(fixtureCase.expectOutcome);
      if (attempt.outcome === 'elevated') {
        if (fixtureCase.expectElevatedPersonId !== undefined) {
          expect(attempt.link.governedPersonId).toBe(fixtureCase.expectElevatedPersonId);
        }
        for (const excluded of fixtureCase.expectSerializedExcludes ?? []) {
          expect(JSON.stringify(attempt.link.marketingAnalyticsPayload)).not.toContain(excluded);
        }
      }
      if (attempt.outcome === 'declined' && fixtureCase.expectHumanPath !== undefined) {
        expect(attempt.directive.humanPathOffered).toBe(fixtureCase.expectHumanPath);
        expect(attempt.directive.personSpecificWithheld).toBe(true);
        expect(attempt.directive.secureChannelPathOffered).toBe(true);
      }
      break;
    }
    case 'resume': {
      const resumed = resumePreAuthSession(requiredCase(fixture.preAuth, 'preAuth'));
      expect(resumed.personSpecificRequires).toBe('fresh-verification');
      if (fixtureCase.expectVisibleCaseRef !== undefined) {
        expect(resumed.visible.caseRef).toBe(fixtureCase.expectVisibleCaseRef);
      }
      for (const excluded of fixtureCase.expectSerializedExcludes ?? []) {
        expect(JSON.stringify(resumed)).not.toContain(excluded);
      }
      break;
    }
    case 'wrong-person': {
      const preAuth = requiredCase(fixture.preAuth, 'preAuth');
      const attempt = attemptElevation(
        preAuth,
        elevationChallenge(fixture, false),
        '2026-03-05T18:01:00Z',
      );
      if (attempt.outcome !== 'elevated') {
        throw new Error('wrong-person case expects a successful elevation first');
      }
      const link: ElevatedLink = attempt.link;
      const directive = detectWrongPersonResume(
        preAuth,
        requiredCase(
          fixtureCase.priorSubjectPersonId,
          'priorSubjectPersonId',
        ) as ElevatedLink['governedPersonId'],
        link,
        'npa-fixture-new',
      );
      if (fixtureCase.expectProtected === null) {
        expect(directive).toBeNull();
      } else {
        expect(directive?.priorContextProtected).toBe(fixtureCase.expectProtected);
        expect(directive?.newPublicSession.consentedLeadFields).toEqual({});
      }
      break;
    }
  }
}

for (const requirementId of ['REQ-ID-024', 'REQ-ID-029', 'REQ-PORT-002', 'REQ-PORT-009']) {
  describe(`${requirementId} fixture pack (4-class floor)`, () => {
    const pack = loadRequirementFixturePack(fixturesDirectory, requirementId);

    it('carries all four fixture classes with the synthetic watermark', () => {
      expect(Object.keys(pack.fixtures).sort()).toEqual([...requiredFixtureClasses].sort());
    });

    for (const fixtureClass of requiredFixtureClasses) {
      describe(fixtureClass, () => {
        const fixture = pack.fixtures[fixtureClass] as unknown as AuthnFixture;
        it('declares at least one executable case', () => {
          expect(fixture.cases.length).toBeGreaterThan(0);
        });
        for (const fixtureCase of fixture.cases) {
          it(fixtureCase.name, () => {
            runCase(fixture, fixtureCase);
          });
        }
      });
    }
  });
}
