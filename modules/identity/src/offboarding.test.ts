/**
 * Offboarding atomicity unit suite (WP-017, REQ-ID-025 / REQ-ID-028). The
 * zero-orphaned invariant is a CONSTRUCTION property: every owned work item is
 * reassigned with a context package, or the whole offboarding fails closed
 * before producing anything. An abrupt provider departure revokes the EPCS
 * token by the per-kind floor.
 */
import { emitAuditEvent, emptyChainState, type AuditEmitInput } from '@practicehub/audit-evidence';
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import type { AuthSession } from './authn.js';
import { executeOffboarding, type OffboardingRequest } from './offboarding.js';

const tenant = 'northwind-synthetic' as TenantId;
const staffPerson = 'np-morgan-lee' as PersonId;
const otherPerson = 'np-alex-rivera' as PersonId;

function session(overrides: Partial<AuthSession>): AuthSession {
  return {
    sessionId: 'nse-morgan-1',
    tenantId: tenant,
    personId: staffPerson,
    principal: 'staff',
    staffAccountId: 'nsa-morgan-lee',
    deviceId: 'nde-morgan-laptop',
    assurance: 'aal2',
    status: 'active',
    createdAt: '2026-03-01T08:00:00Z',
    lastActivityAt: '2026-03-25T09:00:00Z',
    synthetic: true,
    ...overrides,
  };
}

function baseRequest(overrides: Partial<OffboardingRequest> = {}): OffboardingRequest {
  return {
    tenantId: tenant,
    offboardingId: 'off-0001',
    staffAccountId: 'nsa-morgan-lee',
    staffPersonId: staffPerson,
    kind: 'planned',
    reasonRef: 'synthetic-offboarding-reason-0001',
    executedBy: 'synthetic-it-admin-001',
    occurredAt: '2026-03-25T17:00:00Z',
    hasEpcsToken: false,
    activeSessions: [
      session({ sessionId: 'nse-morgan-1' }),
      session({ sessionId: 'nse-morgan-2', deviceId: 'nde-morgan-phone' }),
    ],
    ownedWork: [
      { ownedRef: 'thread:th-0001', ownedKind: 'thread' },
      { ownedRef: 'panel:pn-north', ownedKind: 'panel' },
    ],
    reassignmentTargets: [
      {
        ownedRef: 'thread:th-0001',
        toOwnerRef: 'staff-account:nsa-jordan-kim',
        contextPackageRef: 'synthetic-context-package-0001',
      },
      {
        ownedRef: 'panel:pn-north',
        toOwnerRef: 'staff-account:nsa-jordan-kim',
        contextPackageRef: 'synthetic-context-package-0002',
      },
    ],
    ...overrides,
  };
}

describe('executeOffboarding', () => {
  it('revokes every active session of the departing member (and only theirs)', () => {
    const result = executeOffboarding(
      baseRequest({
        activeSessions: [
          session({ sessionId: 'nse-morgan-1' }),
          session({
            sessionId: 'nse-other',
            personId: otherPerson,
            staffAccountId: 'nsa-jordan-kim',
          }),
        ],
      }),
    );
    expect(result.revokedSessions).toHaveLength(1);
    expect(result.revokedSessions[0]?.sessionId).toBe('nse-morgan-1');
    expect(result.revokedSessions[0]?.status).toBe('revoked');
    expect(result.revokedSessions[0]?.revokedReason).toBe('offboarding:off-0001');
  });

  it('reassigns EVERY owned item with a context package (zero orphaned)', () => {
    const result = executeOffboarding(baseRequest());
    expect(result.reassignments).toHaveLength(2);
    for (const reassignment of result.reassignments) {
      expect(reassignment.contextPackageRef).not.toBe('');
      expect(reassignment.toOwnerRef).not.toBe('');
    }
    const emitted = emitAuditEvent(emptyChainState, result.auditInput as AuditEmitInput);
    expect(emitted.record.stream).toBe('config-change');
    expect(emitted.record.detail?.['config_ref']).toBe('offboarding:off-0001');
  });

  it('fails closed when an owned item has NO reassignment target (orphaned work)', () => {
    expect(() =>
      executeOffboarding(
        baseRequest({
          reassignmentTargets: [
            {
              ownedRef: 'thread:th-0001',
              toOwnerRef: 'staff-account:nsa-jordan-kim',
              contextPackageRef: 'synthetic-context-package-0001',
            },
            // panel:pn-north deliberately left without a target
          ],
        }),
      ),
    ).toThrow(/leaves orphaned work/);
  });

  it('fails closed when a reassignment target carries no context package', () => {
    expect(() =>
      executeOffboarding(
        baseRequest({
          reassignmentTargets: [
            {
              ownedRef: 'thread:th-0001',
              toOwnerRef: 'staff-account:nsa-jordan-kim',
              contextPackageRef: '',
            },
            {
              ownedRef: 'panel:pn-north',
              toOwnerRef: 'staff-account:nsa-jordan-kim',
              contextPackageRef: 'synthetic-context-package-0002',
            },
          ],
        }),
      ),
    ).toThrow(/context package/);
  });

  it('a planned offboarding records the sessions + role-grants floor', () => {
    const result = executeOffboarding(baseRequest());
    expect(result.case.revokedScopes).toContain('sessions');
    expect(result.case.revokedScopes).toContain('role-grants');
  });

  it('an abrupt provider departure with an EPCS token revokes it by the floor (REQ-ID-028)', () => {
    const result = executeOffboarding(
      baseRequest({
        offboardingId: 'off-0002',
        kind: 'abrupt-departure',
        hasEpcsToken: true,
        ownedWork: [{ ownedRef: 'oncall:slot-fri', ownedKind: 'on-call-slot' }],
        reassignmentTargets: [
          {
            ownedRef: 'oncall:slot-fri',
            toOwnerRef: 'staff-account:nsa-jordan-kim',
            contextPackageRef: 'synthetic-context-package-oncall',
          },
        ],
      }),
    );
    expect(result.case.revokedScopes).toEqual(
      expect.arrayContaining(['sessions', 'credentials', 'epcs-token', 'on-call-slots']),
    );
  });

  it('rejects a target that references an unknown owned item', () => {
    expect(() =>
      executeOffboarding(
        baseRequest({
          reassignmentTargets: [
            ...baseRequest().reassignmentTargets,
            {
              ownedRef: 'thread:ghost',
              toOwnerRef: 'staff-account:nsa-jordan-kim',
              contextPackageRef: 'synthetic-context-package-x',
            },
          ],
        }),
      ),
    ).toThrow(/unknown owned item/);
  });
});
