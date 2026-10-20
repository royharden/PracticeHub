/**
 * WP-099 hardening H-07 (NR-152, NR-168): the portal ATO chain uses ato.ts's committed-result API,
 * revokes by (tenant, person) and never re-revokes person-only. Synthetic data only.
 */
import { describe, expect, it } from 'vitest';

import type { PersonId, TenantId } from '@practicehub/contracts';

import type { AuthSession } from '../authn.js';
import { runPortalAtoChain } from './ato-chain.js';
import { CREDENTIAL_STUFFING_DRILL, runAtoDrill, type AtoDrillScenario } from './drills.js';
import type { PortalAtoChainInput } from './types.js';

const p = (id: string): PersonId => `np-drill-${id}` as PersonId;
const OTHER_TENANT = 'riverbend-synthetic' as TenantId;

function withOtherTenantSessions(chain: PortalAtoChainInput): PortalAtoChainInput {
  const template = chain.sessions.find((session) => session.personId === p('06'));
  if (template === undefined) throw new Error('drill fixture has no session for 06');
  const foreign = (personId: PersonId): AuthSession => ({
    ...template,
    sessionId: `sess-other-tenant-${personId}`,
    tenantId: OTHER_TENANT,
    personId,
    status: 'active',
  });
  return { ...chain, sessions: [...chain.sessions, foreign(p('06')), foreign(p('03'))] };
}

describe('NR-152 / NR-168: revocation is scoped by (tenant, person)', () => {
  it("a fail-closed lockdown does not revoke the same person's sessions in another tenant", () => {
    const result = runPortalAtoChain(withOtherTenantSessions(CREDENTIAL_STUFFING_DRILL.chain));
    const account = result.accounts.find((item) => item.personId === p('06'));
    expect(account?.notification.status).toBe('fail-closed');
    const other = result.sessions.find(
      (session) => session.sessionId === `sess-other-tenant-${p('06')}`,
    );
    expect(other?.status).toBe('active');
    const own = result.sessions.filter(
      (session) =>
        session.tenantId === CREDENTIAL_STUFFING_DRILL.chain.tenantId &&
        session.personId === p('06') &&
        session.status === 'active',
    );
    expect(own).toEqual([]);
  });

  it('a notified lockdown also leaves the other tenant untouched', () => {
    const result = runPortalAtoChain(withOtherTenantSessions(CREDENTIAL_STUFFING_DRILL.chain));
    expect(
      result.sessions.find((session) => session.sessionId === `sess-other-tenant-${p('03')}`)
        ?.status,
    ).toBe('active');
  });

  it('the drill harness checks cross-tenant collateral and still passes', () => {
    const scenario: AtoDrillScenario = {
      ...CREDENTIAL_STUFFING_DRILL,
      chain: withOtherTenantSessions(CREDENTIAL_STUFFING_DRILL.chain),
    };
    const report = runAtoDrill(scenario);
    expect(report.checks.filter((check) => !check.passed)).toEqual([]);
    expect(
      report.checks.some(
        (check) => check.name === `no-collateral-revocation:${OTHER_TENANT}/${p('06')}`,
      ),
    ).toBe(true);
  });
});

describe("NR-168: the fail-closed outcome is ato.ts's committed result", () => {
  it('carries the owned supervised-manual follow-up and the committed lockdown', () => {
    const result = runPortalAtoChain(CREDENTIAL_STUFFING_DRILL.chain);
    const account = result.accounts.find((item) => item.personId === p('06'));
    const notification = account?.notification;
    if (notification?.status !== 'fail-closed') throw new Error('expected a fail-closed notice');
    expect(notification.followUp).toMatchObject({
      kind: 'ato-notification-no-trusted-channel',
      personId: p('06'),
      lockdownId: account?.lockdown.lockdownId,
      route: 'supervised-manual',
      ownerRole: 'identity-security',
    });
    expect(notification.reason).toBe(notification.followUp?.reason);
    expect(account?.lockdown.status).toBe('active');
    const revoked = result.sessions.filter(
      (session) => session.personId === p('06') && session.status === 'revoked',
    );
    expect(
      revoked.every(
        (session) => session.revokedReason === `ato-lockdown:${account?.lockdown.lockdownId ?? ''}`,
      ),
    ).toBe(true);
  });
});
