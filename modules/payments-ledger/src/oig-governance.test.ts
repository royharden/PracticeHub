import { describe, expect, it } from 'vitest';

import { BalancedLedger } from './ledger.js';
import {
  absorbTakebackUnderHardship,
  OigExecutionError,
  recordCostShareMoment,
  reportDoubleBills,
  reportDoubleBillsForTenant,
  seededDoubleBillExpected,
  seededDoubleBillFixture,
  waiveCostShare,
  type CostShareMoment,
  type HardshipDetermination,
} from './oig-execution.js';

const tenant = 'northwind-synthetic';

const determination: HardshipDetermination = {
  determinationId: 'hd-1',
  tenantId: tenant,
  patientRef: 'patient-casey',
  evidenceRef: 'synthetic-hardship-evidence-0001',
  approverId: 'synthetic-rcm-lead-1',
  decidedAt: '2026-03-05T00:00:00.000Z',
  maxAmountMinor: 3000,
};

const posting = (id: string) => ({
  journalId: id,
  correlationId: `c-${id}`,
  idempotencyKey: `k-${id}`,
  occurredAt: '2026-03-06T00:00:00.000Z',
});

describe('no-double-billing report: zero false negatives over the seeded set', () => {
  it('returns every seeded group, labelled same-rail or cross-rail, and nothing else', () => {
    const findings = reportDoubleBills(seededDoubleBillFixture);
    expect(findings.map((finding) => [...finding.chargeIds]).sort()).toEqual(
      seededDoubleBillExpected.map((group) => [...group]).sort(),
    );
    expect(Object.fromEntries(findings.map((f) => [f.patientRef, [f.kind, f.rails]]))).toEqual({
      'patient-casey': ['cross-rail', ['insurance', 'membership']],
      'patient-riley': ['same-rail', ['insurance']],
      'patient-morgan': ['cross-rail', ['insurance', 'membership', 'cash']],
    });
  });

  it('scopes a tenant report to its own charges and refuses others', () => {
    const own = seededDoubleBillFixture.map((charge) => ({ ...charge, tenantId: tenant }));
    expect(reportDoubleBillsForTenant(tenant, own)).toHaveLength(3);
    expect(reportDoubleBillsForTenant(tenant, own)[0]?.tenantId).toBe(tenant);
    const [first, second] = own;
    if (first === undefined || second === undefined) throw new Error('fixture is empty');
    expect(() =>
      reportDoubleBillsForTenant(tenant, [...own, { ...first, tenantId: 'riverbend-synthetic' }]),
    ).toThrowError(new OigExecutionError('WRONG_TENANT'));
    expect(() =>
      reportDoubleBills([first, { ...second, tenantId: 'riverbend-synthetic' }]),
    ).toThrowError(new OigExecutionError('MIXED_TENANTS'));
  });
});

describe('hardship path is individual and documented', () => {
  const takeback = { takebackId: 'tb-1', amountMinor: 2500, absorb: true };

  it('absorbs a takeback only under a matching determination, as a balanced ledger set', () => {
    const ledger = new BalancedLedger();
    expect(() =>
      absorbTakebackUnderHardship(ledger, {
        tenantId: tenant,
        patientRef: 'patient-casey',
        takeback,
        determination: null,
        posting: posting('tb-none'),
      }),
    ).toThrowError(new OigExecutionError('HARDSHIP_REQUIRED'));
    for (const wrong of [
      { ...determination, patientRef: 'patient-other' },
      { ...determination, maxAmountMinor: 100 },
    ]) {
      expect(() =>
        absorbTakebackUnderHardship(ledger, {
          tenantId: tenant,
          patientRef: 'patient-casey',
          takeback,
          determination: wrong,
          posting: posting('tb-wrong'),
        }),
      ).toThrowError(new OigExecutionError('HARDSHIP_MISMATCH'));
    }
    expect(() =>
      absorbTakebackUnderHardship(ledger, {
        tenantId: tenant,
        patientRef: 'patient-casey',
        takeback: { ...takeback, amountMinor: -5 },
        determination,
        posting: posting('tb-neg'),
      }),
    ).toThrowError(new OigExecutionError('INVALID'));
    const result = absorbTakebackUnderHardship(ledger, {
      tenantId: tenant,
      patientRef: 'patient-casey',
      takeback,
      determination,
      posting: posting('tb-ok'),
    });
    expect(result.route).toBe('hardship');
    expect(ledger.journals()).toHaveLength(1);
    expect(ledger.journal(tenant, 'tb-ok')?.lines.map((line) => line.accountRef)).toEqual([
      'hardship-expense',
      'accounts-receivable',
    ]);
  });
});

describe('cost-share moments (R6-REQ-026)', () => {
  const moment: CostShareMoment = {
    tenantId: tenant,
    momentId: 'csm-1',
    patientRef: 'patient-casey',
    claimRef: 'synthetic-claim-0001',
    serviceRef: 'svc-awv',
    costShareMinor: 4000,
    currency: 'USD',
  };

  it('records the cost-share as a receivable and refuses a waiver without hardship', () => {
    const ledger = new BalancedLedger();
    recordCostShareMoment(ledger, moment, posting('csm'));
    const receivable = ledger
      .accountBalances(tenant)
      .find((row) => row.accountRef === 'accounts-receivable');
    expect(receivable?.debitMinor).toBe(4000);
    expect(() =>
      waiveCostShare(ledger, {
        moment,
        amountMinor: 4000,
        determination: null,
        posting: posting('waive-none'),
      }),
    ).toThrowError(new OigExecutionError('HARDSHIP_REQUIRED'));
    expect(() =>
      waiveCostShare(ledger, {
        moment,
        amountMinor: 3500,
        determination,
        posting: posting('waive-over-cap'),
      }),
    ).toThrowError(new OigExecutionError('HARDSHIP_MISMATCH'));
    waiveCostShare(ledger, {
      moment,
      amountMinor: 3000,
      determination,
      posting: posting('waive-ok'),
    });
    expect(ledger.journals()).toHaveLength(2);
  });
});
