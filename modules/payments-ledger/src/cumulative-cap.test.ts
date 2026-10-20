/**
 * WP-095 targeted fix (review D46-WP-095-a2-review-2): hardship waivers and
 * absorptions are capped cumulatively, per cost-share moment and per
 * determination, not per call.
 */
import { describe, expect, it } from 'vitest';

import { BalancedLedger } from './ledger.js';
import {
  absorbTakebackUnderHardship,
  OigExecutionError,
  recordCostShareMoment,
  waiveCostShare,
  type CostShareMoment,
  type HardshipDetermination,
} from './oig-execution.js';

const tenant = 'northwind-synthetic';
const posting = (id: string) => ({
  journalId: id,
  correlationId: `c-${id}`,
  idempotencyKey: `k-${id}`,
  occurredAt: '2026-03-06T00:00:00.000Z',
});
const determination = (maxAmountMinor: number): HardshipDetermination => ({
  determinationId: 'hd-cap',
  tenantId: tenant,
  patientRef: 'patient-casey',
  evidenceRef: 'synthetic-evidence',
  approverId: 'synthetic-rcm-lead-1',
  decidedAt: '2026-03-05T00:00:00.000Z',
  maxAmountMinor,
});
const moment: CostShareMoment = {
  tenantId: tenant,
  momentId: 'csm-cap',
  patientRef: 'patient-casey',
  claimRef: 'claim-1',
  serviceRef: 'svc-awv',
  costShareMinor: 4000,
  currency: 'USD',
};
const receivable = (ledger: BalancedLedger) =>
  ledger.accountBalances(tenant).find((row) => row.accountRef === 'accounts-receivable');

describe('cumulative hardship caps', () => {
  it('refuses a second 3000 waiver on a 4000 cost-share with a 3000 determination (review probe)', () => {
    const ledger = new BalancedLedger();
    recordCostShareMoment(ledger, moment, posting('csm'));
    waiveCostShare(ledger, {
      moment,
      amountMinor: 3000,
      determination: determination(3000),
      posting: posting('w1'),
    });
    expect(() =>
      waiveCostShare(ledger, {
        moment,
        amountMinor: 3000,
        determination: determination(3000),
        posting: posting('w2'),
      }),
    ).toThrowError(new OigExecutionError('HARDSHIP_MISMATCH'));
    expect(receivable(ledger)).toMatchObject({ debitMinor: 4000, creditMinor: 3000 });
  });

  it('caps split waivers at the moment cost-share even under a larger determination', () => {
    const ledger = new BalancedLedger();
    recordCostShareMoment(ledger, moment, posting('csm'));
    waiveCostShare(ledger, {
      moment,
      amountMinor: 3000,
      determination: determination(10_000),
      posting: posting('w1'),
    });
    expect(() =>
      waiveCostShare(ledger, {
        moment,
        amountMinor: 1001,
        determination: determination(10_000),
        posting: posting('w2'),
      }),
    ).toThrowError(new OigExecutionError('HARDSHIP_MISMATCH'));
    waiveCostShare(ledger, {
      moment,
      amountMinor: 1000,
      determination: determination(10_000),
      posting: posting('w3'),
    });
    expect(receivable(ledger)).toMatchObject({ debitMinor: 4000, creditMinor: 4000 });
  });

  it('caps repeated absorptions at the determination maximum, and an identical retry is still idempotent', () => {
    const ledger = new BalancedLedger();
    const absorb = (id: string, amountMinor: number) =>
      absorbTakebackUnderHardship(ledger, {
        tenantId: tenant,
        patientRef: 'patient-casey',
        takeback: { takebackId: id, amountMinor, absorb: true },
        determination: determination(3000),
        posting: posting(id),
      });
    const first = absorb('tb-1', 2000);
    expect(absorb('tb-1', 2000).receipt).toEqual(first.receipt);
    expect(() => absorb('tb-2', 2000)).toThrowError(new OigExecutionError('HARDSHIP_MISMATCH'));
    absorb('tb-3', 1000);
    expect(ledger.journals()).toHaveLength(2);
  });
});
