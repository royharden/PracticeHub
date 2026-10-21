import { createHash } from 'node:crypto';

import type { ClaimStore } from '../claims/store.js';
import { RcmShadowError } from '../contracts.js';
import { acceptRemit, type PayerRoute } from '../router.js';
import { accountNet, type PostingLedgerPort, type PostingLine } from './ledger-port.js';
import type {
  EftDeposit,
  FeeSchedule,
  PatientRefund,
  PostingException,
  PostingExceptionReason,
  Remit835,
} from './types.js';
import { detectPaymentVariances, type PaymentVariance } from './underpayment.js';

/** The WP-086 claim lookup posting needs; `ClaimStore` satisfies it. */
export type PostingClaimLookup = Pick<ClaimStore, 'byControlNumber'>;

export interface RemitPosterOptions {
  /** The one tenant this poster serves; every other tenant is refused. */
  readonly tenantId: string;
  readonly ledger: PostingLedgerPort;
  readonly claims: PostingClaimLookup;
  readonly schedules: readonly FeeSchedule[];
  /** Payer routes for this tenant. A payer without a route is held, never posted. */
  readonly routes: readonly PayerRoute[];
  readonly exceptionOwner?: string;
}

export interface PostRemitResult {
  /** posted: in the ledger. duplicate: this 835 was already posted. held: open exception, nothing posted. */
  readonly status: 'posted' | 'duplicate' | 'held';
  readonly journalId: string | null;
  readonly exceptions: readonly PostingException[];
  readonly variances: readonly PaymentVariance[];
}

export interface ReconciliationReport {
  readonly matchedTraces: readonly string[];
  readonly exceptions: readonly PostingException[];
  /** The ledger's clearing balance per trace equals 835 minus EFT, to the penny. */
  readonly ledgerTiesOut: boolean;
  readonly fullyReconciled: boolean;
}

export interface TakebackPosition {
  readonly claimId: string;
  readonly payerPaidMinor: number;
  readonly takebackMinor: number;
  readonly ledgerAppliedMinor: number;
  readonly patientRefundMinor: number;
  /** Payer net less refunds already issued to the patient. */
  readonly netPositionMinor: number;
  readonly ledgerAgrees: boolean;
  readonly refundCollision: boolean;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const CURRENCY = 'USD';
const CLEARING = 'insurance-clearing';
const RECEIVABLE = 'accounts-receivable';

function assertInteger(value: number, name: string, nonNegative = false): void {
  if (!Number.isSafeInteger(value) || (nonNegative && value < 0)) {
    throw new RcmShadowError(
      'POSTING_AMOUNT',
      `${name} must be a ${nonNegative ? 'non-negative ' : ''}safe integer`,
    );
  }
}

function assertToken(value: string, name: string): void {
  if (!TOKEN.test(value)) {
    throw new RcmShadowError('POSTING_INVALID', `${name} must be a token`);
  }
}

/** Signed addition that refuses to leave the safe-integer range. */
function checkedAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    throw new RcmShadowError('POSTING_AMOUNT', 'posting total overflows');
  }
  return sum;
}

function key(...parts: readonly string[]): string {
  return parts.join('\u001f');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The payment content of an 835, in a fixed field order. The transport
 * identity (remitId, railId) is excluded, so the same ERA re-delivered on the
 * other rail or under a new file id has the same body.
 */
function canonicalRemitBody(remit: Remit835): string {
  return JSON.stringify({
    tenantId: remit.tenantId,
    payerId: remit.payerId,
    traceNumber: remit.traceNumber,
    paymentMinor: remit.paymentMinor,
    claims: remit.claims.map((claim) => ({
      controlNumber: claim.controlNumber,
      chargeMinor: claim.chargeMinor,
      paidMinor: claim.paidMinor,
      adjustments: claim.adjustments.map((adj) => ({
        group: adj.group,
        carc: adj.carc,
        amountMinor: adj.amountMinor,
      })),
      lines: claim.lines.map((line) => ({
        lineId: line.lineId,
        code: line.code,
        units: line.units,
        serviceDate: line.serviceDate,
        chargeMinor: line.chargeMinor,
        allowedMinor: line.allowedMinor,
        paidMinor: line.paidMinor,
      })),
    })),
    plb: remit.plb.map((plb) => ({
      reasonCode: plb.reasonCode,
      reference: plb.reference,
      amountMinor: plb.amountMinor,
    })),
  });
}

/** Signed entries (debit positive) collapsed into balanced ledger lines. */
class Entries {
  private readonly signed = new Map<string, { account: string; source: string; net: number }>();

  public add(account: string, source: string, debitMinor: number): void {
    if (debitMinor === 0) {
      return;
    }
    const id = key(account, source);
    const current = this.signed.get(id) ?? { account, source, net: 0 };
    this.signed.set(id, { ...current, net: checkedAdd(current.net, debitMinor) });
  }

  public lines(): readonly PostingLine[] {
    return [...this.signed.values()]
      .filter((entry) => entry.net !== 0)
      .map((entry) => ({
        accountRef: entry.account,
        side: entry.net > 0 ? ('debit' as const) : ('credit' as const),
        amountMinor: Math.abs(entry.net),
        currency: CURRENCY,
        sourceRef: entry.source,
      }));
  }
}

interface PostedRemit {
  readonly remit: Remit835;
  readonly bodyHash: string;
}

/**
 * WP-089 posting: 835 remits, EFT deposits and PLB adjustments into the
 * WP-056 ledger, with underpayment detection against loaded fee schedules.
 *
 * One poster serves one tenant. An ERA's identity is its payment content
 * (payer, TRN trace number and a canonical body hash), never its transport
 * id, and the ledger idempotency key is derived from the same content, so a
 * re-delivered ERA cannot double-post.
 *
 * Penny rules: every amount is an integer in minor units and every
 * comparison is exact. A remit that does not balance is held whole, never
 * plugged. A PLB is held in its own account as an open exception and is
 * never allocated to a claim. Anything that cannot be applied to a claim is
 * posted to `unapplied-remit` and left open, so the ledger always carries the
 * full remit amount.
 */
export class RemitPoster {
  private readonly tenantId: string;
  private readonly routes = new Map<string, PayerRoute>();
  private readonly remits = new Map<string, PostedRemit>();
  private readonly efts = new Map<string, EftDeposit>();
  private readonly payerPaid = new Map<string, number>();
  private readonly takebacks = new Map<string, number>();
  private readonly open: PostingException[] = [];
  private readonly openKeys = new Set<string>();
  private readonly owner: string;

  public constructor(private readonly options: RemitPosterOptions) {
    assertToken(options.tenantId, 'tenantId');
    this.tenantId = options.tenantId;
    for (const route of options.routes) {
      if (this.routes.has(route.payerId)) {
        throw new RcmShadowError('POSTING_ROUTE', 'a payer has one route per tenant');
      }
      this.routes.set(route.payerId, route);
    }
    for (const schedule of options.schedules) {
      if (schedule.tenantId !== options.tenantId) {
        throw new RcmShadowError('POSTING_TENANT', 'a fee schedule belongs to another tenant');
      }
    }
    this.owner = options.exceptionOwner ?? 'rcm-lead';
  }

  public postRemit(remit: Remit835): PostRemitResult {
    this.assertRemit(remit);
    const eraKey = key(remit.payerId, remit.traceNumber);
    const bodyHash = sha256(canonicalRemitBody(remit));
    const prior = this.remits.get(eraKey);
    if (prior) {
      if (prior.bodyHash === bodyHash) {
        return { status: 'duplicate', journalId: null, exceptions: [], variances: [] };
      }
      return this.hold(
        remit,
        'remit-conflict',
        remit.paymentMinor,
        `era:${remit.payerId}:${remit.traceNumber}`,
      );
    }
    const route = this.routes.get(remit.payerId);
    if (!route) {
      return this.hold(remit, 'payer-unrouted', remit.paymentMinor);
    }
    if (!acceptRemit(route, remit.railId).accepted) {
      return this.hold(remit, 'enrollment-constraint', remit.paymentMinor);
    }
    const claimsNet = remit.claims.reduce((sum, claim) => checkedAdd(sum, claim.paidMinor), 0);
    const plbNet = remit.plb.reduce((sum, plb) => checkedAdd(sum, plb.amountMinor), 0);
    const drift = checkedAdd(checkedAdd(claimsNet, -plbNet), -remit.paymentMinor);
    if (drift !== 0) {
      return this.hold(remit, 'remit-unbalanced', drift);
    }

    const exceptions: PostingException[] = [];
    const variances: PaymentVariance[] = [];
    const entries = new Entries();
    const trace = `trace:${remit.traceNumber}`;
    entries.add(CLEARING, trace, remit.paymentMinor);
    for (const plb of remit.plb) {
      const reference = `plb:${plb.reasonCode}:${plb.reference}`;
      entries.add('provider-level-adjustment', reference, plb.amountMinor);
      exceptions.push(this.exception('plb-provider-level', reference, plb.amountMinor));
    }
    const payerDeltas = new Map<string, number>();
    for (const claim of remit.claims) {
      const record = this.options.claims.byControlNumber(remit.tenantId, claim.controlNumber);
      const casTotal = claim.adjustments.reduce((sum, adj) => checkedAdd(sum, adj.amountMinor), 0);
      const unapplied = `claim:${claim.controlNumber}`;
      const holdClaim = (reason: PostingExceptionReason): void => {
        entries.add('unapplied-remit', unapplied, -claim.paidMinor);
        exceptions.push(this.exception(reason, unapplied, claim.paidMinor));
      };
      if (!record) {
        holdClaim('claim-unmatched');
        continue;
      }
      if (record.payerId !== remit.payerId) {
        holdClaim('payer-mismatch');
        continue;
      }
      if (checkedAdd(claim.chargeMinor, -casTotal) !== claim.paidMinor) {
        holdClaim('claim-unbalanced');
        continue;
      }
      const prior = checkedAdd(
        this.payerPaid.get(record.claimId) ?? 0,
        payerDeltas.get(record.claimId) ?? 0,
      );
      if (claim.paidMinor < 0 && checkedAdd(prior, claim.paidMinor) < 0) {
        holdClaim('double-recoupment');
        continue;
      }
      entries.add(RECEIVABLE, `pay:${record.claimId}`, -claim.paidMinor);
      for (const adj of claim.adjustments) {
        const account = adj.group === 'PR' ? 'patient-receivable' : 'contractual-adjustment';
        entries.add(account, `adj:${record.claimId}`, adj.amountMinor);
        entries.add(RECEIVABLE, `adj:${record.claimId}`, -adj.amountMinor);
      }
      payerDeltas.set(
        record.claimId,
        checkedAdd(payerDeltas.get(record.claimId) ?? 0, claim.paidMinor),
      );
      if (claim.chargeMinor > 0) {
        // A reversal (negative charge) restates an earlier payment; it is not priced.
        variances.push(
          ...detectPaymentVariances(
            this.options.schedules,
            remit.tenantId,
            remit.payerId,
            claim.lines,
          ),
        );
      }
    }

    const lines = entries.lines();
    let journalId: string | null = null;
    if (lines.length > 0) {
      // Content-derived: a replay after a crash returns the ledger's earlier receipt.
      try {
        journalId = this.options.ledger.postBalancedSet({
          tenantId: remit.tenantId,
          journalId: `era-${sha256(eraKey).slice(0, 32)}`,
          correlationId: remit.traceNumber,
          idempotencyKey: `835:${remit.payerId}:${remit.traceNumber}:${bodyHash}`,
          rail: 'insurance',
          lines,
        }).journalId;
      } catch (error) {
        // A restarted poster has lost its ERA map; the ledger still knows this trace
        // under a different body, which is the same conflict the map would have caught.
        if ((error as { readonly code?: unknown }).code === 'IDEMPOTENCY_CONFLICT') {
          return this.hold(
            remit,
            'remit-conflict',
            remit.paymentMinor,
            `era:${remit.payerId}:${remit.traceNumber}`,
          );
        }
        throw error;
      }
    }
    this.remits.set(eraKey, { remit, bodyHash });
    for (const [claimId, delta] of payerDeltas) {
      this.payerPaid.set(claimId, checkedAdd(this.payerPaid.get(claimId) ?? 0, delta));
      if (delta < 0) {
        this.takebacks.set(claimId, checkedAdd(this.takebacks.get(claimId) ?? 0, -delta));
      }
    }
    for (const exception of exceptions) {
      this.openOnce(exception);
    }
    return { status: 'posted', journalId, exceptions, variances };
  }

  /**
   * Records a deposit. Its identity is its content, not its `eftId`: the same
   * deposit re-delivered under a new transport id is a duplicate and never
   * posts cash twice, and the ledger key is derived from the same content so
   * a restarted poster replays rather than re-posting.
   */
  public recordEft(eft: EftDeposit): {
    readonly status: 'posted' | 'duplicate';
    readonly journalId: string | null;
  } {
    assertToken(eft.eftId, 'eftId');
    this.assertTenant(eft.tenantId);
    assertToken(eft.payerId, 'payerId');
    assertToken(eft.traceNumber, 'traceNumber');
    assertInteger(eft.amountMinor, 'eft amountMinor', true);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eft.depositedOn)) {
      throw new RcmShadowError('POSTING_INVALID', 'depositedOn must be YYYY-MM-DD');
    }
    const depositKey = key(eft.payerId, eft.traceNumber, String(eft.amountMinor), eft.depositedOn);
    if (this.efts.has(depositKey)) {
      return { status: 'duplicate', journalId: null };
    }
    const depositRef = `eft:${sha256(depositKey).slice(0, 32)}`;
    let journalId: string | null = null;
    if (eft.amountMinor > 0) {
      journalId = this.options.ledger.postBalancedSet({
        tenantId: eft.tenantId,
        journalId: `eft-${sha256(depositKey).slice(0, 32)}`,
        correlationId: eft.traceNumber,
        idempotencyKey: `eft:${eft.payerId}:${eft.traceNumber}:${String(eft.amountMinor)}:${eft.depositedOn}`,
        rail: 'insurance',
        lines: [
          {
            accountRef: 'cash',
            side: 'debit',
            amountMinor: eft.amountMinor,
            currency: CURRENCY,
            sourceRef: depositRef,
          },
          {
            accountRef: CLEARING,
            side: 'credit',
            amountMinor: eft.amountMinor,
            currency: CURRENCY,
            sourceRef: `trace:${eft.traceNumber}`,
          },
        ],
      }).journalId;
    }
    this.efts.set(depositKey, eft);
    return { status: 'posted', journalId };
  }

  /** 835 <-> EFT <-> ledger reconciliation for this tenant, by trace number. */
  public reconcile(tenantId: string): ReconciliationReport {
    this.assertTenant(tenantId);
    const remitTotals = new Map<string, number>();
    const eftTotals = new Map<string, number>();
    for (const { remit } of this.remits.values()) {
      remitTotals.set(
        remit.traceNumber,
        checkedAdd(remitTotals.get(remit.traceNumber) ?? 0, remit.paymentMinor),
      );
    }
    for (const eft of this.efts.values()) {
      eftTotals.set(
        eft.traceNumber,
        checkedAdd(eftTotals.get(eft.traceNumber) ?? 0, eft.amountMinor),
      );
    }
    const journals = this.options.ledger.journals();
    const matchedTraces: string[] = [];
    const exceptions: PostingException[] = [];
    let ledgerTiesOut = true;
    const traces = [...new Set([...remitTotals.keys(), ...eftTotals.keys()])].sort();
    for (const trace of traces) {
      const remitMinor = remitTotals.get(trace);
      const eftMinor = eftTotals.get(trace);
      const clearing = accountNet(journals, tenantId, CLEARING, `trace:${trace}`);
      if (clearing !== (remitMinor ?? 0) - (eftMinor ?? 0)) {
        ledgerTiesOut = false;
      }
      if (remitMinor === undefined) {
        exceptions.push(this.exception('eft-unmatched', `trace:${trace}`, eftMinor ?? 0));
      } else if (eftMinor === undefined) {
        if (remitMinor === 0) {
          // A zero-pay (denial or notification) 835 moves no money, so no EFT follows it.
          matchedTraces.push(trace);
        } else {
          exceptions.push(this.exception('remit-without-eft', `trace:${trace}`, remitMinor));
        }
      } else if (remitMinor !== eftMinor) {
        exceptions.push(
          this.exception('eft-amount-mismatch', `trace:${trace}`, eftMinor - remitMinor),
        );
      } else {
        matchedTraces.push(trace);
      }
    }
    return {
      matchedTraces,
      exceptions,
      ledgerTiesOut,
      fullyReconciled: ledgerTiesOut && exceptions.length === 0,
    };
  }

  /** Three-way takeback position: payer, ledger and patient refunds for one claim. */
  public takebackPosition(
    tenantId: string,
    claimId: string,
    refunds: readonly PatientRefund[],
  ): TakebackPosition {
    this.assertTenant(tenantId);
    const payerPaidMinor = this.payerPaid.get(claimId) ?? 0;
    const takebackMinor = this.takebacks.get(claimId) ?? 0;
    const ledgerAppliedMinor =
      0 - accountNet(this.options.ledger.journals(), tenantId, RECEIVABLE, `pay:${claimId}`);
    let patientRefundMinor = 0;
    for (const refund of refunds) {
      if (refund.tenantId === tenantId && refund.claimId === claimId) {
        assertInteger(refund.amountMinor, 'refund amountMinor', true);
        patientRefundMinor = checkedAdd(patientRefundMinor, refund.amountMinor);
      }
    }
    return {
      claimId,
      payerPaidMinor,
      takebackMinor,
      ledgerAppliedMinor,
      patientRefundMinor,
      netPositionMinor: payerPaidMinor - patientRefundMinor,
      ledgerAgrees: ledgerAppliedMinor === payerPaidMinor,
      refundCollision: takebackMinor > 0 && patientRefundMinor > 0,
    };
  }

  public exceptions(): readonly PostingException[] {
    return [...this.open];
  }

  private hold(
    remit: Remit835,
    reason: PostingExceptionReason,
    amountMinor: number,
    reference = `remit:${remit.remitId}`,
  ): PostRemitResult {
    const exception = this.exception(reason, reference, amountMinor);
    this.openOnce(exception);
    return { status: 'held', journalId: null, exceptions: [exception], variances: [] };
  }

  /** An open exception is listed once per (reason, reference), however often its cause recurs. */
  private openOnce(exception: PostingException): void {
    const id = key(exception.reason, exception.reference);
    if (!this.openKeys.has(id)) {
      this.openKeys.add(id);
      this.open.push(exception);
    }
  }

  private exception(
    reason: PostingExceptionReason,
    reference: string,
    amountMinor: number,
  ): PostingException {
    return { reason, tenantId: this.tenantId, reference, amountMinor, owner: this.owner };
  }

  private assertTenant(tenantId: string): void {
    if (tenantId !== this.tenantId) {
      throw new RcmShadowError('POSTING_TENANT', 'this poster serves another tenant');
    }
  }

  private assertRemit(remit: Remit835): void {
    assertToken(remit.remitId, 'remitId');
    this.assertTenant(remit.tenantId);
    assertToken(remit.payerId, 'payerId');
    assertToken(remit.traceNumber, 'traceNumber');
    assertInteger(remit.paymentMinor, 'paymentMinor', true);
    for (const claim of remit.claims) {
      assertToken(claim.controlNumber, 'controlNumber');
      assertInteger(claim.chargeMinor, 'chargeMinor');
      assertInteger(claim.paidMinor, 'paidMinor');
      for (const adj of claim.adjustments) {
        assertInteger(adj.amountMinor, 'adjustment amountMinor');
      }
      for (const line of claim.lines) {
        assertInteger(line.allowedMinor, 'allowedMinor');
        assertInteger(line.paidMinor, 'line paidMinor');
        assertInteger(line.chargeMinor, 'line chargeMinor');
      }
    }
    for (const plb of remit.plb) {
      assertToken(plb.reasonCode, 'plb reasonCode');
      assertToken(plb.reference, 'plb reference');
      assertInteger(plb.amountMinor, 'plb amountMinor');
    }
  }
}
