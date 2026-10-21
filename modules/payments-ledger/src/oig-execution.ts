import { LedgerError, type BalancedLedger, type LedgerReceipt } from './ledger.js';
import { assertSafeInteger } from './money.js';

export const oigRails = ['insurance', 'membership', 'cash'] as const;
export type OigRail = (typeof oigRails)[number];

export interface ChargeFact {
  readonly chargeId: string;
  readonly patientRef: string;
  readonly serviceRef: string;
  readonly serviceDate: string;
  readonly amountMinor: number;
  readonly rail: OigRail;
  /** The tenant the charge belongs to. A report covers exactly one tenant. */
  readonly tenantId?: string;
}

export type DoubleBillKind = 'same-rail' | 'cross-rail';

export interface DoubleBillFinding {
  readonly patientRef: string;
  readonly serviceRef: string;
  readonly serviceDate: string;
  readonly chargeIds: readonly string[];
  /** `same-rail` when every charge is on one rail, `cross-rail` otherwise. */
  readonly kind: DoubleBillKind;
  readonly rails: readonly OigRail[];
  readonly tenantId?: string;
}

export class OigExecutionError extends Error {
  public constructor(
    public readonly code:
      'MIXED_TENANTS' | 'WRONG_TENANT' | 'HARDSHIP_REQUIRED' | 'HARDSHIP_MISMATCH' | 'INVALID',
  ) {
    super(code);
    this.name = 'OigExecutionError';
  }
}

/**
 * Seeded set the report must return in full; any miss is a false negative.
 * Casey: cross-rail pair. Riley: same-rail pair (two insurance claims).
 * Morgan: one service on all three rails. Jordan: a single charge (no finding).
 */
export const seededDoubleBillFixture: readonly ChargeFact[] = [
  {
    chargeId: 'chg-insurance-awv',
    patientRef: 'patient-casey',
    serviceRef: 'svc-awv',
    serviceDate: '2026-03-01',
    amountMinor: 18000,
    rail: 'insurance',
  },
  {
    chargeId: 'chg-membership-awv',
    patientRef: 'patient-casey',
    serviceRef: 'svc-awv',
    serviceDate: '2026-03-01',
    amountMinor: 0,
    rail: 'membership',
  },
  {
    chargeId: 'chg-cash-lab',
    patientRef: 'patient-jordan',
    serviceRef: 'svc-lab',
    serviceDate: '2026-03-01',
    amountMinor: 4500,
    rail: 'cash',
  },
  {
    chargeId: 'chg-insurance-ecg-1',
    patientRef: 'patient-riley',
    serviceRef: 'svc-ecg',
    serviceDate: '2026-03-02',
    amountMinor: 9000,
    rail: 'insurance',
  },
  {
    chargeId: 'chg-insurance-ecg-2',
    patientRef: 'patient-riley',
    serviceRef: 'svc-ecg',
    serviceDate: '2026-03-02',
    amountMinor: 9000,
    rail: 'insurance',
  },
  {
    chargeId: 'chg-insurance-dexa',
    patientRef: 'patient-morgan',
    serviceRef: 'svc-dexa',
    serviceDate: '2026-03-03',
    amountMinor: 12000,
    rail: 'insurance',
  },
  {
    chargeId: 'chg-membership-dexa',
    patientRef: 'patient-morgan',
    serviceRef: 'svc-dexa',
    serviceDate: '2026-03-03',
    amountMinor: 0,
    rail: 'membership',
  },
  {
    chargeId: 'chg-cash-dexa',
    patientRef: 'patient-morgan',
    serviceRef: 'svc-dexa',
    serviceDate: '2026-03-03',
    amountMinor: 6000,
    rail: 'cash',
  },
];

/** The groups the seeded fixture must produce, as sorted charge-id lists. */
export const seededDoubleBillExpected: readonly (readonly string[])[] = [
  ['chg-insurance-awv', 'chg-membership-awv'],
  ['chg-insurance-ecg-1', 'chg-insurance-ecg-2'],
  ['chg-cash-dexa', 'chg-insurance-dexa', 'chg-membership-dexa'],
];

const pairKey = (charge: ChargeFact): string =>
  JSON.stringify([charge.tenantId ?? '', charge.patientRef, charge.serviceRef, charge.serviceDate]);

/**
 * Same tenant, patient, service and date billed more than once, on the same
 * rail or across rails. Every charge must belong to one tenant; a call that
 * mixes tenants (or mixes tenanted and untenanted charges) is refused.
 */
export function reportDoubleBills(charges: readonly ChargeFact[]): readonly DoubleBillFinding[] {
  const tenants = new Set(charges.map((charge) => charge.tenantId ?? ''));
  if (tenants.size > 1) throw new OigExecutionError('MIXED_TENANTS');
  const groups = new Map<string, ChargeFact[]>();
  for (const charge of charges) {
    const key = pairKey(charge);
    const group = groups.get(key) ?? [];
    group.push(charge);
    groups.set(key, group);
  }
  const findings: DoubleBillFinding[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sample = group[0];
    if (sample === undefined) continue;
    const rails = oigRails.filter((rail) => group.some((charge) => charge.rail === rail));
    findings.push({
      patientRef: sample.patientRef,
      serviceRef: sample.serviceRef,
      serviceDate: sample.serviceDate,
      chargeIds: group.map((charge) => charge.chargeId).sort(),
      kind: rails.length > 1 ? 'cross-rail' : 'same-rail',
      rails,
      ...(sample.tenantId === undefined ? {} : { tenantId: sample.tenantId }),
    });
  }
  return findings;
}

/** One tenant's report: every charge must carry that tenantId. */
export function reportDoubleBillsForTenant(
  tenantId: string,
  charges: readonly ChargeFact[],
): readonly DoubleBillFinding[] {
  if (tenantId.trim() === '') throw new OigExecutionError('INVALID');
  if (charges.some((charge) => charge.tenantId !== tenantId)) {
    throw new OigExecutionError('WRONG_TENANT');
  }
  return reportDoubleBills(charges);
}

export interface Takeback {
  readonly takebackId: string;
  readonly amountMinor: number;
  readonly absorb: boolean;
}

export type TakebackRoute = 'hardship' | 'reopen';

/** An absorbed takeback is hardship. It does not reopen a patient balance. */
export function routeTakeback(takeback: Takeback): TakebackRoute {
  return takeback.absorb ? 'hardship' : 'reopen';
}

/**
 * An individual, documented hardship determination (R6-REQ-028): who decided,
 * on what evidence, when, for which patient, and up to what amount. It is the
 * only thing that may absorb a takeback or waive a covered cost-share.
 */
export interface HardshipDetermination {
  readonly determinationId: string;
  readonly tenantId: string;
  readonly patientRef: string;
  readonly evidenceRef: string;
  readonly approverId: string;
  readonly decidedAt: string;
  readonly maxAmountMinor: number;
}

function assertDetermination(
  determination: HardshipDetermination | null,
  tenantId: string,
  patientRef: string,
  amountMinor: number,
): HardshipDetermination {
  if (determination === null) throw new OigExecutionError('HARDSHIP_REQUIRED');
  for (const value of [
    determination.determinationId,
    determination.evidenceRef,
    determination.approverId,
  ]) {
    if (value.trim() === '') throw new OigExecutionError('INVALID');
  }
  if (Number.isNaN(Date.parse(determination.decidedAt))) throw new OigExecutionError('INVALID');
  if (
    determination.tenantId !== tenantId ||
    determination.patientRef !== patientRef ||
    amountMinor > determination.maxAmountMinor
  ) {
    throw new OigExecutionError('HARDSHIP_MISMATCH');
  }
  return determination;
}

/**
 * Cumulative caps (R6-REQ-026/028): the hardship amounts already posted to the
 * ledger (hardship-expense debits whose sourceRef matches) plus this one must
 * stay within every cap, so splitting a waiver or repeating an absorption can
 * never exceed the moment's cost-share or the determination's maximum. An
 * identical retry of an already-posted journal is left to the ledger's
 * idempotency and is not counted twice.
 */
function assertCumulativeCap(
  ledger: BalancedLedger,
  tenantId: string,
  journalId: string,
  amountMinor: number,
  caps: readonly { readonly match: (sourceRef: string) => boolean; readonly cap: number }[],
): void {
  if (ledger.journal(tenantId, journalId) !== undefined) return;
  for (const { match, cap } of caps) {
    let used = 0;
    for (const journal of ledger.journals()) {
      if (journal.tenantId !== tenantId) continue;
      for (const line of journal.lines) {
        if (
          line.accountRef === 'hardship-expense' &&
          line.side === 'debit' &&
          match(line.sourceRef)
        ) {
          used += line.amountMinor;
        }
      }
    }
    if (used + amountMinor > cap) throw new OigExecutionError('HARDSHIP_MISMATCH');
  }
}

function assertAmount(amountMinor: number): void {
  try {
    assertSafeInteger(amountMinor, 'oig amount');
  } catch {
    throw new OigExecutionError('INVALID');
  }
  if (amountMinor <= 0) throw new OigExecutionError('INVALID');
}

interface OigPosting {
  readonly journalId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
}

/**
 * Absorb a takeback under a documented hardship determination: the amount is
 * validated and posted as a balanced set (hardship-expense debit,
 * accounts-receivable credit) so the ledger carries the absorption.
 */
export function absorbTakebackUnderHardship(
  ledger: BalancedLedger,
  input: {
    readonly tenantId: string;
    readonly patientRef: string;
    readonly takeback: Takeback;
    readonly determination: HardshipDetermination | null;
    readonly posting: OigPosting;
  },
): { readonly route: 'hardship'; readonly receipt: LedgerReceipt } {
  assertAmount(input.takeback.amountMinor);
  const determination = assertDetermination(
    input.determination,
    input.tenantId,
    input.patientRef,
    input.takeback.amountMinor,
  );
  assertCumulativeCap(ledger, input.tenantId, input.posting.journalId, input.takeback.amountMinor, [
    {
      match: (ref) => ref.endsWith(`:hardship:${determination.determinationId}`),
      cap: determination.maxAmountMinor,
    },
  ]);
  const sourceRef = `takeback:${input.takeback.takebackId}:hardship:${determination.determinationId}`;
  const receipt = ledger.postBalancedSet({
    tenantId: input.tenantId,
    ...input.posting,
    rail: 'insurance',
    lines: [
      {
        accountRef: 'hardship-expense',
        side: 'debit',
        amountMinor: input.takeback.amountMinor,
        currency: 'USD',
        sourceRef,
      },
      {
        accountRef: 'accounts-receivable',
        side: 'credit',
        amountMinor: input.takeback.amountMinor,
        currency: 'USD',
        sourceRef,
      },
    ],
  });
  return { route: 'hardship', receipt };
}

/**
 * A cost-share moment: the point where a covered service's patient
 * responsibility (copay, coinsurance, deductible) is known. The ledger records
 * it as a patient receivable; it is never discounted or waived routinely
 * (R6-REQ-026).
 */
export interface CostShareMoment {
  readonly tenantId: string;
  readonly momentId: string;
  readonly patientRef: string;
  readonly claimRef: string;
  readonly serviceRef: string;
  readonly costShareMinor: number;
  readonly currency: string;
}

export function recordCostShareMoment(
  ledger: BalancedLedger,
  moment: CostShareMoment,
  posting: OigPosting,
): LedgerReceipt {
  assertAmount(moment.costShareMinor);
  if (!/^[A-Z]{3}$/.test(moment.currency)) throw new LedgerError('INVALID_LINE');
  const sourceRef = `cost-share:${moment.momentId}:claim:${moment.claimRef}`;
  return ledger.postBalancedSet({
    tenantId: moment.tenantId,
    ...posting,
    rail: 'insurance',
    lines: [
      {
        accountRef: 'accounts-receivable',
        side: 'debit',
        amountMinor: moment.costShareMinor,
        currency: moment.currency,
        sourceRef,
      },
      {
        accountRef: 'cost-share-revenue',
        side: 'credit',
        amountMinor: moment.costShareMinor,
        currency: moment.currency,
        sourceRef,
      },
    ],
  });
}

/**
 * Reduce a recorded cost-share. Without a documented hardship determination for
 * this patient that covers the amount, the reduction is refused: covered
 * cost-share is never waived as a courtesy or a membership perk.
 */
export function waiveCostShare(
  ledger: BalancedLedger,
  input: {
    readonly moment: CostShareMoment;
    readonly amountMinor: number;
    readonly determination: HardshipDetermination | null;
    readonly posting: OigPosting;
  },
): LedgerReceipt {
  assertAmount(input.amountMinor);
  if (input.amountMinor > input.moment.costShareMinor) throw new OigExecutionError('INVALID');
  const determination = assertDetermination(
    input.determination,
    input.moment.tenantId,
    input.moment.patientRef,
    input.amountMinor,
  );
  assertCumulativeCap(ledger, input.moment.tenantId, input.posting.journalId, input.amountMinor, [
    {
      match: (ref) => ref.startsWith(`cost-share:${input.moment.momentId}:hardship:`),
      cap: input.moment.costShareMinor,
    },
    {
      match: (ref) => ref.endsWith(`:hardship:${determination.determinationId}`),
      cap: determination.maxAmountMinor,
    },
  ]);
  const sourceRef = `cost-share:${input.moment.momentId}:hardship:${determination.determinationId}`;
  return ledger.postBalancedSet({
    tenantId: input.moment.tenantId,
    ...input.posting,
    rail: 'insurance',
    lines: [
      {
        accountRef: 'hardship-expense',
        side: 'debit',
        amountMinor: input.amountMinor,
        currency: input.moment.currency,
        sourceRef,
      },
      {
        accountRef: 'accounts-receivable',
        side: 'credit',
        amountMinor: input.amountMinor,
        currency: input.moment.currency,
        sourceRef,
      },
    ],
  });
}
