import { describe, expect, it } from 'vitest';

import {
  checkAuthorization,
  consumeAuthorizationUnits,
  lookupRequirement,
  type AuthorizationLine,
  type AuthorizationRecord,
  type AuthorizationRequirementRule,
} from './prior-auth.js';

const tenant = 'tenant-shadow';

const rule = (
  serviceCode: string,
  requirement: AuthorizationRequirementRule['requirement'],
  extra: Partial<AuthorizationRequirementRule> = {},
): AuthorizationRequirementRule => ({
  tenantId: tenant,
  payerRef: 'payer-synthetic-ma',
  serviceCode,
  requirement,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  ruleVersionRef: `pa-rules-v1:${serviceCode}`,
  ...extra,
});

const rules: readonly AuthorizationRequirementRule[] = [
  rule('70553', 'prior-auth'),
  rule('99204', 'referral'),
  rule('rx:glp1-synthetic', 'both'),
  rule('99213', 'none'),
];

const line = (serviceCode: string, extra: Partial<AuthorizationLine> = {}): AuthorizationLine => ({
  tenantId: tenant,
  patientRef: 'patient-syn-001',
  payerRef: 'payer-synthetic-ma',
  serviceCode,
  serviceDate: '2026-03-10',
  units: 1,
  ...extra,
});

const approved = (
  kind: AuthorizationRecord['kind'],
  serviceCode: string,
  extra: Partial<AuthorizationRecord> = {},
): AuthorizationRecord => ({
  authRef: `${kind}:${serviceCode}`,
  tenantId: tenant,
  patientRef: 'patient-syn-001',
  payerRef: 'payer-synthetic-ma',
  kind,
  serviceCodes: [serviceCode],
  status: 'approved',
  validFrom: '2026-03-01',
  validTo: '2026-03-31',
  unitsApproved: 2,
  unitsUsed: 0,
  interimSource: null,
  ...extra,
});

describe('WP-082 rework 1: PA/referral requirement lookup (review finding high)', () => {
  it('looks up the requirement per tenant, payer, service and date', () => {
    expect(lookupRequirement(rules, line('70553'))).toEqual({
      requirement: 'prior-auth',
      ruleVersionRefs: ['pa-rules-v1:70553'],
      ambiguous: false,
    });
    expect(lookupRequirement(rules, line('70553', { payerRef: 'payer-other' })).requirement).toBe(
      'unknown',
    );
    expect(lookupRequirement(rules, line('70553', { tenantId: 'tenant-other' })).requirement).toBe(
      'unknown',
    );
    expect(
      lookupRequirement([rule('70553', 'prior-auth', { effectiveTo: '2026-02-28' })], line('70553'))
        .requirement,
    ).toBe('unknown');
  });

  it('demands every kind any overlapping disagreeing rule demands, and holds', () => {
    const lookup = lookupRequirement(
      [
        rule('70553', 'prior-auth'),
        rule('70553', 'referral', { ruleVersionRef: 'pa-rules-v2:70553' }),
      ],
      line('70553'),
    );
    expect(lookup).toEqual({
      requirement: 'both',
      ruleVersionRefs: ['pa-rules-v1:70553', 'pa-rules-v2:70553'],
      ambiguous: true,
    });
  });
});

describe('WP-082 rework 1: authorization check against a line (review finding high)', () => {
  it('NEGATIVE: blocks a line whose required prior authorization is missing', () => {
    expect(checkAuthorization({ rules, records: [], line: line('70553') })).toEqual({
      outcome: 'blocked',
      requirement: 'prior-auth',
      reasons: ['prior-auth-missing'],
      authRefs: [],
      ruleVersionRefs: ['pa-rules-v1:70553'],
    });
  });

  it('clears a line with an approved, in-window prior authorization', () => {
    expect(
      checkAuthorization({
        rules,
        records: [approved('prior-auth', '70553')],
        line: line('70553'),
      }),
    ).toMatchObject({
      outcome: 'clear',
      authRefs: ['prior-auth:70553'],
    });
  });

  it('names why an existing authorization does not satisfy the line', () => {
    const cases: readonly [Partial<AuthorizationRecord>, Partial<AuthorizationLine>, string][] = [
      [{ status: 'pending' }, {}, 'prior-auth-pending'],
      [{ status: 'denied' }, {}, 'prior-auth-denied'],
      [{}, { serviceDate: '2026-04-01' }, 'prior-auth-expired'],
      [{}, { serviceDate: '2026-02-27' }, 'prior-auth-not-yet-valid'],
      [{ unitsUsed: 2 }, {}, 'prior-auth-units-exhausted'],
      [{}, { units: 3 }, 'prior-auth-units-exhausted'],
      [{ patientRef: 'patient-syn-002' }, {}, 'prior-auth-missing'],
      [{ tenantId: 'tenant-other' }, {}, 'prior-auth-missing'],
    ];
    for (const [record, lineChange, reason] of cases) {
      const decision = checkAuthorization({
        rules,
        records: [approved('prior-auth', '70553', record)],
        line: line('70553', lineChange),
      });
      expect(decision.outcome, reason).toBe('blocked');
      expect(decision.reasons, reason).toEqual([reason]);
    }
  });

  it('requires both a PA and a referral when the rule says both', () => {
    const records = [approved('prior-auth', 'rx:glp1-synthetic')];
    expect(checkAuthorization({ rules, records, line: line('rx:glp1-synthetic') })).toMatchObject({
      outcome: 'blocked',
      reasons: ['referral-missing'],
    });
    expect(
      checkAuthorization({
        rules,
        records: [...records, approved('referral', 'rx:glp1-synthetic')],
        line: line('rx:glp1-synthetic'),
      }),
    ).toMatchObject({
      outcome: 'clear',
      authRefs: ['prior-auth:rx:glp1-synthetic', 'referral:rx:glp1-synthetic'],
    });
  });

  it('clears a service that needs nothing and holds one whose requirement is unknown', () => {
    expect(checkAuthorization({ rules, records: [], line: line('99213') }).outcome).toBe('clear');
    expect(checkAuthorization({ rules, records: [], line: line('99999') })).toMatchObject({
      outcome: 'hold',
      reasons: ['requirement-unknown'],
    });
  });

  it('accepts an approved record from an interim source like any other', () => {
    expect(
      checkAuthorization({
        rules,
        records: [approved('referral', '99204', { interimSource: 'athena' })],
        line: line('99204'),
      }).outcome,
    ).toBe('clear');
  });

  it('consumes units and refuses to exceed them or to consume an unapproved record', () => {
    const record = approved('prior-auth', '70553');
    const used = consumeAuthorizationUnits(record, 2);
    expect(used.unitsUsed).toBe(2);
    expect(checkAuthorization({ rules, records: [used], line: line('70553') }).reasons).toEqual([
      'prior-auth-units-exhausted',
    ]);
    expect(() => consumeAuthorizationUnits(used, 1)).toThrow('units would be exceeded');
    expect(() => consumeAuthorizationUnits({ ...record, status: 'pending' }, 1)).toThrow(
      'only an approved',
    );
  });
});

describe('H-01 NR-129: malformed dates hold, never clear', () => {
  it('a record with a malformed validTo does not clear a line; the line is held', () => {
    const decision = checkAuthorization({
      rules,
      records: [approved('prior-auth', '70553', { validFrom: '2026-01-01', validTo: '2026-6-1' })],
      line: line('70553', { serviceDate: '2026-06-01' }),
    });
    expect(decision).toMatchObject({
      outcome: 'hold',
      authRefs: [],
      reasons: ['prior-auth-record-date-invalid'],
    });
  });

  it('a calendar-impossible date is malformed too, and a valid record still clears beside it', () => {
    const bad = approved('prior-auth', '70553', { authRef: 'pa-bad', validTo: '2026-02-30' });
    expect(
      checkAuthorization({
        rules,
        records: [bad],
        line: line('70553', { serviceDate: '2026-02-15' }),
      }).outcome,
    ).toBe('hold');
    const good = approved('prior-auth', '70553', {
      authRef: 'pa-good',
      validFrom: '2026-02-01',
      validTo: '2026-02-28',
    });
    expect(
      checkAuthorization({
        rules,
        records: [bad, good],
        line: line('70553', { serviceDate: '2026-02-15' }),
      }),
    ).toMatchObject({
      outcome: 'clear',
      authRefs: ['pa-good'],
    });
  });

  it('a malformed rule date makes the requirement unknown (HOLD), even for a "none" rule', () => {
    const malformedRules = [
      rule('99213', 'none', { effectiveFrom: '2026-1-1', ruleVersionRef: 'pa-rules-v2:99213' }),
    ];
    expect(checkAuthorization({ rules: malformedRules, records: [], line: line('99213') })).toEqual(
      {
        outcome: 'hold',
        requirement: 'unknown',
        reasons: ['requirement-unknown', 'rule-date-invalid'],
        authRefs: [],
        ruleVersionRefs: ['pa-rules-v2:99213'],
      },
    );
    const badTo = [rule('70553', 'prior-auth', { effectiveTo: '2026-13-01' })];
    expect(lookupRequirement(badTo, line('70553')).requirement).toBe('unknown');
  });

  it('a calendar-impossible service date is refused as input', () => {
    expect(() =>
      checkAuthorization({
        rules,
        records: [],
        line: line('70553', { serviceDate: '2026-02-30' }),
      }),
    ).toThrow(/valid YYYY-MM-DD/);
  });
});

describe('H-01 NR-130: the unmet reason for approvals straddling the service date', () => {
  it('reports not-valid-on-service-date, not units-exhausted, when approvals sit before and after the date', () => {
    const before = approved('prior-auth', '70553', {
      authRef: 'pa-before',
      validFrom: '2026-01-01',
      validTo: '2026-02-28',
    });
    const after = approved('prior-auth', '70553', {
      authRef: 'pa-after',
      validFrom: '2026-04-01',
      validTo: '2026-04-30',
    });
    const decision = checkAuthorization({ rules, records: [before, after], line: line('70553') });
    expect(decision).toMatchObject({
      outcome: 'blocked',
      reasons: ['prior-auth-not-valid-on-service-date'],
    });
  });

  it('still reports units-exhausted when an approval covers the date but has no units left', () => {
    const spent = approved('prior-auth', '70553', { unitsApproved: 1, unitsUsed: 1 });
    expect(checkAuthorization({ rules, records: [spent], line: line('70553') }).reasons).toEqual([
      'prior-auth-units-exhausted',
    ]);
  });
});
