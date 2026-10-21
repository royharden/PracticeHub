/**
 * H-ATO-LOCKDOWN (NR-150, NR-152): containment never depends on notification,
 * and a lockdown never reaches another tenant's session.
 */
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import {
  AtoNotificationFailClosedError,
  raiseAtoLockdown,
  raiseAtoLockdownCommitted,
  type AtoSignal,
  type CommittedAtoLockdown,
} from './ato.js';
import { AuthnInvariantError, type AuthSession } from './authn.js';
import type { EndpointAssociation } from './endpoints.js';

const tenant = 'northwind-synthetic' as TenantId;
const otherTenant = 'riverbend-synthetic' as TenantId;
const alex = 'np-alex-rivera' as PersonId;

const stuffing: AtoSignal = {
  kind: 'credential-stuffing',
  detail: 'synthetic: burst across accounts',
  observedAt: '2026-03-04T02:00:00Z',
};

function association(endpointId: string): EndpointAssociation {
  return {
    tenantId: tenant,
    endpointId,
    personId: alex,
    relationship: 'self',
    verification: 'verified',
    evidenceRef: `synthetic-evidence-${endpointId}`,
    source: 'synthetic-portal-enrollment',
    synthetic: true,
  };
}

function session(sessionId: string, tenantId: TenantId = tenant): AuthSession {
  return {
    sessionId,
    tenantId,
    personId: alex,
    principal: 'portal',
    deviceId: 'nde-alex-phone',
    assurance: 'aal1',
    status: 'active',
    createdAt: '2026-03-04T01:00:00Z',
    lastActivityAt: '2026-03-04T01:30:00Z',
    synthetic: true,
  };
}

// Every contact point was changed inside the incident: no trusted channel remains.
const attackerChannels = [association('nce-attacker-email'), association('nce-attacker-phone')];
const changed = ['nce-attacker-email', 'nce-attacker-phone'];

describe('NR-150: with no trusted channel the lockdown holds and sessions are revoked', () => {
  it('raiseAtoLockdownCommitted locks, revokes and returns an owned supervised-manual follow-up', () => {
    const result = raiseAtoLockdownCommitted(
      'nld-h-0001',
      tenant,
      alex,
      [stuffing],
      [session('nsn-attacker-a'), session('nsn-attacker-b')],
      attackerChannels,
      changed,
      true,
    );
    expect(result.lockdown).toMatchObject({
      status: 'active',
      highRiskActionsFrozen: true,
      signals: [stuffing],
    });
    expect(result.lockdown.releaseRequirement).toBe('re-identity-proofing');
    expect(result.sessions.map((s) => s.status)).toEqual(['revoked', 'revoked']);
    expect(result.notification).toMatchObject({
      status: 'follow-up-required',
      followUp: {
        kind: 'ato-notification-no-trusted-channel',
        tenantId: tenant,
        personId: alex,
        lockdownId: 'nld-h-0001',
        route: 'supervised-manual',
        ownerRole: 'identity-security',
      },
    });
  });

  it('with no verified channel at all the lockdown still holds', () => {
    const result = raiseAtoLockdownCommitted(
      'nld-h-0002',
      tenant,
      alex,
      [stuffing],
      [session('nsn-a')],
      [],
      [],
      true,
    );
    expect(result.lockdown.status).toBe('active');
    expect(result.sessions[0]?.status).toBe('revoked');
    expect(result.notification.status).toBe('follow-up-required');
  });

  it('containment is committed before notification is attempted', () => {
    const order: string[] = [];
    let seen: CommittedAtoLockdown | undefined;
    const result = raiseAtoLockdownCommitted(
      'nld-h-0003',
      tenant,
      alex,
      [stuffing],
      [session('nsn-a')],
      attackerChannels,
      changed,
      true,
      {
        onCommit: (committed) => {
          order.push('commit');
          seen = committed;
        },
      },
    );
    order.push(result.notification.status);
    expect(order).toEqual(['commit', 'follow-up-required']);
    expect(seen?.lockdown.status).toBe('active');
    expect(seen?.sessions[0]?.status).toBe('revoked');
  });

  it('the legacy raiseAtoLockdown commits first and its error carries the containment', () => {
    let persisted: CommittedAtoLockdown | undefined;
    let caught: unknown;
    try {
      raiseAtoLockdown(
        'nld-h-0004',
        tenant,
        alex,
        [stuffing],
        [session('nsn-a')],
        attackerChannels,
        changed,
        true,
        {
          onCommit: (committed) => {
            persisted = committed;
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AtoNotificationFailClosedError);
    expect(caught).toBeInstanceOf(AuthnInvariantError);
    const failure = caught as AtoNotificationFailClosedError;
    expect(failure.committed.lockdown.status).toBe('active');
    expect(failure.committed.sessions[0]?.status).toBe('revoked');
    expect(failure.followUp.route).toBe('supervised-manual');
    expect(persisted?.sessions[0]?.status).toBe('revoked');
  });

  it('a trusted channel still notifies as before', () => {
    const result = raiseAtoLockdownCommitted(
      'nld-h-0005',
      tenant,
      alex,
      [stuffing],
      [session('nsn-a')],
      [association('nce-alex-email'), association('nce-attacker-email')],
      ['nce-attacker-email'],
      true,
    );
    expect(result.notification).toMatchObject({
      status: 'sent',
      directive: { endpointId: 'nce-alex-email', channelBasis: 'prior-verified-fallback' },
    });
  });
});

describe('NR-152: session revocation is tenant-scoped', () => {
  it("revokes only the lockdown tenant's sessions for the person", () => {
    const result = raiseAtoLockdownCommitted(
      'nld-h-0006',
      tenant,
      alex,
      [stuffing],
      [session('nsn-here'), session('nsn-there', otherTenant)],
      [association('nce-alex-email')],
      [],
      true,
    );
    expect(result.sessions.find((s) => s.sessionId === 'nsn-here')?.status).toBe('revoked');
    expect(result.sessions.find((s) => s.sessionId === 'nsn-there')?.status).toBe('active');
  });
});
