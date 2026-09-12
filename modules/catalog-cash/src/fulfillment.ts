export type ThinFulfillmentState =
  'paid' | 'reconciliation_held' | 'identity_held' | 'unmapped' | 'refunded';

export interface FulfillmentObligation {
  readonly tenantId: string;
  readonly obligationId: string;
  readonly orderRef: string;
  readonly offerVersionRef: string;
  readonly componentRef: string;
  readonly ownerRole: string;
  readonly state: ThinFulfillmentState;
  readonly dueAt?: string;
  readonly refundableState?: string;
}

export class FulfillmentStore {
  readonly #items = new Map<string, FulfillmentObligation>();

  public createPaid(obligation: FulfillmentObligation): FulfillmentObligation {
    const key = JSON.stringify([obligation.tenantId, obligation.obligationId]);
    const prior = this.#items.get(key);
    if (prior !== undefined) {
      if (JSON.stringify(prior) !== JSON.stringify(obligation))
        throw new Error('FULFILLMENT_IDEMPOTENCY_CONFLICT');
      return prior;
    }
    if (obligation.ownerRole === '') throw new Error('FULFILLMENT_OWNER_REQUIRED');
    this.#items.set(key, obligation);
    return obligation;
  }

  public refund(tenantId: string, orderRef: string): readonly FulfillmentObligation[] {
    const changed: FulfillmentObligation[] = [];
    for (const [key, item] of this.#items) {
      if (item.tenantId === tenantId && item.orderRef === orderRef) {
        const refunded = { ...item, state: 'refunded' as const };
        this.#items.set(key, refunded);
        changed.push(refunded);
      }
    }
    return changed;
  }

  public forOrder(tenantId: string, orderRef: string): readonly FulfillmentObligation[] {
    return [...this.#items.values()].filter(
      (item) => item.tenantId === tenantId && item.orderRef === orderRef,
    );
  }

  public getFulfillmentStatus(
    tenantId: string,
    orderRef: string,
  ): {
    readonly orderRef: string;
    readonly aggregateState: ThinFulfillmentState | 'mixed' | 'empty';
    readonly componentStates: readonly {
      readonly componentRef: string;
      readonly state: ThinFulfillmentState;
    }[];
  } {
    const items = this.forOrder(tenantId, orderRef);
    const states = new Set(items.map((item) => item.state));
    const first = items[0];
    return {
      orderRef,
      aggregateState: first === undefined ? 'empty' : states.size === 1 ? first.state : 'mixed',
      componentStates: items.map((item) => ({
        componentRef: item.componentRef,
        state: item.state,
      })),
    };
  }
}
