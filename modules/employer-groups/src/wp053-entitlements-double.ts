import { createHash } from 'node:crypto';

export type EntitlementEventType = 'granted' | 'reversed';

export interface EntitlementEvent {
  readonly tenantId: string;
  readonly eventId: string;
  readonly eventType: EntitlementEventType;
  readonly memberRef: string;
  readonly componentRef: string;
  readonly entitlementKind: string;
  readonly authorityJournalId: string;
  readonly idempotencyKey: string;
  readonly reversalOfEventId?: string;
}

export type ConsumeResult = { readonly supported: false; readonly code: 'CONSUME_DEFERRED_WP053' };

/** Owned WP-053 double. Does not import or write membership-entitlements. */
export class Wp053EntitlementsDouble {
  readonly #events: EntitlementEvent[] = [];
  readonly #keys = new Map<string, string>();

  public grant(input: Omit<EntitlementEvent, 'eventType' | 'reversalOfEventId'>): EntitlementEvent {
    const event: EntitlementEvent = { ...input, eventType: 'granted' };
    return this.#append(event);
  }

  public reverse(
    input: Omit<EntitlementEvent, 'eventType'> & { readonly reversalOfEventId: string },
  ): EntitlementEvent {
    return this.#append({ ...input, eventType: 'reversed' });
  }

  public consume(): ConsumeResult {
    return { supported: false, code: 'CONSUME_DEFERRED_WP053' };
  }

  public check(tenantId: string, memberRef: string, componentRef: string): boolean {
    const relevant = this.#events.filter(
      (event) =>
        event.tenantId === tenantId &&
        event.memberRef === memberRef &&
        event.componentRef === componentRef,
    );
    return (
      relevant.filter((event) => event.eventType === 'granted').length >
      relevant.filter((event) => event.eventType === 'reversed').length
    );
  }

  #append(event: EntitlementEvent): EntitlementEvent {
    const key = JSON.stringify([event.tenantId, event.idempotencyKey]);
    const hash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    const prior = this.#keys.get(key);
    if (prior !== undefined && prior !== hash) {
      throw new Error('IDEMPOTENCY_CONFLICT');
    }
    if (prior === hash) {
      return event;
    }
    this.#keys.set(key, hash);
    this.#events.push(event);
    return event;
  }
}
