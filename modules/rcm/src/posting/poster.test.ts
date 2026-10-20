import { describe, expect, it } from 'vitest';

import { ClaimLifecycle } from '../claims/lifecycle.js';
import { InMemoryClaimStore } from '../claims/store.js';
import { ClearinghouseRouter, type PayerRoute } from '../router.js';
import { accountNet, Wp056BalancedLedgerDouble } from './ledger-port.js';
import { RemitPoster } from './poster.js';
import type { ClaimPayment, FeeSchedule, Remit835 } from './types.js';

const TENANT = 'tenant-synth';

const route: PayerRoute = {
  payerId: 'payer-1',
  primary: 'ch-sim-A',
  secondary: 'ch-sim-B',
  enrolledTransactions: ['837', '835'],
};

const schedules: FeeSchedule[] = [
  {
    tenantId: TENANT,
    scheduleId: 'fs-payer-1',
    payerId: 'payer-1',
    version: '2026.1',
    effectiveOn: '2026-01-01',
    rates: { '99213': 15_000, '99214': 7_500 },
  },
  {
    tenantId: TENANT,
    scheduleId: 'fs-payer-1',
    payerId: 'payer-1',
    version: '2025.1',
    effectiveOn: '2025-01-01',
    rates: { '99213': 14_000, '99214': 7_000 },
  },
];

function paid(
  controlNumber: string,
  chargeMinor: number,
  paidMinor: number,
  co: number,
  pr: number,
  code: string,
  serviceDate = '2026-09-01',
): ClaimPayment {
  return {
    controlNumber,
    chargeMinor,
    paidMinor,
    adjustments: [
      { group: 'CO', carc: '45', amountMinor: co },
      { group: 'PR', carc: '2', amountMinor: pr },
    ],
    lines: [
      {
        lineId: `${controlNumber}-l1`,
        code,
        units: 1,
        serviceDate,
        chargeMinor,
        allowedMinor: paidMinor + pr,
        paidMinor,
      },
    ],
  };
}

function remit(
  remitId: string,
  traceNumber: string,
  paymentMinor: number,
  claims: ClaimPayment[],
  plb: Remit835['plb'] = [],
): Remit835 {
  return {
    remitId,
    tenantId: TENANT,
    payerId: 'payer-1',
    railId: 'ch-sim-A',
    paymentMinor,
    traceNumber,
    claims,
    plb,
  };
}

/** Synthetic fixture: two claims, one PLB overpayment recovery, one matching EFT. */
const R1 = remit(
  'r1',
  'T1',
  17_000,
  [
    paid('ctl-1', 20_000, 12_000, 5_000, 3_000, '99213'),
    paid('ctl-2', 10_000, 6_000, 3_000, 1_000, '99214'),
  ],
  [{ reasonCode: 'WO', reference: 'OVP-1', amountMinor: 1_000 }],
);

function registerClaims(store: InMemoryClaimStore, tenantId: string): void {
  const lifecycle = new ClaimLifecycle({
    store,
    router: new ClearinghouseRouter([route], 'dual-rail'),
    rails: [],
    clock: () => 1,
    orphanWindowMs: 60_000,
  });
  for (const n of [1, 2, 3]) {
    lifecycle.register({
      claimId: tenantId === TENANT ? `claim-${String(n)}` : `${tenantId}-claim-${String(n)}`,
      tenantId,
      payerId: 'payer-1',
      controlNumber: `ctl-${String(n)}`,
      totalMinor: 20_000,
      lines: [{ lineId: 'line-1', code: '99213', units: 1, serviceDate: '2026-09-01' }],
    });
  }
}

function harness(routes: PayerRoute[] = [route]) {
  const store = new InMemoryClaimStore();
  registerClaims(store, TENANT);
  const ledger = new Wp056BalancedLedgerDouble();
  const poster = new RemitPoster({ tenantId: TENANT, ledger, claims: store, schedules, routes });
  return { store, ledger, poster };
}

describe('WP-089 835 <-> EFT <-> ledger reconciliation', () => {
  it('reconciles the synthetic fixture 100 percent', () => {
    const { ledger, poster } = harness();
    expect(poster.postRemit(R1).status).toBe('posted');
    expect(
      poster.recordEft({
        eftId: 'e1',
        tenantId: TENANT,
        payerId: 'payer-1',
        depositedOn: '2026-09-10',
        traceNumber: 'T1',
        amountMinor: 17_000,
      }).status,
    ).toBe('posted');
    expect(poster.reconcile(TENANT)).toEqual({
      matchedTraces: ['T1'],
      exceptions: [],
      ledgerTiesOut: true,
      fullyReconciled: true,
    });
    const journals = ledger.journals();
    expect(accountNet(journals, TENANT, 'insurance-clearing')).toBe(0);
    expect(accountNet(journals, TENANT, 'cash')).toBe(17_000);
    expect(accountNet(journals, TENANT, 'accounts-receivable', 'pay:claim-1')).toBe(-12_000);
    expect(accountNet(journals, TENANT, 'accounts-receivable', 'pay:claim-2')).toBe(-6_000);
    expect(accountNet(journals, TENANT, 'patient-receivable')).toBe(4_000);
    expect(accountNet(journals, TENANT, 'contractual-adjustment')).toBe(8_000);
  });

  it('opens an exception for a one-cent EFT difference', () => {
    const { poster } = harness();
    poster.postRemit(R1);
    poster.recordEft({
      eftId: 'e1',
      tenantId: TENANT,
      payerId: 'payer-1',
      depositedOn: '2026-09-10',
      traceNumber: 'T1',
      amountMinor: 16_999,
    });
    const report = poster.reconcile(TENANT);
    expect(report.fullyReconciled).toBe(false);
    expect(report.ledgerTiesOut).toBe(true);
    expect(report.exceptions).toEqual([
      {
        reason: 'eft-amount-mismatch',
        tenantId: TENANT,
        reference: 'trace:T1',
        amountMinor: -1,
        owner: 'rcm-lead',
      },
    ]);
  });

  it('reports a remit with no EFT and an EFT with no remit', () => {
    const { poster } = harness();
    poster.postRemit(R1);
    poster.recordEft({
      eftId: 'e9',
      tenantId: TENANT,
      payerId: 'payer-1',
      depositedOn: '2026-09-10',
      traceNumber: 'T9',
      amountMinor: 500,
    });
    expect(poster.reconcile(TENANT).exceptions.map((item) => item.reason)).toEqual([
      'remit-without-eft',
      'eft-unmatched',
    ]);
  });

  it('treats a duplicate ERA and a duplicate EFT as no-ops', () => {
    const { ledger, poster } = harness();
    poster.postRemit(R1);
    poster.recordEft({
      eftId: 'e1',
      tenantId: TENANT,
      payerId: 'payer-1',
      depositedOn: '2026-09-10',
      traceNumber: 'T1',
      amountMinor: 17_000,
    });
    const count = ledger.journals().length;
    expect(poster.postRemit(R1).status).toBe('duplicate');
    expect(
      poster.recordEft({
        eftId: 'e1',
        tenantId: TENANT,
        payerId: 'payer-1',
        depositedOn: '2026-09-10',
        traceNumber: 'T1',
        amountMinor: 17_000,
      }).status,
    ).toBe('duplicate');
    expect(ledger.journals()).toHaveLength(count);
    expect(poster.reconcile(TENANT).fullyReconciled).toBe(true);
  });

  it('holds an unmatched claim payment in unapplied-remit and still ties out', () => {
    const { ledger, poster } = harness();
    const result = poster.postRemit(
      remit('r5', 'T5', 4_000, [paid('ctl-none', 5_000, 4_000, 1_000, 0, '99213')]),
    );
    expect(result.exceptions.map((item) => item.reason)).toEqual(['claim-unmatched']);
    expect(accountNet(ledger.journals(), TENANT, 'unapplied-remit')).toBe(-4_000);
    poster.recordEft({
      eftId: 'e5',
      tenantId: TENANT,
      payerId: 'payer-1',
      depositedOn: '2026-09-10',
      traceNumber: 'T5',
      amountMinor: 4_000,
    });
    expect(poster.reconcile(TENANT).ledgerTiesOut).toBe(true);
  });

  it('rejects an 835 from a payer not enrolled for 835', () => {
    const { ledger, poster } = harness([{ ...route, enrolledTransactions: ['837'] }]);
    const result = poster.postRemit(R1);
    expect(result.status).toBe('held');
    expect(result.exceptions[0]?.reason).toBe('enrollment-constraint');
    expect(ledger.journals()).toEqual([]);
  });
});

describe('WP-089 PLB is never forced to balance', () => {
  it('rejects a remit that is one cent out rather than plugging it', () => {
    const { ledger, poster } = harness();
    const result = poster.postRemit({ ...R1, paymentMinor: 17_001 });
    expect(result.status).toBe('held');
    expect(result.exceptions).toEqual([
      {
        reason: 'remit-unbalanced',
        tenantId: TENANT,
        reference: 'remit:r1',
        amountMinor: -1,
        owner: 'rcm-lead',
      },
    ]);
    expect(ledger.journals()).toEqual([]);
  });

  it('holds a PLB in its own account and never allocates it to a claim', () => {
    const { ledger, poster } = harness();
    const result = poster.postRemit(R1);
    expect(result.exceptions).toEqual([
      {
        reason: 'plb-provider-level',
        tenantId: TENANT,
        reference: 'plb:WO:OVP-1',
        amountMinor: 1_000,
        owner: 'rcm-lead',
      },
    ]);
    const journals = ledger.journals();
    expect(accountNet(journals, TENANT, 'provider-level-adjustment', 'plb:WO:OVP-1')).toBe(1_000);
    expect(accountNet(journals, TENANT, 'accounts-receivable', 'pay:claim-1')).toBe(-12_000);
    expect(poster.exceptions()).toHaveLength(1);
  });
});

describe('WP-089 underpayment detection against loaded fee schedules', () => {
  it('flags an underpaid line to the penny with the schedule version', () => {
    const { poster } = harness();
    const { variances } = poster.postRemit(R1);
    expect(variances).toEqual([
      {
        lineId: 'ctl-2-l1',
        code: '99214',
        kind: 'underpaid',
        scheduleId: 'fs-payer-1',
        scheduleVersion: '2026.1',
        expectedMinor: 7_500,
        allowedMinor: 7_000,
        varianceMinor: 500,
      },
    ]);
  });

  it('uses the schedule in force on the service date and reports overpayment and missing rates', () => {
    const { poster } = harness();
    const { variances } = poster.postRemit(
      remit('r6', 'T6', 20_000, [
        paid('ctl-1', 20_000, 12_000, 5_000, 3_000, '99213', '2025-06-01'),
        paid('ctl-2', 10_000, 8_000, 2_000, 0, '99999'),
      ]),
    );
    expect(variances.map((item) => [item.kind, item.scheduleVersion, item.varianceMinor])).toEqual([
      ['overpaid', '2025.1', -1_000],
      ['no-rate', '2026.1', null],
    ]);
  });
});

describe('WP-089 takeback three-way', () => {
  const takeback = paid('ctl-1', -20_000, -12_000, -5_000, -3_000, '99213');
  const fresh = paid('ctl-3', 20_000, 15_000, 5_000, 0, '99213');

  it('computes the net position across payer, ledger and patient refund', () => {
    const { poster } = harness();
    poster.postRemit(R1);
    expect(poster.postRemit(remit('r2', 'T2', 3_000, [takeback, fresh])).status).toBe('posted');
    const position = poster.takebackPosition(TENANT, 'claim-1', [
      { refundId: 'rf-1', tenantId: TENANT, claimId: 'claim-1', amountMinor: 3_000 },
    ]);
    expect(position).toEqual({
      claimId: 'claim-1',
      payerPaidMinor: 0,
      takebackMinor: 12_000,
      ledgerAppliedMinor: 0,
      patientRefundMinor: 3_000,
      netPositionMinor: -3_000,
      ledgerAgrees: true,
      refundCollision: true,
    });
  });

  it('holds a double recoupment open instead of applying it', () => {
    const { ledger, poster } = harness();
    poster.postRemit(R1);
    poster.postRemit(remit('r2', 'T2', 3_000, [takeback, fresh]));
    const again = poster.postRemit(
      remit('r3', 'T3', 3_000, [takeback, paid('ctl-2', 20_000, 15_000, 5_000, 0, '99213')]),
    );
    expect(again.exceptions.map((item) => item.reason)).toEqual(['double-recoupment']);
    const position = poster.takebackPosition(TENANT, 'claim-1', []);
    expect(position.payerPaidMinor).toBe(0);
    expect(position.ledgerAppliedMinor).toBe(0);
    expect(position.ledgerAgrees).toBe(true);
    expect(accountNet(ledger.journals(), TENANT, 'unapplied-remit')).toBe(12_000);
    for (const [eftId, trace, amount] of [
      ['e1', 'T1', 17_000],
      ['e2', 'T2', 3_000],
      ['e3', 'T3', 3_000],
    ] as const) {
      poster.recordEft({
        eftId,
        tenantId: TENANT,
        payerId: 'payer-1',
        depositedOn: '2026-09-10',
        traceNumber: trace,
        amountMinor: amount,
      });
    }
    expect(poster.reconcile(TENANT).fullyReconciled).toBe(true);
  });

  it('reports no collision when no refund was issued', () => {
    const { poster } = harness();
    poster.postRemit(R1);
    expect(poster.takebackPosition(TENANT, 'claim-1', [])).toMatchObject({
      payerPaidMinor: 12_000,
      takebackMinor: 0,
      ledgerAgrees: true,
      refundCollision: false,
    });
  });
});

describe('WP-089 rework 1 (review 0191)', () => {
  it('[high] posts one 835 once, whatever remitId or rail it arrives under', () => {
    const { ledger, poster } = harness();
    expect(poster.postRemit(R1).status).toBe('posted');
    const journals = ledger.journals().length;
    expect(poster.postRemit({ ...R1, remitId: 'r1-redelivered' }).status).toBe('duplicate');
    expect(poster.postRemit({ ...R1, remitId: 'r1-other-rail', railId: 'ch-sim-B' }).status).toBe(
      'duplicate',
    );
    expect(ledger.journals()).toHaveLength(journals);
    expect(accountNet(ledger.journals(), TENANT, 'accounts-receivable', 'pay:claim-1')).toBe(
      -12_000,
    );
    expect(poster.takebackPosition(TENANT, 'claim-1', []).payerPaidMinor).toBe(12_000);
  });

  it('[high] holds a second 835 on the same payer and trace with a different body', () => {
    const { ledger, poster } = harness();
    poster.postRemit(R1);
    const journals = ledger.journals().length;
    const altered = remit('r1-altered', 'T1', 12_000, [
      paid('ctl-1', 20_000, 12_000, 5_000, 3_000, '99213'),
    ]);
    const result = poster.postRemit(altered);
    expect(result.status).toBe('held');
    expect(result.exceptions.map((item) => [item.reason, item.reference])).toEqual([
      ['remit-conflict', 'era:payer-1:T1'],
    ]);
    expect(ledger.journals()).toHaveLength(journals);
  });

  it('[low] a restarted poster replays against the ledger instead of double-posting', () => {
    const { store, ledger, poster } = harness();
    const first = poster.postRemit(R1);
    const restarted = new RemitPoster({
      tenantId: TENANT,
      ledger,
      claims: store,
      schedules,
      routes: [route],
    });
    const replay = restarted.postRemit({ ...R1, remitId: 'r1-after-crash' });
    expect(replay.journalId).toBe(first.journalId);
    expect(ledger.journals()).toHaveLength(1);
    expect(accountNet(ledger.journals(), TENANT, 'accounts-receivable', 'pay:claim-1')).toBe(
      -12_000,
    );
  });

  it('[low] the ledger double replays an identical payload and refuses a changed one', () => {
    const ledger = new Wp056BalancedLedgerDouble();
    const journal = {
      tenantId: TENANT,
      journalId: 'j-1',
      correlationId: 'c-1',
      idempotencyKey: 'k-1',
      lines: [
        {
          accountRef: 'cash',
          side: 'debit' as const,
          amountMinor: 100,
          currency: 'USD',
          sourceRef: 's',
        },
        {
          accountRef: 'ar',
          side: 'credit' as const,
          amountMinor: 100,
          currency: 'USD',
          sourceRef: 's',
        },
      ],
    };
    expect(ledger.postBalancedSet(journal).journalId).toBe('j-1');
    expect(ledger.postBalancedSet(journal).journalId).toBe('j-1');
    expect(ledger.journals()).toHaveLength(1);
    const changed = {
      ...journal,
      lines: journal.lines.map((line) => ({ ...line, amountMinor: 200 })),
    };
    expect(() => ledger.postBalancedSet(changed)).toThrow(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
    );
    expect(() => ledger.postBalancedSet({ ...journal, idempotencyKey: 'k-2' })).toThrow(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
    );
  });

  it('[medium] reconciles a zero-pay denial 835 that has no EFT', () => {
    const { poster } = harness();
    poster.postRemit(R1);
    const denial = remit('r0', 'T0', 0, [paid('ctl-3', 10_000, 0, 10_000, 0, '99213')]);
    expect(poster.postRemit(denial).status).toBe('posted');
    poster.recordEft({
      eftId: 'e1',
      tenantId: TENANT,
      payerId: 'payer-1',
      depositedOn: '2026-09-10',
      traceNumber: 'T1',
      amountMinor: 17_000,
    });
    expect(poster.reconcile(TENANT)).toEqual({
      matchedTraces: ['T0', 'T1'],
      exceptions: [],
      ledgerTiesOut: true,
      fullyReconciled: true,
    });
  });

  it('[medium] prices each tenant with its own schedule and refuses another tenant', () => {
    const store = new InMemoryClaimStore();
    registerClaims(store, TENANT);
    registerClaims(store, 'tenant-b');
    const scheduleB: FeeSchedule = {
      tenantId: 'tenant-b',
      scheduleId: 'fs-payer-1',
      payerId: 'payer-1',
      version: '2026.1',
      effectiveOn: '2026-01-01',
      rates: { '99213': 16_000, '99214': 7_000 },
    };
    const posterA = new RemitPoster({
      tenantId: TENANT,
      ledger: new Wp056BalancedLedgerDouble(),
      claims: store,
      schedules,
      routes: [route],
    });
    const posterB = new RemitPoster({
      tenantId: 'tenant-b',
      ledger: new Wp056BalancedLedgerDouble(),
      claims: store,
      schedules: [scheduleB],
      routes: [route],
    });
    const remitB: Remit835 = {
      ...remit('rb', 'TB', 12_000, [paid('ctl-1', 20_000, 12_000, 5_000, 3_000, '99213')]),
      tenantId: 'tenant-b',
    };
    expect(
      posterB.postRemit(remitB).variances.map((item) => [item.scheduleVersion, item.varianceMinor]),
    ).toEqual([['2026.1', 1_000]]);
    expect(
      posterA.postRemit({ ...remitB, tenantId: TENANT, remitId: 'ra', traceNumber: 'TA' })
        .variances,
    ).toEqual([]);
    expect(() => posterA.postRemit(remitB)).toThrow(
      expect.objectContaining({ code: 'POSTING_TENANT' }),
    );
    expect(() => posterA.reconcile('tenant-b')).toThrow(
      expect.objectContaining({ code: 'POSTING_TENANT' }),
    );
    expect(
      () =>
        new RemitPoster({
          tenantId: TENANT,
          ledger: new Wp056BalancedLedgerDouble(),
          claims: store,
          schedules: [scheduleB],
          routes: [route],
        }),
    ).toThrow(expect.objectContaining({ code: 'POSTING_TENANT' }));
  });

  it('[medium] holds a remit from an unrouted payer instead of posting it', () => {
    const { ledger, poster } = harness();
    const result = poster.postRemit({ ...R1, payerId: 'payer-2' });
    expect(result.status).toBe('held');
    expect(result.exceptions[0]?.reason).toBe('payer-unrouted');
    expect(ledger.journals()).toEqual([]);
  });

  it("[medium] never applies one payer's payment to another payer's claim", () => {
    const payer2: PayerRoute = { ...route, payerId: 'payer-2' };
    const { ledger, poster } = harness([route, payer2]);
    const result = poster.postRemit({
      ...remit('rp2', 'TP2', 12_000, [paid('ctl-1', 20_000, 12_000, 5_000, 3_000, '99213')]),
      payerId: 'payer-2',
    });
    expect(result.exceptions.map((item) => item.reason)).toEqual(['payer-mismatch']);
    expect(accountNet(ledger.journals(), TENANT, 'accounts-receivable', 'pay:claim-1')).toBe(0);
    expect(accountNet(ledger.journals(), TENANT, 'unapplied-remit')).toBe(-12_000);
  });

  it('[medium] applies per-rail 835 enrollment for the rail the remit arrived on', () => {
    const perRail: PayerRoute = {
      ...route,
      enrollment: [
        { railId: 'ch-sim-A', transactions: ['837', '835'] },
        { railId: 'ch-sim-B', transactions: ['837'] },
      ],
    };
    const { poster } = harness([perRail]);
    expect(poster.postRemit({ ...R1, railId: 'ch-sim-B' }).exceptions[0]?.reason).toBe(
      'enrollment-constraint',
    );
    expect(poster.postRemit(R1).status).toBe('posted');
  });

  it('[low] lists a repeatedly rejected remit once', () => {
    const { poster } = harness();
    poster.postRemit({ ...R1, paymentMinor: 17_001 });
    poster.postRemit({ ...R1, paymentMinor: 17_001 });
    expect(poster.exceptions().filter((item) => item.reason === 'remit-unbalanced')).toHaveLength(
      1,
    );
  });

  it('[low] refuses remit totals outside the safe-integer range', () => {
    const { poster } = harness();
    const huge = Number.MAX_SAFE_INTEGER;
    const overflow = remit('rbig', 'TBIG', 0, [
      { ...paid('ctl-1', huge, huge, 0, 0, '99213'), lines: [] },
      { ...paid('ctl-2', huge, huge, 0, 0, '99213'), lines: [] },
    ]);
    expect(() => poster.postRemit(overflow)).toThrow(
      expect.objectContaining({ code: 'POSTING_AMOUNT' }),
    );
  });
});

describe('WP-089 rework 2 (hardening H-089-EFT)', () => {
  const deposit = {
    tenantId: TENANT,
    payerId: 'payer-1',
    traceNumber: 'T1',
    amountMinor: 17_000,
    depositedOn: '2026-09-10',
  };

  it('posts a deposit re-delivered under a new eftId once', () => {
    const { ledger, poster } = harness();
    poster.postRemit(R1);
    expect(poster.recordEft({ ...deposit, eftId: 'e1' }).status).toBe('posted');
    expect(poster.recordEft({ ...deposit, eftId: 'e1-redelivered' }).status).toBe('duplicate');
    expect(accountNet(ledger.journals(), TENANT, 'cash')).toBe(17_000);
    expect(poster.reconcile(TENANT).fullyReconciled).toBe(true);
  });

  it('a restarted poster replays a re-delivered deposit against the ledger', () => {
    const { store, ledger, poster } = harness();
    poster.postRemit(R1);
    poster.recordEft({ ...deposit, eftId: 'e1' });
    const restarted = new RemitPoster({
      tenantId: TENANT,
      ledger,
      claims: store,
      schedules,
      routes: [route],
    });
    restarted.recordEft({ ...deposit, eftId: 'e1-after-crash' });
    expect(accountNet(ledger.journals(), TENANT, 'cash')).toBe(17_000);
  });

  it('a distinct deposit on another day still posts', () => {
    const { ledger, poster } = harness();
    poster.recordEft({ ...deposit, eftId: 'e1' });
    expect(poster.recordEft({ ...deposit, eftId: 'e2', depositedOn: '2026-09-11' }).status).toBe(
      'posted',
    );
    expect(accountNet(ledger.journals(), TENANT, 'cash')).toBe(34_000);
  });

  it('a restarted poster holds a conflicting body for a posted trace instead of throwing', () => {
    const { store, ledger, poster } = harness();
    poster.postRemit(R1);
    const restarted = new RemitPoster({
      tenantId: TENANT,
      ledger,
      claims: store,
      schedules,
      routes: [route],
    });
    const altered = remit('r1-altered', 'T1', 12_000, [
      paid('ctl-1', 20_000, 12_000, 5_000, 3_000, '99213'),
    ]);
    const result = restarted.postRemit(altered);
    expect(result.status).toBe('held');
    expect(result.exceptions.map((item) => [item.reason, item.reference])).toEqual([
      ['remit-conflict', 'era:payer-1:T1'],
    ]);
    expect(ledger.journals()).toHaveLength(1);
  });
});
