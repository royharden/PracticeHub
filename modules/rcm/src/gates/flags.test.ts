import { describe, expect, it } from 'vitest';

import { evaluatePromotion, type PromotionDossier } from './evaluate.js';
import {
  PromotionFlags,
  REQUIRED_APPROVER_ROLES,
  type PromotionApproval,
  type SignedPromotion,
} from './flags.js';
import { ALL_PLANS, NOW, observations, passingPayer, TENANT } from './test-support.js';

const SIGN_AT = '2026-03-01T12:00:00Z';

function approvals(at = '2026-03-01T06:00:00Z'): PromotionApproval[] {
  return REQUIRED_APPROVER_ROLES.map((role) => ({
    role,
    approverId: `human-${role}`,
    decision: 'approve',
    at,
  }));
}

function signed(
  payerId: string,
  dossier: PromotionDossier,
  overrides: Partial<SignedPromotion> = {},
): SignedPromotion {
  return {
    payerId,
    dossier,
    approvals: approvals(),
    monitoringOwner: 'rcm-lead-1',
    rollbackTarget: 'shadow',
    at: SIGN_AT,
    ...overrides,
  };
}

const passing = evaluatePromotion(
  TENANT,
  ALL_PLANS,
  [...passingPayer('payer-1'), ...passingPayer('payer-2')],
  NOW,
  'gate-agent-1',
);

describe('WP-092 per-payer rollback flag drill', () => {
  it('drill: two payers reach shadow-ready, one rolls back, the other is untouched, and live stays out of reach', () => {
    const flags = new PromotionFlags();
    expect(flags.state(TENANT, 'payer-1')).toBe('shadow');
    expect(flags.markShadowReady(signed('payer-1', passing))).toBe('shadow-ready');
    expect(flags.markShadowReady(signed('payer-2', passing))).toBe('shadow-ready');

    expect(
      flags.rollback(
        TENANT,
        'payer-1',
        'drill: rollback flag',
        'rcm-lead-1',
        '2026-03-01T13:00:00Z',
      ),
    ).toBe('rolled-back');
    expect(flags.state(TENANT, 'payer-1')).toBe('rolled-back');
    expect(flags.state(TENANT, 'payer-2')).toBe('shadow-ready');
    expect(flags.authority(TENANT, 'payer-1')).toBe('incumbent');
    expect(flags.authority(TENANT, 'payer-2')).toBe('incumbent');
    expect(() => flags.promoteLive('payer-2')).toThrow(/ceiling is shadow-ready/);

    expect(
      flags.log().map((event) => `${event.payerId}:${event.kind}:${event.from}>${event.to}`),
    ).toEqual([
      'payer-1:shadow-ready:shadow>shadow-ready',
      'payer-2:shadow-ready:shadow>shadow-ready',
      'payer-1:rollback:shadow-ready>rolled-back',
    ]);
    expect(Object.isFrozen(flags.log())).toBe(true);
  });

  it('a rolled-back payer re-qualifies only with a dossier newer than the rollback', () => {
    const flags = new PromotionFlags();
    flags.markShadowReady(signed('payer-1', passing));
    flags.rollback(TENANT, 'payer-1', 'drill', 'rcm-lead-1', '2026-03-01T13:00:00Z');
    expect(() =>
      flags.markShadowReady(signed('payer-1', passing, { at: '2026-03-01T14:00:00Z' })),
    ).toThrow(/newer dossier/);
    const fresh = evaluatePromotion(
      TENANT,
      ALL_PLANS,
      passingPayer('payer-1'),
      '2026-03-02T00:00:00Z',
      'gate-agent-1',
    );
    expect(
      flags.markShadowReady(
        signed('payer-1', fresh, {
          at: '2026-03-02T06:00:00Z',
          approvals: approvals('2026-03-02T01:00:00Z'),
        }),
      ),
    ).toBe('shadow-ready');
  });

  it('the kill switch rolls back every shadow-ready payer at once', () => {
    const flags = new PromotionFlags();
    flags.markShadowReady(signed('payer-1', passing));
    flags.markShadowReady(signed('payer-2', passing));
    expect(flags.killSwitch(TENANT, 'rail incident', 'it-sec-1', '2026-03-01T13:00:00Z')).toEqual([
      'payer-1',
      'payer-2',
    ]);
    expect([flags.state(TENANT, 'payer-1'), flags.state(TENANT, 'payer-2')]).toEqual([
      'rolled-back',
      'rolled-back',
    ]);
  });

  it('monitoring rolls back only the payer whose fresh dossier stops passing', () => {
    const flags = new PromotionFlags();
    flags.markShadowReady(signed('payer-1', passing));
    flags.markShadowReady(signed('payer-2', passing));
    const later = evaluatePromotion(
      TENANT,
      ALL_PLANS,
      [
        ...passingPayer('payer-1'),
        ...passingPayer('payer-2').filter((item) => item.gateId !== 'denial-free'),
        ...observations('denial-free', 'payer-2', 200, 120),
      ],
      '2026-03-05T00:00:00Z',
      'gate-agent-1',
    );
    expect(flags.monitor(later)).toEqual(['payer-2']);
    expect(flags.state(TENANT, 'payer-1')).toBe('shadow-ready');
    expect(flags.state(TENANT, 'payer-2')).toBe('rolled-back');
    expect(flags.log().at(-1)).toMatchObject({
      kind: 'monitor-rollback',
      reason: 'monitor verdict fail',
    });
  });

  it('refuses promotion without passing evidence for that payer', () => {
    const mixed = evaluatePromotion(
      TENANT,
      ALL_PLANS,
      [...passingPayer('payer-1'), ...observations('denial-free', 'payer-3', 200, 200)],
      NOW,
      'gate-agent-1',
    );
    const flags = new PromotionFlags();
    expect(() => flags.markShadowReady(signed('payer-3', mixed))).toThrow(
      /insufficient evidence blocks/,
    );
    expect(() => flags.markShadowReady(signed('payer-9', mixed))).toThrow(
      /no evidence for this payer/,
    );
    expect(flags.markShadowReady(signed('payer-1', mixed))).toBe('shadow-ready');
  });

  it('requires an explicit approval from every human role, and no self-approval', () => {
    const flags = new PromotionFlags();
    const three = approvals().slice(0, 3);
    expect(() => flags.markShadowReady(signed('payer-1', passing, { approvals: three }))).toThrow(
      /missing approval from it-security/,
    );
    const moreEvidence = approvals().map((item) =>
      item.role === 'compliance' ? { ...item, decision: 'more-evidence' as const } : item,
    );
    expect(() =>
      flags.markShadowReady(signed('payer-1', passing, { approvals: moreEvidence })),
    ).toThrow(/compliance decided more-evidence/);
    const self = approvals().map((item) =>
      item.role === 'domain-owner' ? { ...item, approverId: 'gate-agent-1' } : item,
    );
    expect(() => flags.markShadowReady(signed('payer-1', passing, { approvals: self }))).toThrow(
      /cannot approve its own/,
    );
    const early = approvals('2026-02-28T00:00:00Z');
    expect(() => flags.markShadowReady(signed('payer-1', passing, { approvals: early }))).toThrow(
      /between the dossier/,
    );
    expect(flags.state(TENANT, 'payer-1')).toBe('shadow');
  });

  it('refuses a stale dossier, a missing monitoring owner and changes that go back in time', () => {
    const flags = new PromotionFlags(24);
    expect(() =>
      flags.markShadowReady(
        signed('payer-1', passing, {
          at: '2026-03-03T00:00:00Z',
          approvals: approvals('2026-03-02T00:00:00Z'),
        }),
      ),
    ).toThrow(/recently before/);
    expect(() =>
      flags.markShadowReady(signed('payer-1', passing, { monitoringOwner: '' })),
    ).toThrow(/monitoring owner/);
    flags.markShadowReady(signed('payer-1', passing));
    expect(() =>
      flags.rollback(TENANT, 'payer-1', 'x', 'rcm-lead-1', '2026-03-01T11:00:00Z'),
    ).toThrow(/back in time/);
    expect(() =>
      flags.rollback(TENANT, 'payer-2', 'x', 'rcm-lead-1', '2026-03-01T13:00:00Z'),
    ).toThrow(/nothing to roll back/);
    expect(() =>
      flags.rollback(TENANT, 'payer-1', '', 'rcm-lead-1', '2026-03-01T13:00:00Z'),
    ).toThrow(/actor token and a reason/);
  });
});
