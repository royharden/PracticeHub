import { describe, expect, it } from 'vitest';

import {
  evaluateGate,
  evaluatePromotion,
  isIssuedDossier,
  type PromotionDossier,
} from './evaluate.js';
import {
  PromotionFlags,
  REQUIRED_APPROVER_ROLES,
  type PromotionApproval,
  type SignedPromotion,
} from './flags.js';
import { ALL_PLANS, NOW, observations, passingPayer, plan, TENANT } from './test-support.js';

const SIGN_AT = '2026-03-01T12:00:00Z';
const APPROVED_AT = '2026-03-01T06:00:00Z';

function approvals(): PromotionApproval[] {
  return REQUIRED_APPROVER_ROLES.map((role) => ({
    role,
    approverId: `human-${role}`,
    decision: 'approve',
    at: APPROVED_AT,
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

const passing = evaluatePromotion(TENANT, ALL_PLANS, passingPayer('payer-1'), NOW, 'gate-agent-1');

describe('WP-092 rework: separation of duties (major)', () => {
  it('refuses one person approving under all four roles', () => {
    const flags = new PromotionFlags();
    const samePerson = REQUIRED_APPROVER_ROLES.map((role) => ({
      role,
      approverId: 'person-1',
      decision: 'approve' as const,
      at: APPROVED_AT,
    }));
    expect(() =>
      flags.markShadowReady(signed('payer-1', passing, { approvals: samePerson })),
    ).toThrow(expect.objectContaining({ code: 'FLAG_SEPARATION' }));
    expect(flags.state(TENANT, 'payer-1')).toBe('shadow');
  });

  it('refuses a person who approves under two roles even when the other two differ', () => {
    const flags = new PromotionFlags();
    const twice = approvals().map((item) =>
      item.role === 'it-security' ? { ...item, approverId: 'human-compliance' } : item,
    );
    expect(() => flags.markShadowReady(signed('payer-1', passing, { approvals: twice }))).toThrow(
      expect.objectContaining({ code: 'FLAG_SEPARATION' }),
    );
  });

  it('rework 2: case variants of one approver cannot fill two roles', () => {
    const variants = ['person-1', 'Person-1', 'PERSON-1', 'pErson-1'];
    const caseVariants = REQUIRED_APPROVER_ROLES.map((role, index) => ({
      role,
      approverId: variants[index] ?? 'person-1',
      decision: 'approve' as const,
      at: APPROVED_AT,
    }));
    const flags = new PromotionFlags();
    expect(() =>
      flags.markShadowReady(signed('payer-1', passing, { approvals: caseVariants })),
    ).toThrow(expect.objectContaining({ code: 'FLAG_SEPARATION' }));
    expect(flags.state(TENANT, 'payer-1')).toBe('shadow');
  });

  it('rework 2: a case variant of the dossier author cannot approve', () => {
    const author = approvals().map((item) =>
      item.role === 'domain-owner' ? { ...item, approverId: 'Gate-Agent-1' } : item,
    );
    expect(() =>
      new PromotionFlags().markShadowReady(signed('payer-1', passing, { approvals: author })),
    ).toThrow(expect.objectContaining({ code: 'FLAG_SELF_PROMOTION' }));
  });

  it('control: four distinct approvers still promote', () => {
    const flags = new PromotionFlags();
    expect(flags.markShadowReady(signed('payer-1', passing))).toBe('shadow-ready');
  });
});

describe('WP-092 rework: the dossier is bound to evaluatePromotion (medium)', () => {
  it('refuses a hand-built dossier that claims a pass with no gate evidence', () => {
    const forged = {
      tenantId: TENANT,
      computedAt: NOW,
      computedBy: 'gate-agent-1',
      verdict: 'pass',
      gates: [],
      payers: [{ payerId: 'payer-z', verdict: 'pass', gates: [] }],
      digest: 'f'.repeat(64),
    } as unknown as PromotionDossier;
    const flags = new PromotionFlags();
    expect(isIssuedDossier(forged)).toBe(false);
    expect(() => flags.markShadowReady(signed('payer-z', forged))).toThrow(
      expect.objectContaining({ code: 'FLAG_DOSSIER' }),
    );
    expect(() => flags.monitor(forged)).toThrow(expect.objectContaining({ code: 'FLAG_DOSSIER' }));
  });

  it('refuses a copy of a real dossier, and the issued dossier cannot be altered in place', () => {
    const copy = {
      ...passing,
      payers: passing.payers.map((payer) => ({ ...payer })),
    } as PromotionDossier;
    expect(isIssuedDossier(passing)).toBe(true);
    expect(isIssuedDossier(copy)).toBe(false);
    expect(() => new PromotionFlags().markShadowReady(signed('payer-1', copy))).toThrow(
      expect.objectContaining({ code: 'FLAG_DOSSIER' }),
    );
    expect(Object.isFrozen(passing)).toBe(true);
    expect(Object.isFrozen(passing.payers[0])).toBe(true);
    expect(() => {
      (passing.payers[0] as { verdict: string }).verdict = 'fail';
    }).toThrow(TypeError);
    expect(passing.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the digest changes with the evidence', () => {
    const other = evaluatePromotion(
      TENANT,
      ALL_PLANS,
      passingPayer('payer-2'),
      NOW,
      'gate-agent-1',
    );
    expect(other.digest).not.toBe(passing.digest);
  });
});

describe('WP-092 rework: seals are tokens (low)', () => {
  it('refuses a whitespace or blank seal', () => {
    for (const seal of [' ', '   ', 'seal 1', '']) {
      expect(() =>
        evaluateGate(
          plan('denial-free'),
          observations('denial-free', 'payer-1', 1, 1, undefined, { seal }),
          NOW,
        ),
      ).toThrow(/sealed data only/);
    }
  });
});

describe('WP-092 rework: tenant scoping (note)', () => {
  it('two tenants with the same payer id keep separate flags, rollbacks and kill switches', () => {
    const other = evaluatePromotion(
      'tenant-other',
      ALL_PLANS,
      passingPayer('payer-1').map((item) => ({
        ...item,
        tenantId: 'tenant-other',
        observationId: `o-${item.observationId}`,
      })),
      NOW,
      'gate-agent-1',
    );
    const flags = new PromotionFlags();
    flags.markShadowReady(signed('payer-1', passing));
    flags.markShadowReady(signed('payer-1', other));
    flags.rollback(TENANT, 'payer-1', 'drill', 'rcm-lead-1', '2026-03-01T13:00:00Z');
    expect(flags.state(TENANT, 'payer-1')).toBe('rolled-back');
    expect(flags.state('tenant-other', 'payer-1')).toBe('shadow-ready');
    expect(flags.killSwitch(TENANT, 'incident', 'it-sec-1', '2026-03-01T14:00:00Z')).toEqual([]);
    expect(flags.state('tenant-other', 'payer-1')).toBe('shadow-ready');
    expect(flags.log('tenant-other').map((event) => event.kind)).toEqual(['shadow-ready']);
  });

  it('refuses observations from another tenant in a dossier or in one gate evaluation', () => {
    const foreign = observations('denial-free', 'payer-1', 1, 1, undefined, {
      tenantId: 'tenant-other',
    });
    expect(() =>
      evaluatePromotion(
        TENANT,
        ALL_PLANS,
        [...passingPayer('payer-1'), ...foreign],
        NOW,
        'gate-agent-1',
      ),
    ).toThrow(expect.objectContaining({ code: 'GATE_TENANT' }));
    expect(() =>
      evaluateGate(
        plan('denial-free'),
        [...observations('denial-free', 'payer-1', 1, 1), ...foreign],
        NOW,
      ),
    ).toThrow(expect.objectContaining({ code: 'GATE_TENANT' }));
  });
});
