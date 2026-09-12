import { createHash } from 'node:crypto';

import type { EntitlementEvent, EntitlementJournal } from '@practicehub/membership-entitlements';
import { validatePaymentRailInput } from '@practicehub/payments-ledger';
import type {
  BalancedLedger,
  LedgerReceipt,
  PaymentRailPort,
  RailEffectObservation,
} from '@practicehub/payments-ledger';

import type { Catalog, CatalogOfferSnapshot } from './catalog.js';
import { InMemoryPaidServiceAttemptStore, type PaidServiceAttemptPort } from './attempt-store.js';
import type { FulfillmentObligation, FulfillmentStore } from './fulfillment.js';
import type { PaidServiceEventPort } from './event-port.js';
import type { PaidServiceWorkItemPort, ReconciliationReason } from './workitem-port.js';
import { InMemoryPaidServiceOrderStore, type PaidServiceOrderPort } from './order-store.js';

export type IdentityEligibility = 'eligible' | 'conflict_quarantined' | 'duplicate_held';
export type PaidServiceOrderState =
  'reconciled' | 'failed_not_landed' | 'reconciliation_held' | 'identity_held' | 'refunded';

export interface LoopIds {
  readonly orderId: string;
  readonly paymentJournalId: string;
  readonly paymentEventId: string;
  readonly refundJournalId: string;
  readonly refundEventId: string;
  readonly workItemId: string;
}

export interface PurchaseInput {
  readonly tenantId: string;
  readonly buyerRef: string;
  readonly memberRef: string;
  readonly offerRef: string;
  readonly processorAccountRef: string;
  readonly capabilityAllowed: boolean;
  readonly identityEligibility: IdentityEligibility;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly responseDueAt: string;
  readonly ownerRef: string;
  readonly ids: LoopIds;
}

export interface PaidServiceOrder {
  readonly tenantId: string;
  readonly orderId: string;
  readonly buyerRef: string;
  readonly memberRef: string;
  readonly offer: CatalogOfferSnapshot;
  readonly state: PaidServiceOrderState;
  readonly railEffectRef?: string;
  readonly ledgerReceipt?: LedgerReceipt;
  readonly workItemId?: string;
  readonly refundDecision?: RefundDecision;
  readonly entitlementEvents: readonly EntitlementEvent[];
  readonly fulfillment: readonly FulfillmentObligation[];
}

export interface RefundDecision {
  readonly reasonCode: string;
  readonly evidenceRef: string;
  readonly approverRef: string;
  readonly recipientRef: string;
}

export interface RefundInput {
  readonly purchaseKey: string;
  readonly tenantId: string;
  readonly occurredAt: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly processorAccountRef: string;
  readonly capabilityAllowed: boolean;
  readonly responseDueAt: string;
  readonly ownerRef: string;
  readonly decision: RefundDecision;
  readonly ids: LoopIds;
}

const tupleKey = (...parts: readonly string[]): string => JSON.stringify(parts);

const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const purchaseIdentity = (input: PurchaseInput): string =>
  digest({
    tenantId: input.tenantId,
    buyerRef: input.buyerRef,
    memberRef: input.memberRef,
    offerRef: input.offerRef,
    processorAccountRef: input.processorAccountRef,
    identityEligibility: input.identityEligibility,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
    responseDueAt: input.responseDueAt,
    ownerRef: input.ownerRef,
    ids: input.ids,
  });

const refundIdentity = (input: RefundInput): string =>
  digest({
    purchaseKey: input.purchaseKey,
    tenantId: input.tenantId,
    occurredAt: input.occurredAt,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    processorAccountRef: input.processorAccountRef,
    responseDueAt: input.responseDueAt,
    ownerRef: input.ownerRef,
    decision: input.decision,
    ids: input.ids,
  });

export class PaidServiceLoop {
  readonly #orders = new Map<string, { hash: string; order: PaidServiceOrder }>();
  readonly #refunds = new Map<string, { hash: string; order: PaidServiceOrder }>();
  readonly #purchaseAttempts = new Map<string, { hash: string; effect?: RailEffectObservation }>();
  readonly #refundAttempts = new Map<
    string,
    { hash: string; effect?: RailEffectObservation; workItemId?: string }
  >();
  readonly #purchaseInFlight = new Map<
    string,
    { hash: string; promise: Promise<PaidServiceOrder> }
  >();
  readonly #refundInFlight = new Map<
    string,
    { hash: string; promise: Promise<PaidServiceOrder> }
  >();
  readonly #refundAuthority = new Map<string, string>();

  public constructor(
    private readonly catalog: Catalog,
    private readonly rail: PaymentRailPort,
    private readonly ledger: BalancedLedger,
    private readonly entitlements: EntitlementJournal,
    private readonly fulfillment: FulfillmentStore,
    private readonly workItems: PaidServiceWorkItemPort,
    private readonly events: PaidServiceEventPort,
    private readonly durableAttempts: PaidServiceAttemptPort = new InMemoryPaidServiceAttemptStore(),
    private readonly orderStore: PaidServiceOrderPort = new InMemoryPaidServiceOrderStore(),
  ) {}

  public async purchase(input: PurchaseInput): Promise<PaidServiceOrder> {
    if (!input.capabilityAllowed) throw new Error('CAPABILITY_DENIED');
    const key = tupleKey(input.tenantId, input.idempotencyKey);
    const hash = purchaseIdentity(input);
    const prior = this.#orders.get(key);
    if (prior !== undefined) {
      if (prior.hash !== hash) throw new Error('IDEMPOTENCY_CONFLICT');
      return prior.order;
    }
    const persisted = await this.orderStore.load(input.tenantId, input.idempotencyKey);
    if (persisted !== undefined) {
      if (persisted.requestHash !== hash) throw new Error('IDEMPOTENCY_CONFLICT');
      this.#orders.set(key, { hash, order: persisted.order });
      return persisted.order;
    }
    const inFlight = this.#purchaseInFlight.get(key);
    if (inFlight !== undefined) {
      if (inFlight.hash !== hash) throw new Error('IDEMPOTENCY_CONFLICT');
      return inFlight.promise;
    }
    const attempt = this.#purchaseAttempts.get(key);
    if (attempt !== undefined && attempt.hash !== hash) throw new Error('IDEMPOTENCY_CONFLICT');
    if (attempt === undefined) this.#purchaseAttempts.set(key, { hash });
    const promise = this.#executePurchase(input, key, hash);
    this.#purchaseInFlight.set(key, { hash, promise });
    try {
      const order = await promise;
      await this.orderStore.save({
        tenantId: input.tenantId,
        purchaseKey: input.idempotencyKey,
        requestHash: hash,
        occurredAt: input.occurredAt,
        order,
      });
      return order;
    } finally {
      this.#purchaseInFlight.delete(key);
    }
  }

  async #executePurchase(
    input: PurchaseInput,
    key: string,
    hash: string,
  ): Promise<PaidServiceOrder> {
    const offer = this.catalog.quoteForCheckout({
      tenantId: input.tenantId,
      offerRef: input.offerRef,
      asOf: input.occurredAt,
    });
    await this.durableAttempts.reserve({
      tenantId: input.tenantId,
      operation: 'purchase',
      idempotencyKey: input.idempotencyKey,
      requestHash: hash,
      authorityHash: digest(offer),
      orderRef: input.ids.orderId,
    });
    if (input.identityEligibility !== 'eligible') {
      const reason =
        input.identityEligibility === 'conflict_quarantined'
          ? 'IDENTITY_CONFLICT'
          : 'DUPLICATE_HELD';
      const workItemId = await this.#openWorkItem(input, reason);
      await this.durableAttempts.recordWorkItem({
        tenantId: input.tenantId,
        operation: 'purchase',
        idempotencyKey: input.idempotencyKey,
        workItemId,
      });
      return this.#remember(key, hash, {
        tenantId: input.tenantId,
        orderId: input.ids.orderId,
        buyerRef: input.buyerRef,
        memberRef: input.memberRef,
        offer,
        state: 'identity_held',
        workItemId,
        entitlementEvents: [],
        fulfillment: [],
      });
    }
    const railInput = {
      tenantId: input.tenantId,
      processorAccountRef: input.processorAccountRef,
      money: { amountMinor: offer.amountMinor, currency: offer.currency },
      opaqueProcessorSkuRef: offer.opaqueProcessorSkuRef,
      idempotencyKey: `${input.idempotencyKey}:payment`,
      synthetic: true,
    } as const;
    validatePaymentRailInput(railInput);
    const attempt = this.#purchaseAttempts.get(key);
    const durableAttempt = await this.durableAttempts.load(
      input.tenantId,
      'purchase',
      input.idempotencyKey,
    );
    let effect = durableAttempt?.effect ?? attempt?.effect;
    if (effect === undefined) {
      if (durableAttempt?.submitted === true) {
        const workItemId =
          durableAttempt.workItemId ?? (await this.#openWorkItem(input, 'PARTIAL_COMMIT'));
        if (durableAttempt.workItemId === undefined) {
          await this.durableAttempts.recordWorkItem({
            tenantId: input.tenantId,
            operation: 'purchase',
            idempotencyKey: input.idempotencyKey,
            workItemId,
          });
        }
        return this.#remember(key, hash, {
          tenantId: input.tenantId,
          orderId: input.ids.orderId,
          buyerRef: input.buyerRef,
          memberRef: input.memberRef,
          offer,
          state: 'reconciliation_held',
          workItemId,
          entitlementEvents: [],
          fulfillment: [],
        });
      }
      await this.durableAttempts.markSubmitted({
        tenantId: input.tenantId,
        operation: 'purchase',
        idempotencyKey: input.idempotencyKey,
      });
      effect = await this.rail.createPaymentIntent(railInput);
      this.#purchaseAttempts.set(key, { hash, effect });
      await this.durableAttempts.recordEffect({
        tenantId: input.tenantId,
        operation: 'purchase',
        idempotencyKey: input.idempotencyKey,
        effect,
      });
    }
    if (effect.outcome === 'not_landed') {
      return this.#remember(key, hash, {
        tenantId: input.tenantId,
        orderId: input.ids.orderId,
        buyerRef: input.buyerRef,
        memberRef: input.memberRef,
        offer,
        state: 'failed_not_landed',
        railEffectRef: effect.effectRef,
        entitlementEvents: [],
        fulfillment: [],
      });
    }
    if (effect.outcome === 'unknown' || effect.receiptRef === undefined) {
      const reason = effect.outcome === 'unknown' ? 'PAYMENT_UNKNOWN' : 'LANDED_WITHOUT_RECEIPT';
      const workItemId = await this.#openWorkItem(input, reason);
      await this.durableAttempts.recordWorkItem({
        tenantId: input.tenantId,
        operation: 'purchase',
        idempotencyKey: input.idempotencyKey,
        workItemId,
      });
      return this.#remember(key, hash, {
        tenantId: input.tenantId,
        orderId: input.ids.orderId,
        buyerRef: input.buyerRef,
        memberRef: input.memberRef,
        offer,
        state: 'reconciliation_held',
        railEffectRef: effect.effectRef,
        workItemId,
        entitlementEvents: [],
        fulfillment: [],
      });
    }
    const ledgerReceipt = this.ledger.postBalancedSet({
      tenantId: input.tenantId,
      journalId: input.ids.paymentJournalId,
      correlationId: input.correlationId,
      idempotencyKey: `${input.idempotencyKey}:ledger`,
      processorEffectRef: effect.effectRef,
      externalReceiptRef: effect.receiptRef,
      lines: [
        {
          accountRef: 'cash',
          side: 'debit',
          amountMinor: offer.amountMinor,
          currency: offer.currency,
          sourceRef: effect.effectRef,
        },
        {
          accountRef: 'paid-service-liability',
          side: 'credit',
          amountMinor: offer.amountMinor,
          currency: offer.currency,
          sourceRef: effect.effectRef,
        },
      ],
    });
    const entitlementEvents: EntitlementEvent[] = [];
    const obligations: FulfillmentObligation[] = [];
    for (const component of offer.componentLines) {
      for (let index = 0; index < component.quantity; index += 1) {
        const instanceRef = `${component.componentRef}#${index + 1}`;
        entitlementEvents.push(
          this.entitlements.grant({
            tenantId: input.tenantId,
            eventId: `${input.ids.orderId}:grant:${instanceRef}`,
            memberRef: input.memberRef,
            componentRef: instanceRef,
            entitlementKind: component.entitlementKind,
            authorityJournalId: ledgerReceipt.journalId,
            idempotencyKey: `${input.idempotencyKey}:grant:${instanceRef}`,
          }),
        );
        obligations.push(
          this.fulfillment.createPaid({
            tenantId: input.tenantId,
            obligationId: `${input.ids.orderId}:fulfill:${instanceRef}`,
            orderRef: input.ids.orderId,
            offerVersionRef: offer.offerVersionRef,
            componentRef: instanceRef,
            ownerRole: component.ownerRole,
            state: 'paid',
          }),
        );
      }
    }
    await this.events.publish({
      eventId: input.ids.paymentEventId,
      tenantId: input.tenantId,
      type: 'payment.reconciled',
      orderRef: input.ids.orderId,
      journalRef: ledgerReceipt.journalId,
      occurredAt: input.occurredAt,
      correlationId: input.correlationId,
      idempotencyKey: `${input.idempotencyKey}:event`,
      externalReceiptRef: effect.receiptRef,
    });
    await this.durableAttempts.complete({
      tenantId: input.tenantId,
      operation: 'purchase',
      idempotencyKey: input.idempotencyKey,
    });
    return this.#remember(key, hash, {
      tenantId: input.tenantId,
      orderId: input.ids.orderId,
      buyerRef: input.buyerRef,
      memberRef: input.memberRef,
      offer,
      state: 'reconciled',
      railEffectRef: effect.effectRef,
      ledgerReceipt,
      entitlementEvents,
      fulfillment: obligations,
    });
  }

  public async refund(input: RefundInput): Promise<PaidServiceOrder> {
    if (!input.capabilityAllowed) throw new Error('CAPABILITY_DENIED');
    const refundKey = tupleKey(input.tenantId, input.idempotencyKey);
    const refundHash = refundIdentity(input);
    const persistedRefund = await this.orderStore.load(input.tenantId, input.purchaseKey);
    if (persistedRefund?.order.state === 'refunded') {
      if (
        persistedRefund.refundKey !== input.idempotencyKey ||
        persistedRefund.refundHash !== refundHash
      ) {
        throw new Error('REFUND_ALREADY_RESERVED');
      }
      this.#refunds.set(refundKey, { hash: refundHash, order: persistedRefund.order });
      return persistedRefund.order;
    }
    const purchaseOrderKey = tupleKey(input.tenantId, input.purchaseKey);
    const priorRefund = this.#refunds.get(refundKey);
    if (priorRefund !== undefined) {
      if (priorRefund.hash !== refundHash) throw new Error('IDEMPOTENCY_CONFLICT');
      return priorRefund.order;
    }
    const inFlight = this.#refundInFlight.get(refundKey);
    if (inFlight !== undefined) {
      if (inFlight.hash !== refundHash) throw new Error('IDEMPOTENCY_CONFLICT');
      return inFlight.promise;
    }
    const attempt = this.#refundAttempts.get(refundKey);
    if (attempt !== undefined && attempt.hash !== refundHash)
      throw new Error('IDEMPOTENCY_CONFLICT');
    const reservedBy = this.#refundAuthority.get(purchaseOrderKey);
    if (reservedBy !== undefined && reservedBy !== refundKey)
      throw new Error('REFUND_ALREADY_RESERVED');
    this.#refundAuthority.set(purchaseOrderKey, refundKey);
    if (attempt === undefined) this.#refundAttempts.set(refundKey, { hash: refundHash });
    const promise = this.#executeRefund(input, refundKey, refundHash);
    this.#refundInFlight.set(refundKey, { hash: refundHash, promise });
    try {
      return await promise;
    } finally {
      this.#refundInFlight.delete(refundKey);
    }
  }

  async #executeRefund(
    input: RefundInput,
    refundKey: string,
    refundHash: string,
  ): Promise<PaidServiceOrder> {
    if (Object.values(input.decision).some((value) => value.trim() === '')) {
      throw new Error('REFUND_DECISION_INCOMPLETE');
    }
    const persisted = await this.orderStore.load(input.tenantId, input.purchaseKey);
    const stored =
      this.#orders.get(tupleKey(input.tenantId, input.purchaseKey)) ??
      (persisted === undefined
        ? undefined
        : { hash: persisted.requestHash, order: persisted.order });
    if (stored === undefined || stored.order.state !== 'reconciled') {
      throw new Error('REFUND_REQUIRES_RECONCILED_PURCHASE');
    }
    const order = stored.order;
    await this.durableAttempts.reserve({
      tenantId: input.tenantId,
      operation: 'refund',
      idempotencyKey: input.idempotencyKey,
      requestHash: refundHash,
      authorityHash: digest({
        offer: order.offer,
        railEffectRef: order.railEffectRef,
        ledgerReceipt: order.ledgerReceipt,
      }),
      orderRef: order.orderId,
    });
    const originalEffectRef = order.railEffectRef;
    const originalLedgerReceipt = order.ledgerReceipt;
    if (originalEffectRef === undefined || originalLedgerReceipt === undefined) {
      throw new Error('REFUND_REQUIRES_RECONCILED_PURCHASE');
    }
    const originalJournal = this.ledger.journal(input.tenantId, originalLedgerReceipt.journalId);
    if (
      originalJournal === undefined ||
      originalJournal.reversalOfJournalId !== undefined ||
      digest(originalJournal) !== originalLedgerReceipt.canonicalPayloadHash
    ) {
      throw new Error('REFUND_AUTHORITY_NOT_REHYDRATED');
    }
    const expectedComponentCount = order.offer.componentLines.reduce(
      (count, component) => count + component.quantity,
      0,
    );
    const expectedGrantIds = new Set(order.entitlementEvents.map((event) => event.eventId));
    const currentEntitlements = this.entitlements
      .events()
      .filter(
        (event) =>
          event.tenantId === input.tenantId &&
          event.eventType === 'granted' &&
          event.authorityJournalId === originalLedgerReceipt.journalId &&
          expectedGrantIds.has(event.eventId),
      );
    const currentFulfillment = this.fulfillment.forOrder(input.tenantId, order.orderId);
    if (
      order.entitlementEvents.length !== expectedComponentCount ||
      order.fulfillment.length !== expectedComponentCount ||
      canonicalSet(currentEntitlements) !== canonicalSet(order.entitlementEvents) ||
      canonicalSet(currentFulfillment) !== canonicalSet(order.fulfillment)
    ) {
      throw new Error('REFUND_AUTHORITY_NOT_REHYDRATED');
    }
    const railInput = {
      tenantId: input.tenantId,
      processorAccountRef: input.processorAccountRef,
      money: { amountMinor: order.offer.amountMinor, currency: order.offer.currency },
      originalEffectRef,
      idempotencyKey: `${input.idempotencyKey}:rail`,
      synthetic: true,
    } as const;
    validatePaymentRailInput(railInput);
    const attempt = this.#refundAttempts.get(refundKey);
    const durableAttempt = await this.durableAttempts.load(
      input.tenantId,
      'refund',
      input.idempotencyKey,
    );
    let effect = durableAttempt?.effect ?? attempt?.effect;
    if (effect === undefined) {
      if (durableAttempt?.submitted === true) {
        const workItemId =
          durableAttempt.workItemId ??
          (await this.#openWorkItemFrom({
            tenantId: input.tenantId,
            workItemId: input.ids.workItemId,
            subjectRef: `paid-service-order:${order.orderId}`,
            ownerRef: input.ownerRef,
            reason: 'PARTIAL_COMMIT',
            responseDueAt: input.responseDueAt,
            occurredAt: input.occurredAt,
            correlationId: input.correlationId,
          }));
        if (durableAttempt.workItemId === undefined) {
          await this.durableAttempts.recordWorkItem({
            tenantId: input.tenantId,
            operation: 'refund',
            idempotencyKey: input.idempotencyKey,
            workItemId,
          });
        }
        this.#refundAttempts.set(refundKey, { hash: refundHash, workItemId });
        return { ...order, state: 'reconciliation_held', workItemId };
      }
      await this.durableAttempts.markSubmitted({
        tenantId: input.tenantId,
        operation: 'refund',
        idempotencyKey: input.idempotencyKey,
      });
      effect = await this.rail.refund(railInput);
    } else if (effect.outcome !== 'landed' || effect.receiptRef === undefined) {
      effect = await this.rail.reconcileEffect({
        tenantId: input.tenantId,
        effectRef: effect.effectRef,
        idempotencyKey: `${input.idempotencyKey}:reconcile`,
        synthetic: true,
      });
    }
    await this.durableAttempts.recordEffect({
      tenantId: input.tenantId,
      operation: 'refund',
      idempotencyKey: input.idempotencyKey,
      effect,
    });
    this.#refundAttempts.set(refundKey, {
      hash: refundHash,
      effect,
      ...(attempt?.workItemId === undefined ? {} : { workItemId: attempt.workItemId }),
    });
    if (effect.outcome !== 'landed' || effect.receiptRef === undefined) {
      const currentAttempt = this.#refundAttempts.get(refundKey);
      let workItemId = currentAttempt?.workItemId;
      if (workItemId === undefined) {
        workItemId = await this.#openWorkItemFrom({
          tenantId: input.tenantId,
          workItemId: input.ids.workItemId,
          subjectRef: `paid-service-order:${order.orderId}`,
          ownerRef: input.ownerRef,
          reason: effect.outcome === 'unknown' ? 'PAYMENT_UNKNOWN' : 'LANDED_WITHOUT_RECEIPT',
          responseDueAt: input.responseDueAt,
          occurredAt: input.occurredAt,
          correlationId: input.correlationId,
        });
        this.#refundAttempts.set(refundKey, { hash: refundHash, effect, workItemId });
        await this.durableAttempts.recordWorkItem({
          tenantId: input.tenantId,
          operation: 'refund',
          idempotencyKey: input.idempotencyKey,
          workItemId,
        });
      }
      return { ...order, state: 'reconciliation_held', workItemId };
    }
    const reversal = this.ledger.postBalancedSet({
      tenantId: input.tenantId,
      journalId: input.ids.refundJournalId,
      correlationId: input.correlationId,
      idempotencyKey: `${input.idempotencyKey}:ledger`,
      reversalOfJournalId: originalLedgerReceipt.journalId,
      processorEffectRef: effect.effectRef,
      externalReceiptRef: effect.receiptRef,
      lines: [
        {
          accountRef: 'cash',
          side: 'credit',
          amountMinor: order.offer.amountMinor,
          currency: order.offer.currency,
          sourceRef: originalEffectRef,
        },
        {
          accountRef: 'paid-service-liability',
          side: 'debit',
          amountMinor: order.offer.amountMinor,
          currency: order.offer.currency,
          sourceRef: originalEffectRef,
        },
      ],
    });
    const reversed = order.entitlementEvents.map((grant, index) =>
      this.entitlements.reverse({
        ...grant,
        eventId: `${order.orderId}:reverse:${index + 1}`,
        authorityJournalId: reversal.journalId,
        idempotencyKey: `${input.idempotencyKey}:entitlement:${index + 1}`,
        reversalOfEventId: grant.eventId,
      }),
    );
    const obligations = this.fulfillment.refund(input.tenantId, order.orderId);
    await this.events.publish({
      eventId: input.ids.refundEventId,
      tenantId: input.tenantId,
      type: 'paid-service.refunded',
      orderRef: order.orderId,
      journalRef: reversal.journalId,
      occurredAt: input.occurredAt,
      correlationId: input.correlationId,
      idempotencyKey: `${input.idempotencyKey}:event`,
      externalReceiptRef: effect.receiptRef,
    });
    const refunded: PaidServiceOrder = {
      ...order,
      state: 'refunded',
      ledgerReceipt: reversal,
      refundDecision: input.decision,
      entitlementEvents: reversed,
      fulfillment: obligations,
    };
    this.#orders.set(tupleKey(input.tenantId, input.purchaseKey), { ...stored, order: refunded });
    this.#refunds.set(refundKey, { hash: refundHash, order: refunded });
    await this.orderStore.save({
      tenantId: input.tenantId,
      purchaseKey: input.purchaseKey,
      requestHash: stored.hash,
      occurredAt: persisted?.occurredAt ?? input.occurredAt,
      refundKey: input.idempotencyKey,
      refundHash,
      order: refunded,
    });
    await this.durableAttempts.complete({
      tenantId: input.tenantId,
      operation: 'refund',
      idempotencyKey: input.idempotencyKey,
    });
    return refunded;
  }

  async #openWorkItem(input: PurchaseInput, reason: ReconciliationReason): Promise<string> {
    return this.#openWorkItemFrom({
      tenantId: input.tenantId,
      workItemId: input.ids.workItemId,
      subjectRef: `paid-service-order:${input.ids.orderId}`,
      ownerRef: input.ownerRef,
      reason,
      responseDueAt: input.responseDueAt,
      occurredAt: input.occurredAt,
      correlationId: input.correlationId,
    });
  }

  async #openWorkItemFrom(input: Parameters<PaidServiceWorkItemPort['open']>[0]): Promise<string> {
    const result = await this.workItems.open(input);
    if (result.workItemId.trim() === '') throw new Error('REAL_WORKITEM_REQUIRED');
    return result.workItemId;
  }

  #remember(key: string, hash: string, order: PaidServiceOrder): PaidServiceOrder {
    this.#orders.set(key, { hash, order });
    return order;
  }
}

const canonicalSet = (values: readonly unknown[]): string =>
  JSON.stringify(values.map((value) => JSON.stringify(value)).sort());
