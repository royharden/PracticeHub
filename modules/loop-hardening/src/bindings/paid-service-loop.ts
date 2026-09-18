import { createHash } from 'node:crypto';

import {
  Catalog,
  FulfillmentStore,
  InMemoryPaidServiceAttemptStore,
  InMemoryPaidServiceOrderStore,
  PaidServiceLoop,
  replayPaidServiceLoop,
  type CatalogOfferSnapshot,
  type PaidServiceEvent,
  type PaidServiceEventPort,
  type PaidServiceOrder,
  type PaidServiceWorkItemInput,
  type PaidServiceWorkItemPort,
  type PurchaseInput,
} from '@practicehub/catalog-cash';
import { EntitlementJournal } from '@practicehub/membership-entitlements';
import {
  BalancedLedger,
  type PaymentRailInput,
  type PaymentRailPort,
  type RailEffectObservation,
} from '@practicehub/payments-ledger';
import { type RailResponse, type SimReceipt, VendorSimEngine } from '@practicehub/vendor-sim-kit';
import { stripeSim } from '@practicehub/vendor-simulator';

import type { LoopBinding, ProductObservation } from '../harness.js';
import type { KillPoint } from '../manifest.js';

const occurredAt = '2026-09-12T15:00:00.000Z';

const tenantFence = (tenantId: string): string =>
  createHash('sha256').update(tenantId).digest('hex').slice(0, 16);

class Rail008HarnessPort implements PaymentRailPort {
  public readonly responses: RailResponse[] = [];

  public constructor(private readonly engine: VendorSimEngine) {}

  public createPaymentIntent(input: PaymentRailInput): Promise<RailEffectObservation> {
    return Promise.resolve(this.dispatch('create-payment-intent', input));
  }

  public refund(input: PaymentRailInput): Promise<RailEffectObservation> {
    return Promise.resolve(this.dispatch('refund', input));
  }

  public reconcileEffect(input: {
    readonly tenantId: string;
    readonly effectRef: string;
    readonly idempotencyKey: string;
    readonly synthetic: boolean;
  }): Promise<RailEffectObservation> {
    if (input.synthetic !== true) throw new Error('WP033_SYNTHETIC_RAIL_REQUIRED');
    const effect = this.engine
      .snapshot()
      .effects.find((candidate) => candidate.effectKey === input.effectRef);
    if (effect === undefined) throw new Error('WP033_RAIL_EFFECT_NOT_FOUND');
    if (!effect.idempotencyKey.startsWith(`${tenantFence(input.tenantId)}:`)) {
      throw new Error('WP033_RAIL_EFFECT_TENANT_MISMATCH');
    }
    return Promise.resolve({
      effectRef: effect.effectKey,
      outcome:
        effect.state === 'landed'
          ? 'landed'
          : effect.state === 'not-landed'
            ? 'not_landed'
            : 'unknown',
      ...(effect.receiptRef === null ? {} : { receiptRef: effect.receiptRef }),
      observedAt: effect.lastSeenAt,
    });
  }

  private dispatch(
    operation: 'create-payment-intent' | 'refund',
    input: PaymentRailInput,
  ): RailEffectObservation {
    const response = this.engine.dispatch({
      railId: 'RAIL-008',
      operation,
      idempotencyKey: `${tenantFence(input.tenantId)}:${createHash('sha256')
        .update(JSON.stringify([input.tenantId, input.idempotencyKey]))
        .digest('hex')}`,
      payloadRef: `wp033-paid-service/${operation}`,
      requestedAt: occurredAt,
      payload: input,
      synthetic: true,
    });
    this.responses.push(response);
    return {
      effectRef: response.effectKey,
      outcome:
        response.effectState === 'landed'
          ? 'landed'
          : response.effectState === 'not-landed'
            ? 'not_landed'
            : 'unknown',
      ...(response.receiptRef === null ? {} : { receiptRef: response.receiptRef }),
      observedAt: occurredAt,
    };
  }
}

class WorkItemsRecorder implements PaidServiceWorkItemPort {
  public readonly opened: PaidServiceWorkItemInput[] = [];

  public open(input: PaidServiceWorkItemInput): Promise<{ readonly workItemId: string }> {
    this.opened.push(input);
    return Promise.resolve({ workItemId: input.workItemId });
  }
}

class EventsRecorder implements PaidServiceEventPort {
  public readonly published: PaidServiceEvent[] = [];
  readonly #seen = new Set<string>();

  public publish(event: PaidServiceEvent): Promise<void> {
    if (!this.#seen.has(event.idempotencyKey)) {
      this.#seen.add(event.idempotencyKey);
      this.published.push(event);
    }
    return Promise.resolve();
  }
}

export class PaidServiceLoopBinding implements LoopBinding {
  readonly #rail: Rail008HarnessPort;
  readonly #attempts = new InMemoryPaidServiceAttemptStore();
  readonly #ledger = new BalancedLedger();
  readonly #entitlements = new EntitlementJournal(this.#ledger);
  readonly #fulfillment = new FulfillmentStore();
  readonly #workItems = new WorkItemsRecorder();
  readonly #events = new EventsRecorder();
  readonly #loop: PaidServiceLoop;
  readonly #input: PurchaseInput;
  readonly #receiptEvidence: string[] = [];
  readonly #receipts: SimReceipt[] = [];
  #correlationExact = true;
  #order: PaidServiceOrder | undefined;
  #transitionCount = 0;
  #dispatchAttempts = 0;
  #receiptIngressCount = 0;

  public constructor(
    private readonly engine: VendorSimEngine,
    applicationKey: string,
  ) {
    this.#rail = new Rail008HarnessPort(engine);
    const offer: CatalogOfferSnapshot = {
      tenantId: 'northwind-synthetic',
      catalogVersionRef: 'wp033-catalog-v1',
      offerVersionRef: 'wp033-offer-v1',
      opaqueProcessorSkuRef: 'wp033-sku-v1',
      amountMinor: 2500,
      currency: 'USD',
      expiresAt: '2027-01-01T00:00:00.000Z',
      cancellationPolicyRef: 'wp033-cancel-v1',
      refundPolicyRef: 'wp033-refund-v1',
      componentLines: [
        {
          componentRef: 'wp033-component-1',
          quantity: 1,
          ownerRole: 'synthetic-guide',
          entitlementKind: 'single-service',
          fulfillmentKind: 'service',
        },
      ],
      synthetic: true,
    };
    const catalog = new Catalog();
    catalog.add(offer);
    this.#loop = new PaidServiceLoop(
      catalog,
      this.#rail,
      this.#ledger,
      this.#entitlements,
      this.#fulfillment,
      this.#workItems,
      this.#events,
      this.#attempts,
      new InMemoryPaidServiceOrderStore(),
    );
    this.#input = {
      tenantId: offer.tenantId,
      buyerRef: 'wp033-buyer-1',
      memberRef: 'wp033-member-1',
      offerRef: offer.offerVersionRef,
      processorAccountRef: 'wp033-processor-account-1',
      identityEligibility: 'eligible',
      capabilityAllowed: true,
      correlationId: 'corr:wp033-paid-service-1',
      idempotencyKey: applicationKey,
      occurredAt,
      responseDueAt: '2026-09-12T15:15:00.000Z',
      ownerRef: 'synthetic-staff:finance-1',
      ids: {
        orderId: 'wp033-order-1',
        paymentJournalId: 'wp033-journal-1',
        paymentEventId: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
        refundJournalId: 'wp033-refund-journal-1',
        refundEventId: '01ARZ3NDEKTSV4RRFFQ69G5FAY',
        workItemId: 'wp033-paid-work-1',
      },
    };
  }

  public async dispatch(): Promise<void> {
    this.#dispatchAttempts += 1;
    this.capture(await this.#loop.purchase(this.#input));
  }

  public async recover(killPoint: KillPoint): Promise<void> {
    const effect = this.engine.snapshot().effects[0];
    if (effect !== undefined) {
      const observation = await this.#rail.reconcileEffect({
        tenantId: this.#input.tenantId,
        effectRef: effect.effectKey,
        idempotencyKey: `${this.#input.idempotencyKey}:reconcile`,
        synthetic: true,
      });
      await this.#attempts.recordEffect({
        tenantId: this.#input.tenantId,
        operation: 'purchase',
        idempotencyKey: this.#input.idempotencyKey,
        effect: observation,
      });
    }
    await this.dispatch();
    if (killPoint === 'before-effect' && this.#order?.state !== 'reconciliation_held') {
      throw new Error('WP033_PARTIAL_SUBMISSION_NOT_HELD');
    }
  }

  public async settle(): Promise<void> {
    const receipts = this.engine.drainReceipts('RAIL-008');
    this.#receipts.push(...receipts);
    for (const receipt of receipts) {
      if (
        this.#order?.tenantId !== this.#input.tenantId ||
        this.#order.orderId !== this.#input.ids.orderId ||
        this.#order.railEffectRef !== receipt.effectKey
      ) {
        this.#correlationExact = false;
        throw new Error('WP033_PAID_RECEIPT_CORRELATION_MISMATCH');
      }
      const replay = replayPaidServiceLoop({
        correlationId: this.#input.correlationId,
        order: this.#order,
        ledger: this.#ledger,
        entitlements: this.#entitlements,
        fulfillment: this.#fulfillment,
      });
      if (!replay.matchesExpected) throw new Error('WP033_PAID_RECEIPT_AUTHORITY_MISMATCH');
      const journal =
        this.#order.ledgerReceipt === undefined
          ? undefined
          : this.#ledger.journal(this.#input.tenantId, this.#order.ledgerReceipt.journalId);
      if (journal?.externalReceiptRef !== receipt.receiptRef) {
        this.#correlationExact = false;
        throw new Error('WP033_PAID_RECEIPT_EVIDENCE_MISMATCH');
      }
      this.#receiptIngressCount += 1;
      this.#receiptEvidence.push(`${receipt.receiptRef}:${String(receipt.sequence)}`);
    }
  }

  public productObservation(): ProductObservation {
    const workItem = this.#workItems.opened[0];
    const evidence = [
      ...this.#receiptEvidence,
      ...this.#events.published.map((event) => event.externalReceiptRef),
    ];
    return {
      state: this.#order?.state ?? 'not-dispatched',
      transitionCount: this.#transitionCount,
      evidenceRefs: [...new Set(evidence)],
      ...(workItem === undefined
        ? {}
        : {
            ownedException: {
              ownerRef: workItem.ownerRef,
              dueAt: workItem.responseDueAt,
              reason: workItem.reason,
              evidenceRef: `workitem:${workItem.workItemId}`,
            },
          }),
      correlationExact:
        this.#correlationExact &&
        this.#order?.tenantId === this.#input.tenantId &&
        this.#order.orderId === this.#input.ids.orderId &&
        this.#order.buyerRef === this.#input.buyerRef &&
        this.#order.memberRef === this.#input.memberRef &&
        ((this.engine.snapshot().effects[0] === undefined &&
          this.#order.railEffectRef === undefined) ||
          this.#order.railEffectRef === this.engine.snapshot().effects[0]?.effectKey) &&
        this.#ledger.journals().length <= 1 &&
        this.#entitlements.events().length <= 1 &&
        this.#fulfillment.forOrder(this.#input.tenantId, this.#input.ids.orderId).length <= 1,
      terminalRegression: false,
      recoveryAttempts: this.#dispatchAttempts,
      receiptIngressCount: this.#receiptIngressCount,
    };
  }

  public railResponses(): readonly RailResponse[] {
    return this.#rail.responses;
  }

  public receipts(): readonly SimReceipt[] {
    return this.#receipts;
  }

  private capture(order: PaidServiceOrder): void {
    const before = this.#order?.state;
    this.#order = order;
    if (before !== 'reconciled' && order.state === 'reconciled') this.#transitionCount += 1;
  }
}

export async function runPaidTenantFenceProbe(): Promise<{ readonly rejected: true }> {
  const engine = new VendorSimEngine({ rails: [stripeSim] });
  const port = new Rail008HarnessPort(engine);
  const observation = await port.createPaymentIntent({
    tenantId: 'northwind-synthetic',
    processorAccountRef: 'wp033-processor-account-1',
    money: { amountMinor: 2500, currency: 'USD' },
    opaqueProcessorSkuRef: 'wp033-sku-v1',
    idempotencyKey: 'wp033-paid-tenant-fence',
    synthetic: true,
  });
  try {
    await port.reconcileEffect({
      tenantId: 'riverbend-synthetic',
      effectRef: observation.effectRef,
      idempotencyKey: 'wp033-paid-tenant-fence:reconcile',
      synthetic: true,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'WP033_RAIL_EFFECT_TENANT_MISMATCH') {
      return { rejected: true };
    }
    throw error;
  }
  throw new Error('WP033_PAID_TENANT_FENCE_NOT_BITING');
}
