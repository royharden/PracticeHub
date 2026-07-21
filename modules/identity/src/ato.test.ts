/**
 * ATO machinery unit suite (WP-014, REQ-ID-029). Contract:
 * docs/contracts/session-api.md.
 */
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import {
  atoThresholdFloor,
  classifyAtoRisk,
  deviceLostLockdown,
  invokeCohortProtection,
  raiseAtoLockdown,
  releaseLockdown,
  restorationRequirement,
  selectNotificationChannel,
  tuneAtoThresholds,
  type AtoSignal,
  type AtoThresholds,
} from './ato.js';
import { AuthnInvariantError, type AuthSession } from './authn.js';
import type { EndpointAssociation } from './endpoints.js';

const tenant = 'northwind-synthetic' as TenantId;
const alex = 'np-alex-rivera' as PersonId;
const morgan = 'np-morgan-lee' as PersonId;

const stuffing: AtoSignal = {
  kind: 'credential-stuffing',
  detail: 'synthetic: burst across accounts',
  observedAt: '2026-03-04T02:00:00Z',
};
const deviceBurst: AtoSignal = {
  kind: 'new-device-burst',
  detail: 'synthetic: 4 new devices',
  observedAt: '2026-03-04T02:10:00Z',
};

function association(
  endpointId: string,
  verification: 'verified' | 'asserted',
  personId: PersonId = alex,
): EndpointAssociation {
  return {
    tenantId: tenant,
    endpointId,
    personId,
    relationship: 'self',
    verification,
    ...(verification === 'verified' ? { evidenceRef: `synthetic-evidence-${endpointId}` } : {}),
    source: 'synthetic-portal-enrollment',
    synthetic: true,
  };
}

function activeSession(sessionId: string, personId: PersonId): AuthSession {
  return {
    sessionId,
    tenantId: tenant,
    personId,
    principal: 'portal',
    deviceId: 'nde-alex-phone',
    assurance: 'aal1',
    status: 'active',
    createdAt: '2026-03-04T01:00:00Z',
    lastActivityAt: '2026-03-04T01:30:00Z',
    synthetic: true,
  };
}

describe('risk classification and proportional restoration (AC-2)', () => {
  it('high-risk signals require re-identity-proofing; moderate require step-up', () => {
    expect(classifyAtoRisk([stuffing])).toBe('high');
    expect(classifyAtoRisk([deviceBurst])).toBe('moderate');
    expect(restorationRequirement('high')).toBe('re-identity-proofing');
    expect(restorationRequirement('moderate')).toBe('step-up');
  });
});

describe('notification channel selection (AC-1 + exception 1)', () => {
  it('uses a verified channel when none changed inside the incident', () => {
    const directive = selectNotificationChannel(
      [association('nce-alex-portal-email', 'verified')],
      alex,
      [],
    );
    expect(directive).toMatchObject({
      endpointId: 'nce-alex-portal-email',
      channelBasis: 'verified',
      contactChangeTreatedAsIncident: false,
    });
  });

  it('falls back to a prior-verified channel when the newest channel changed inside the incident', () => {
    const directive = selectNotificationChannel(
      [
        association('nce-alex-portal-email', 'verified'),
        association('nce-attacker-swap', 'verified'),
      ],
      alex,
      ['nce-attacker-swap'],
    );
    expect(directive).toMatchObject({
      endpointId: 'nce-alex-portal-email',
      channelBasis: 'prior-verified-fallback',
      contactChangeTreatedAsIncident: true,
    });
  });

  it('asserted channels never notify; no trusted verified channel fails closed', () => {
    expect(() => selectNotificationChannel([association('nce-x', 'asserted')], alex, [])).toThrow(
      /no verified channel/,
    );
    expect(() =>
      selectNotificationChannel([association('nce-attacker-swap', 'verified')], alex, [
        'nce-attacker-swap',
      ]),
    ).toThrow(/incident-window/);
  });
});

describe('lockdown (AC-1 + AC-3)', () => {
  it("revokes this person's active sessions, freezes high-risk actions, records signals verbatim", () => {
    const result = raiseAtoLockdown(
      'nld-test-0001',
      tenant,
      alex,
      [stuffing, deviceBurst],
      [activeSession('nsn-alex-a', alex), activeSession('nsn-morgan-a', morgan)],
      [association('nce-alex-portal-email', 'verified')],
      [],
      true,
    );
    expect(result.lockdown.status).toBe('active');
    expect(result.lockdown.highRiskActionsFrozen).toBe(true);
    expect(result.lockdown.signals).toEqual([stuffing, deviceBurst]);
    expect(result.lockdown.releaseRequirement).toBe('re-identity-proofing');
    expect(result.sessions.find((s) => s.sessionId === 'nsn-alex-a')?.status).toBe('revoked');
    expect(result.sessions.find((s) => s.sessionId === 'nsn-morgan-a')?.status).toBe('active');
    expect(result.notification.endpointId).toBe('nce-alex-portal-email');
  });

  it('an empty signal set fails closed — the forensic record is mandatory (AC-3)', () => {
    expect(() =>
      raiseAtoLockdown(
        'nld-empty',
        tenant,
        alex,
        [],
        [],
        [association('nce-alex-portal-email', 'verified')],
        [],
        true,
      ),
    ).toThrow(/forensic record/);
  });
});

describe('release (AC-2 + exception 2)', () => {
  const lockdown = raiseAtoLockdown(
    'nld-test-0002',
    tenant,
    alex,
    [stuffing],
    [],
    [association('nce-alex-portal-email', 'verified')],
    [],
    true,
  ).lockdown;

  it('releases only with the matching requirement met, evidence, and attribution', () => {
    const released = releaseLockdown(lockdown, {
      requirementMet: 're-identity-proofing',
      evidenceRef: 'synthetic-idproof-redo-0001',
      releasedBy: 'synthetic-it-admin-001',
    });
    expect(released.status).toBe('released');
    expect(released.signals).toEqual([stuffing]);
  });

  it('a lesser requirement does not satisfy a high-risk case', () => {
    expect(() =>
      releaseLockdown(lockdown, {
        requirementMet: 'step-up',
        evidenceRef: 'x',
        releasedBy: 'synthetic-it-admin-001',
      }),
    ).toThrow(/does not satisfy/);
  });

  it('supervised-manual always stands in so nobody is permanently locked out (exception 2)', () => {
    expect(
      releaseLockdown(lockdown, {
        requirementMet: 'supervised-manual',
        evidenceRef: 'synthetic-manual-idv-0001',
        releasedBy: 'synthetic-supervisor-001',
      }).status,
    ).toBe('released');
  });

  it('missing evidence or attribution fails closed', () => {
    expect(() =>
      releaseLockdown(lockdown, {
        requirementMet: 're-identity-proofing',
        evidenceRef: '',
        releasedBy: 'x',
      }),
    ).toThrow(AuthnInvariantError);
    expect(() =>
      releaseLockdown(lockdown, {
        requirementMet: 're-identity-proofing',
        evidenceRef: 'x',
        releasedBy: '',
      }),
    ).toThrow(AuthnInvariantError);
  });
});

describe('cohort protections (AC-4)', () => {
  it('an admin invokes rate limiting + forced reset for the at-risk cohort', () => {
    const directive = invokeCohortProtection([alex, morgan], 'synthetic-it-admin-001');
    expect(directive.rateLimit).toBe(true);
    expect(directive.forcedCredentialResetPersonIds).toEqual([alex, morgan]);
  });

  it('requires an attributed admin', () => {
    expect(() => invokeCohortProtection([alex], '')).toThrow(AuthnInvariantError);
  });
});

describe('threshold tuning (exception 3)', () => {
  const current: AtoThresholds = {
    failedLoginSignalThreshold: 10,
    newDeviceSignalThreshold: 5,
    detectionEnabled: true,
  };

  it('logs every relaxation by name', () => {
    const record = tuneAtoThresholds(
      current,
      { ...current, failedLoginSignalThreshold: 15 },
      'synthetic-it-admin-001',
    );
    expect(record.logged).toBe(true);
    expect(record.relaxations).toEqual(['failedLoginSignalThreshold 10 -> 15']);
  });

  it('a tightening logs no relaxation', () => {
    const record = tuneAtoThresholds(
      current,
      { ...current, failedLoginSignalThreshold: 5 },
      'synthetic-it-admin-001',
    );
    expect(record.relaxations).toEqual([]);
  });

  it('the floor is structural — protection can be tuned, never disabled', () => {
    expect(() =>
      tuneAtoThresholds(
        current,
        {
          ...current,
          failedLoginSignalThreshold: atoThresholdFloor.failedLoginSignalThreshold + 1,
        },
        'synthetic-it-admin-001',
      ),
    ).toThrow(/never be disabled|never disabled/);
    expect(() =>
      tuneAtoThresholds(
        current,
        { ...current, newDeviceSignalThreshold: 0 },
        'synthetic-it-admin-001',
      ),
    ).toThrow(AuthnInvariantError);
  });
});

describe('device-lost lockdown (REQ-ID-024 AC-4 through the protective path)', () => {
  it('revokes the device sessions and opens a step-up case with the report recorded', () => {
    const { lockdown, sessions } = deviceLostLockdown(
      'nld-device-0001',
      tenant,
      alex,
      'nde-alex-phone',
      [activeSession('nsn-alex-a', alex)],
      'synthetic-it-admin-001',
      '2026-03-04T03:00:00Z',
      true,
    );
    expect(lockdown.trigger).toBe('device-lost');
    expect(lockdown.signals[0]?.kind).toBe('device-reported-lost');
    expect(sessions[0]?.status).toBe('revoked');
  });
});
