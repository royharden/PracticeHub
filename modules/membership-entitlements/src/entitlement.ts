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

export interface EntitlementLedgerAuthority {
  journal(
    tenantId: string,
    journalId: string,
  ): { readonly reversalOfJournalId?: string } | undefined;
}

export class EntitlementError extends Error {
  public constructor(
    public readonly code:
      | 'IDEMPOTENCY_CONFLICT'
      | 'EVENT_ID_CONFLICT'
      | 'AUTHORITY_NOT_FOUND'
      | 'AUTHORITY_MISMATCH'
      | 'ORIGINAL_NOT_FOUND'
      | 'ALREADY_REVERSED',
  ) {
    super(code);
    this.name = 'EntitlementError';
  }
}

export class EntitlementJournal {
  readonly #events: EntitlementEvent[] = [];
  readonly #keys = new Map<string, { hash: string; event: EntitlementEvent }>();
  readonly #eventIds = new Map<string, string>();

  public constructor(private readonly authority: EntitlementLedgerAuthority) {}

  public grant(input: Omit<EntitlementEvent, 'eventType' | 'reversalOfEventId'>): EntitlementEvent {
    const authority = this.authority.journal(input.tenantId, input.authorityJournalId);
    if (authority === undefined) throw new EntitlementError('AUTHORITY_NOT_FOUND');
    if (authority.reversalOfJournalId !== undefined)
      throw new EntitlementError('AUTHORITY_MISMATCH');
    return this.#append({ ...input, eventType: 'granted' });
  }

  public reverse(
    input: Omit<EntitlementEvent, 'eventType'> & { readonly reversalOfEventId: string },
  ): EntitlementEvent {
    const candidate: EntitlementEvent = { ...input, eventType: 'reversed' };
    const prior = this.#prior(candidate);
    if (prior !== undefined) return prior;
    const original = this.#events.find(
      (event) => event.tenantId === input.tenantId && event.eventId === input.reversalOfEventId,
    );
    if (original === undefined || original.eventType !== 'granted') {
      throw new EntitlementError('ORIGINAL_NOT_FOUND');
    }
    if (
      original.memberRef !== input.memberRef ||
      original.componentRef !== input.componentRef ||
      original.entitlementKind !== input.entitlementKind
    ) {
      throw new EntitlementError('ORIGINAL_NOT_FOUND');
    }
    const authority = this.authority.journal(input.tenantId, input.authorityJournalId);
    if (authority === undefined) throw new EntitlementError('AUTHORITY_NOT_FOUND');
    if (authority.reversalOfJournalId !== original.authorityJournalId)
      throw new EntitlementError('AUTHORITY_MISMATCH');
    if (
      this.#events.some(
        (event) =>
          event.tenantId === input.tenantId && event.reversalOfEventId === original.eventId,
      )
    ) {
      throw new EntitlementError('ALREADY_REVERSED');
    }
    return this.#append(candidate);
  }

  #prior(event: EntitlementEvent): EntitlementEvent | undefined {
    const key = JSON.stringify([event.tenantId, event.idempotencyKey]);
    const hash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    const prior = this.#keys.get(key);
    if (prior === undefined) return undefined;
    if (prior.hash !== hash) throw new EntitlementError('IDEMPOTENCY_CONFLICT');
    return prior.event;
  }

  #append(event: EntitlementEvent): EntitlementEvent {
    const key = JSON.stringify([event.tenantId, event.idempotencyKey]);
    const hash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    const prior = this.#keys.get(key);
    if (prior !== undefined) {
      if (prior.hash !== hash) throw new EntitlementError('IDEMPOTENCY_CONFLICT');
      return prior.event;
    }
    const eventKey = JSON.stringify([event.tenantId, event.eventId]);
    const claimedBy = this.#eventIds.get(eventKey);
    if (claimedBy !== undefined && claimedBy !== hash)
      throw new EntitlementError('EVENT_ID_CONFLICT');
    this.#events.push(event);
    this.#keys.set(key, { hash, event });
    this.#eventIds.set(eventKey, hash);
    return event;
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

  public consume(): ConsumeResult {
    return { supported: false, code: 'CONSUME_DEFERRED_WP053' };
  }

  public events(): readonly EntitlementEvent[] {
    return [...this.#events];
  }
}
