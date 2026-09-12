import { EntitlementJournal } from '@practicehub/membership-entitlements';
import {
  BalancedLedger,
  type PaymentRailInput,
  type PaymentRailPort,
  type RailEffectObservation,
} from '@practicehub/payments-ledger';
import { describe, expect, it } from 'vitest';

import { Catalog, type CatalogOfferSnapshot } from './catalog.js';
import { InMemoryPaidServiceAttemptStore } from './attempt-store.js';
import { InMemoryPaidServiceOrderStore } from './order-store.js';
import type { PaidServiceEvent, PaidServiceEventPort } from './event-port.js';
import { FulfillmentStore } from './fulfillment.js';
import { PaidServiceLoop, type LoopIds, type PurchaseInput } from './paid-service-loop.js';
import type { PaidServiceWorkItemInput, PaidServiceWorkItemPort } from './workitem-port.js';

const now = '2026-04-01T12:00:00Z';
const ids: LoopIds = {
  orderId: 'order-1',
  paymentJournalId: 'journal-1',
  paymentEventId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  refundJournalId: 'journal-r1',
  refundEventId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  workItemId: 'work-1',
};

const offer: CatalogOfferSnapshot = {
  tenantId: 'northwind-synthetic',
  catalogVersionRef: 'catalog-v1',
  offerVersionRef: 'offer-v1',
  opaqueProcessorSkuRef: 'sku-opaque-v1',
  amountMinor: 5000,
  currency: 'USD',
  expiresAt: '2027-01-01T00:00:00Z',
  cancellationPolicyRef: 'policy-cancel-v1',
  refundPolicyRef: 'policy-refund-v1',
  synthetic: true,
  componentLines: [
    {
      componentRef: 'component-a',
      quantity: 1,
      ownerRole: 'guide',
      entitlementKind: 'single-service',
      fulfillmentKind: 'service',
    },
    {
      componentRef: 'component-b',
      quantity: 1,
      ownerRole: 'clinician',
      entitlementKind: 'single-service',
      fulfillmentKind: 'service',
    },
  ],
};

const input: PurchaseInput = {
  tenantId: offer.tenantId,
  buyerRef: 'buyer-opaque-1',
  memberRef: 'member-opaque-1',
  offerRef: offer.offerVersionRef,
  processorAccountRef: 'acct-synthetic-1',
  identityEligibility: 'eligible',
  capabilityAllowed: true,
  correlationId: 'corr:paid-service:1',
  idempotencyKey: 'purchase-key-1',
  occurredAt: now,
  responseDueAt: '2026-04-01T13:00:00Z',
  ownerRef: 'synthetic-staff:finance-1',
  ids,
};
const decision = {
  reasonCode: 'customer-approved-cancellation',
  evidenceRef: 'evidence-ref-1',
  approverRef: 'synthetic-staff:finance-1',
  recipientRef: 'buyer-opaque-1',
} as const;

class RailDouble implements PaymentRailPort {
  public readonly creates: PaymentRailInput[] = [];
  public readonly refunds: PaymentRailInput[] = [];
  public readonly reconciles: string[] = [];
  public constructor(
    private readonly createResult: RailEffectObservation = {
      effectRef: 'pay-effect-1',
      outcome: 'landed',
      receiptRef: 'receipt-1',
      observedAt: now,
    },
    private readonly refundResult: RailEffectObservation = {
      effectRef: 'refund-effect-1',
      outcome: 'landed',
      receiptRef: 'refund-receipt-1',
      observedAt: now,
    },
    private readonly reconcileResult: RailEffectObservation = createResult,
  ) {}
  public createPaymentIntent(value: PaymentRailInput): Promise<RailEffectObservation> {
    this.creates.push(value);
    return Promise.resolve(this.createResult);
  }
  public refund(value: PaymentRailInput): Promise<RailEffectObservation> {
    this.refunds.push(value);
    return Promise.resolve(this.refundResult);
  }
  public reconcileEffect(input: { readonly effectRef: string }): Promise<RailEffectObservation> {
    this.reconciles.push(input.effectRef);
    return Promise.resolve(this.reconcileResult);
  }
}

class ThrowingRailDouble extends RailDouble {
  public override createPaymentIntent(value: PaymentRailInput): Promise<RailEffectObservation> {
    this.creates.push(value);
    return Promise.reject(new Error('RAIL_TRANSPORT_INTERRUPTED'));
  }
}

class WorkItemsDouble implements PaidServiceWorkItemPort {
  public readonly opened: PaidServiceWorkItemInput[] = [];
  public constructor(private readonly returnedId = 'work-1') {}
  public open(value: PaidServiceWorkItemInput): Promise<{ readonly workItemId: string }> {
    this.opened.push(value);
    return Promise.resolve({ workItemId: this.returnedId });
  }
}

class EventsDouble implements PaidServiceEventPort {
  public readonly published: PaidServiceEvent[] = [];
  readonly #seen = new Set<string>();
  public constructor(private failNext = false) {}
  public publish(event: PaidServiceEvent): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('EVENT_PUBLISH_FAILURE'));
    }
    if (this.#seen.has(event.idempotencyKey)) return Promise.resolve();
    this.#seen.add(event.idempotencyKey);
    this.published.push(event);
    return Promise.resolve();
  }
}

function harness(
  rail = new RailDouble(),
  workItems = new WorkItemsDouble(),
  events = new EventsDouble(),
  attempts = new InMemoryPaidServiceAttemptStore(),
  catalogOffer = offer,
  orderStore = new InMemoryPaidServiceOrderStore(),
  authorities?: {
    readonly ledger: BalancedLedger;
    readonly entitlements: EntitlementJournal;
    readonly fulfillment: FulfillmentStore;
  },
) {
  const catalog = new Catalog();
  catalog.add(catalogOffer);
  const ledger = authorities?.ledger ?? new BalancedLedger();
  const entitlements = authorities?.entitlements ?? new EntitlementJournal(ledger);
  const fulfillment = authorities?.fulfillment ?? new FulfillmentStore();
  return {
    rail,
    workItems,
    ledger,
    entitlements,
    fulfillment,
    events,
    loop: new PaidServiceLoop(
      catalog,
      rail,
      ledger,
      entitlements,
      fulfillment,
      workItems,
      events,
      attempts,
      orderStore,
    ),
  };
}

describe('PaidServiceLoop', () => {
  it('HAPPY reconciles one rail effect into one balanced journal and per-component authority', async () => {
    const h = harness();
    const order = await h.loop.purchase(input);
    expect(order.state).toBe('reconciled');
    expect(order.fulfillment).toHaveLength(2);
    expect(order.entitlementEvents).toHaveLength(2);
    expect(h.ledger.journals()).toHaveLength(1);
    expect(h.rail.creates).toHaveLength(1);
    expect(h.events.published.map((event) => event.type)).toEqual(['payment.reconciled']);
  });

  it('BOUNDARY keeps the accepted quote frozen when the caller mutates its alias during rail await', async () => {
    const mutableOffer = structuredClone(offer) as CatalogOfferSnapshot;
    const rail = new (class extends RailDouble {
      public override createPaymentIntent(value: PaymentRailInput): Promise<RailEffectObservation> {
        (mutableOffer as { amountMinor: number }).amountMinor = 700;
        return super.createPaymentIntent(value);
      }
    })();
    const h = harness(
      rail,
      new WorkItemsDouble(),
      new EventsDouble(),
      new InMemoryPaidServiceAttemptStore(),
      mutableOffer,
    );
    const order = await h.loop.purchase(input);
    expect(rail.creates[0]?.money.amountMinor).toBe(offer.amountMinor);
    expect(order.offer.amountMinor).toBe(offer.amountMinor);
    expect(h.ledger.journals()[0]?.lines.map((line) => line.amountMinor)).toEqual([
      offer.amountMinor,
      offer.amountMinor,
    ]);
  });

  it('BOUNDARY returns the original purchase for an identical key and rejects changed input', async () => {
    const h = harness();
    expect(await h.loop.purchase(input)).toBe(await h.loop.purchase(input));
    expect(h.rail.creates).toHaveLength(1);
    await expect(h.loop.purchase({ ...input, buyerRef: 'buyer-opaque-2' })).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT',
    );
    expect(h.rail.creates).toHaveLength(1);
  });

  it.each([
    [
      'unknown',
      { effectRef: 'pay-effect-1', outcome: 'unknown', observedAt: now },
      'PAYMENT_UNKNOWN',
    ],
    [
      'webhook gap',
      { effectRef: 'pay-effect-1', outcome: 'landed', observedAt: now },
      'LANDED_WITHOUT_RECEIPT',
    ],
  ] as const)(
    'RECOVERY holds %s and creates a real owned reconciliation item',
    async (_name, outcome, reason) => {
      const h = harness(new RailDouble(outcome));
      const order = await h.loop.purchase(input);
      expect(order.state).toBe('reconciliation_held');
      expect(h.workItems.opened[0]?.reason).toBe(reason);
      expect(order.workItemId).toBe('work-1');
      expect(h.ledger.journals()).toHaveLength(0);
    },
  );

  it.each([
    ['conflict_quarantined', 'IDENTITY_CONFLICT'],
    ['duplicate_held', 'DUPLICATE_HELD'],
  ] as const)(
    'FAILURE blocks %s before the rail and opens owned WP-022 work',
    async (identityEligibility, reason) => {
      const h = harness();
      const order = await h.loop.purchase({ ...input, identityEligibility });
      expect(order.state).toBe('identity_held');
      expect(h.rail.creates).toHaveLength(0);
      expect(h.workItems.opened[0]?.reason).toBe(reason);
    },
  );

  it('FAILURE refuses descriptor-only reconciliation with no real WorkItem id', async () => {
    const h = harness(
      new RailDouble({ effectRef: 'unknown-1', outcome: 'unknown', observedAt: now }),
      new WorkItemsDouble(''),
    );
    await expect(h.loop.purchase(input)).rejects.toThrow('REAL_WORKITEM_REQUIRED');
  });

  it('HAPPY reconciles a refund with one exact reversal, entitlement reversal, fulfillment update and event', async () => {
    const h = harness();
    await h.loop.purchase(input);
    const refunded = await h.loop.refund({
      purchaseKey: input.idempotencyKey,
      tenantId: input.tenantId,
      occurredAt: now,
      correlationId: input.correlationId,
      idempotencyKey: 'refund-key-1',
      processorAccountRef: input.processorAccountRef,
      capabilityAllowed: true,
      responseDueAt: input.responseDueAt,
      ownerRef: input.ownerRef,
      decision,
      ids,
    });
    expect(refunded.state).toBe('refunded');
    expect(refunded.fulfillment.every((item) => item.state === 'refunded')).toBe(true);
    expect(h.ledger.journals()).toHaveLength(2);
    expect(h.entitlements.check(input.tenantId, input.memberRef, 'component-a#1')).toBe(false);
    expect(h.events.published.map((event) => event.type)).toEqual([
      'payment.reconciled',
      'paid-service.refunded',
    ]);
    const retried = await h.loop.refund({
      purchaseKey: input.idempotencyKey,
      tenantId: input.tenantId,
      occurredAt: now,
      correlationId: input.correlationId,
      idempotencyKey: 'refund-key-1',
      processorAccountRef: input.processorAccountRef,
      capabilityAllowed: true,
      responseDueAt: input.responseDueAt,
      ownerRef: input.ownerRef,
      decision,
      ids,
    });
    expect(retried).toBe(refunded);
    expect(h.rail.refunds).toHaveLength(1);
  });

  it('BOUNDARY ignores unrelated same-tenant grant and fulfillment authority during refund preflight', async () => {
    const h = harness();
    const purchased = await h.loop.purchase(input);
    h.entitlements.grant({
      tenantId: input.tenantId,
      eventId: 'unrelated-grant',
      memberRef: 'unrelated-member',
      componentRef: 'unrelated-component#1',
      entitlementKind: 'once',
      authorityJournalId: purchased.ledgerReceipt?.journalId ?? '',
      idempotencyKey: 'unrelated-grant-key',
    });
    h.fulfillment.createPaid({
      tenantId: input.tenantId,
      obligationId: 'unrelated-obligation',
      orderRef: 'unrelated-order',
      offerVersionRef: offer.offerVersionRef,
      componentRef: 'unrelated-component#1',
      ownerRole: 'guide',
      state: 'paid',
    });
    const refunded = await h.loop.refund({
      purchaseKey: input.idempotencyKey,
      tenantId: input.tenantId,
      occurredAt: now,
      correlationId: input.correlationId,
      idempotencyKey: 'refund-with-unrelated-authority',
      processorAccountRef: input.processorAccountRef,
      capabilityAllowed: true,
      responseDueAt: input.responseDueAt,
      ownerRef: input.ownerRef,
      decision,
      ids,
    });
    expect(refunded.state).toBe('refunded');
    expect(h.rail.refunds).toHaveLength(1);
  });

  it('FAILURE does not claim six-stage or lifecycle completeness from thin paid obligations', async () => {
    const order = await harness().loop.purchase(input);
    const requiredStages = ['paid', 'scheduled', 'performed', 'resulted', 'reviewed', 'delivered'];
    expect(new Set(order.fulfillment.map((item) => item.state))).not.toEqual(
      new Set(requiredStages),
    );
    expect(
      order.fulfillment.some(
        (item) => item.dueAt === undefined || item.refundableState === undefined,
      ),
    ).toBe(true);
  });

  it('FAILURE denies the Riverbend opposite-state tenant before every mutation or rail call', async () => {
    const h = harness();
    await expect(
      h.loop.purchase({ ...input, tenantId: 'riverbend-synthetic', capabilityAllowed: false }),
    ).rejects.toThrow('CAPABILITY_DENIED');
    expect(h.rail.creates).toHaveLength(0);
    expect(h.ledger.journals()).toHaveLength(0);
    expect(h.events.published).toHaveLength(0);
  });

  it('RECOVERY serializes concurrent same-key purchases before the rail', async () => {
    const h = harness();
    const [left, right] = await Promise.all([
      h.loop.purchase(input),
      h.loop.purchase({ ...input }),
    ]);
    expect(left).toBe(right);
    expect(h.rail.creates).toHaveLength(1);
  });

  it('RECOVERY resumes after event publication failure without a second rail effect or duplicate grants', async () => {
    const events = new EventsDouble(true);
    const h = harness(new RailDouble(), new WorkItemsDouble(), events);
    await expect(h.loop.purchase(input)).rejects.toThrow('EVENT_PUBLISH_FAILURE');
    const recovered = await h.loop.purchase({ ...input, capabilityAllowed: true });
    expect(recovered.state).toBe('reconciled');
    expect(h.rail.creates).toHaveLength(1);
    expect(h.ledger.journals()).toHaveLength(1);
    expect(h.entitlements.events()).toHaveLength(2);
    expect(h.fulfillment.forOrder(input.tenantId, input.ids.orderId)).toHaveLength(2);
    expect(events.published).toHaveLength(1);
  });

  it('RECOVERY fails closed after a submitted rail call loses its result across coordinator restart', async () => {
    const attempts = new InMemoryPaidServiceAttemptStore();
    const interrupted = harness(
      new ThrowingRailDouble(),
      new WorkItemsDouble(),
      new EventsDouble(),
      attempts,
    );
    await expect(interrupted.loop.purchase(input)).rejects.toThrow('RAIL_TRANSPORT_INTERRUPTED');
    const retryRail = new RailDouble();
    const retry = harness(retryRail, new WorkItemsDouble(), new EventsDouble(), attempts);
    const held = await retry.loop.purchase(input);
    expect(held.state).toBe('reconciliation_held');
    expect(held.workItemId).toBe('work-1');
    expect(retry.workItems.opened[0]?.reason).toBe('PARTIAL_COMMIT');
    expect(retryRail.creates).toHaveLength(0);
  });

  it('RECOVERY pins the exact catalog authority across a durable retry', async () => {
    const attempts = new InMemoryPaidServiceAttemptStore();
    const first = harness(
      new RailDouble(),
      new WorkItemsDouble(),
      new EventsDouble(true),
      attempts,
    );
    await expect(first.loop.purchase(input)).rejects.toThrow('EVENT_PUBLISH_FAILURE');
    const retryRail = new RailDouble();
    const changedCatalog = harness(retryRail, new WorkItemsDouble(), new EventsDouble(), attempts, {
      ...offer,
      amountMinor: 7000,
    });
    await expect(changedCatalog.loop.purchase(input)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect(retryRail.creates).toHaveLength(0);
    expect(changedCatalog.ledger.journals()).toHaveLength(0);
  });

  it('RECOVERY opens owned work for an unknown refund, then reconciles by lookup without a second refund effect', async () => {
    const rail = new RailDouble(
      { effectRef: 'pay-effect-1', outcome: 'landed', receiptRef: 'receipt-1', observedAt: now },
      { effectRef: 'refund-effect-1', outcome: 'unknown', observedAt: now },
      {
        effectRef: 'refund-effect-1',
        outcome: 'landed',
        receiptRef: 'refund-receipt-1',
        observedAt: now,
      },
    );
    const h = harness(rail);
    await h.loop.purchase(input);
    const refundInput = {
      purchaseKey: input.idempotencyKey,
      tenantId: input.tenantId,
      occurredAt: now,
      correlationId: input.correlationId,
      idempotencyKey: 'refund-unknown-1',
      processorAccountRef: input.processorAccountRef,
      capabilityAllowed: true,
      responseDueAt: input.responseDueAt,
      ownerRef: input.ownerRef,
      decision,
      ids,
    };
    const held = await h.loop.refund(refundInput);
    expect(held.state).toBe('reconciliation_held');
    expect(h.workItems.opened[0]?.reason).toBe('PAYMENT_UNKNOWN');
    const recovered = await h.loop.refund(refundInput);
    expect(recovered.state).toBe('refunded');
    expect(rail.refunds).toHaveLength(1);
    expect(rail.reconciles).toEqual(['refund-effect-1']);
  });

  it('FAILURE reserves refund authority per original purchase before any competing external effect', async () => {
    const h = harness();
    await h.loop.purchase(input);
    const first = {
      purchaseKey: input.idempotencyKey,
      tenantId: input.tenantId,
      occurredAt: now,
      correlationId: input.correlationId,
      idempotencyKey: 'refund-key-a',
      processorAccountRef: input.processorAccountRef,
      capabilityAllowed: true,
      responseDueAt: input.responseDueAt,
      ownerRef: input.ownerRef,
      decision,
      ids,
    };
    const second = {
      ...first,
      idempotencyKey: 'refund-key-b',
      ids: { ...ids, refundJournalId: 'journal-r2', refundEventId: '01ARZ3NDEKTSV4RRFFQ69G5FAX' },
    };
    const outcomes = await Promise.allSettled([h.loop.refund(first), h.loop.refund(second)]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'rejected']);
    expect(outcomes[1]).toMatchObject({
      status: 'rejected',
      reason: new Error('REFUND_ALREADY_RESERVED'),
    });
    expect(h.rail.refunds).toHaveLength(1);
  });

  it('FAILURE requires authoritative order rehydration after restart before refund submission', async () => {
    const h = harness();
    await expect(
      h.loop.refund({
        purchaseKey: input.idempotencyKey,
        tenantId: input.tenantId,
        occurredAt: now,
        correlationId: input.correlationId,
        idempotencyKey: 'refund-after-restart',
        processorAccountRef: input.processorAccountRef,
        capabilityAllowed: true,
        responseDueAt: input.responseDueAt,
        ownerRef: input.ownerRef,
        decision,
        ids,
      }),
    ).rejects.toThrow('REFUND_REQUIRES_RECONCILED_PURCHASE');
    expect(h.rail.refunds).toHaveLength(0);
  });

  it('RECOVERY rehydrates a completed order before refund in a fresh coordinator', async () => {
    const attempts = new InMemoryPaidServiceAttemptStore();
    const orderStore = new InMemoryPaidServiceOrderStore();
    const original = harness(
      new RailDouble(),
      new WorkItemsDouble(),
      new EventsDouble(),
      attempts,
      offer,
      orderStore,
    );
    await original.loop.purchase(input);
    const restartedRail = new RailDouble();
    const restarted = harness(
      restartedRail,
      new WorkItemsDouble(),
      new EventsDouble(),
      attempts,
      offer,
      orderStore,
      {
        ledger: original.ledger,
        entitlements: original.entitlements,
        fulfillment: original.fulfillment,
      },
    );
    const refundInput = {
      purchaseKey: input.idempotencyKey,
      tenantId: input.tenantId,
      occurredAt: now,
      correlationId: input.correlationId,
      idempotencyKey: 'refund-after-rehydration',
      processorAccountRef: input.processorAccountRef,
      capabilityAllowed: true,
      responseDueAt: input.responseDueAt,
      ownerRef: input.ownerRef,
      decision,
      ids,
    };
    const refunded = await restarted.loop.refund(refundInput);
    expect(refunded.state).toBe('refunded');
    expect(restartedRail.refunds).toHaveLength(1);
    const finalRail = new RailDouble();
    const finalRestart = harness(
      finalRail,
      new WorkItemsDouble(),
      new EventsDouble(),
      attempts,
      offer,
      orderStore,
      {
        ledger: original.ledger,
        entitlements: original.entitlements,
        fulfillment: original.fulfillment,
      },
    );
    expect(await finalRestart.loop.refund(refundInput)).toEqual(refunded);
    expect(finalRail.refunds).toHaveLength(0);
    await expect(
      finalRestart.loop.refund({ ...refundInput, idempotencyKey: 'different-refund-key' }),
    ).rejects.toThrow('REFUND_ALREADY_RESERVED');
  });

  it('FAILURE refuses a persisted-order refund before rail submission when ledger authority is absent', async () => {
    const attempts = new InMemoryPaidServiceAttemptStore();
    const orderStore = new InMemoryPaidServiceOrderStore();
    const original = harness(
      new RailDouble(),
      new WorkItemsDouble(),
      new EventsDouble(),
      attempts,
      offer,
      orderStore,
    );
    await original.loop.purchase(input);
    const restartedRail = new RailDouble();
    const restarted = harness(
      restartedRail,
      new WorkItemsDouble(),
      new EventsDouble(),
      attempts,
      offer,
      orderStore,
    );
    await expect(
      restarted.loop.refund({
        purchaseKey: input.idempotencyKey,
        tenantId: input.tenantId,
        occurredAt: now,
        correlationId: input.correlationId,
        idempotencyKey: 'refund-without-ledger-authority',
        processorAccountRef: input.processorAccountRef,
        capabilityAllowed: true,
        responseDueAt: input.responseDueAt,
        ownerRef: input.ownerRef,
        decision,
        ids,
      }),
    ).rejects.toThrow('REFUND_AUTHORITY_NOT_REHYDRATED');
    expect(restartedRail.refunds).toHaveLength(0);
  });

  it('FAILURE refuses before rail when ledger is restored but entitlement or fulfillment authority is absent', async () => {
    const attempts = new InMemoryPaidServiceAttemptStore();
    const orderStore = new InMemoryPaidServiceOrderStore();
    const original = harness(
      new RailDouble(),
      new WorkItemsDouble(),
      new EventsDouble(),
      attempts,
      offer,
      orderStore,
    );
    await original.loop.purchase(input);
    const restartedRail = new RailDouble();
    const restarted = harness(
      restartedRail,
      new WorkItemsDouble(),
      new EventsDouble(),
      attempts,
      offer,
      orderStore,
      {
        ledger: original.ledger,
        entitlements: new EntitlementJournal(original.ledger),
        fulfillment: new FulfillmentStore(),
      },
    );
    await expect(
      restarted.loop.refund({
        purchaseKey: input.idempotencyKey,
        tenantId: input.tenantId,
        occurredAt: now,
        correlationId: input.correlationId,
        idempotencyKey: 'refund-without-derived-authority',
        processorAccountRef: input.processorAccountRef,
        capabilityAllowed: true,
        responseDueAt: input.responseDueAt,
        ownerRef: input.ownerRef,
        decision,
        ids,
      }),
    ).rejects.toThrow('REFUND_AUTHORITY_NOT_REHYDRATED');
    expect(restartedRail.refunds).toHaveLength(0);
  });
});
