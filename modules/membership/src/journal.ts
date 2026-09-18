import { createHash } from 'node:crypto';

import {
  MembershipError,
  type EntitlementCyclePort,
  type MembershipAccount,
  type MembershipLifecycleEvent,
  type MembershipStatus,
  type MembershipVintage,
} from './types.js';

interface OpenInput {
  readonly tenantId: string;
  readonly accountId: string;
  readonly memberRef: string;
  readonly vintageId: string;
  readonly offerRef: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly componentRefs: readonly string[];
  readonly authorityJournalId: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
}

interface StatusInput {
  readonly tenantId: string;
  readonly accountId: string;
  readonly eventId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly authorityJournalId: string;
}

interface WinbackInput extends StatusInput {
  readonly vintageId: string;
  readonly offerRef: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly componentRefs: readonly string[];
}

interface StoredAccount {
  readonly tenantId: string;
  readonly accountId: string;
  readonly memberRef: string;
  status: MembershipStatus;
  currentVintageId: string | null;
}

export class MembershipJournal {
  readonly #accounts = new Map<string, StoredAccount>();
  readonly #vintages: MembershipVintage[] = [];
  readonly #events: MembershipLifecycleEvent[] = [];
  readonly #commands = new Map<string, { hash: string; event: MembershipLifecycleEvent }>();
  readonly #eventIds = new Map<string, string>();

  public constructor(private readonly entitlements: EntitlementCyclePort) {}

  public open(input: OpenInput): MembershipAccount {
    this.#assertPrice(input.priceMinor, input.currency);
    const prior = this.#replay(input.tenantId, input.idempotencyKey, input);
    if (prior !== undefined) return this.account(input.tenantId, input.accountId);
    const key = this.#accountKey(input.tenantId, input.accountId);
    if (this.#accounts.has(key)) throw new MembershipError('ACCOUNT_EXISTS');
    this.#accounts.set(key, {
      tenantId: input.tenantId,
      accountId: input.accountId,
      memberRef: input.memberRef,
      status: 'active',
      currentVintageId: input.vintageId,
    });
    this.#vintages.push({
      tenantId: input.tenantId,
      vintageId: input.vintageId,
      accountId: input.accountId,
      offerRef: input.offerRef,
      priceMinor: input.priceMinor,
      currency: input.currency,
      openedAt: input.occurredAt,
      closedAt: null,
    });
    this.#append(
      {
        tenantId: input.tenantId,
        eventId: input.eventId,
        eventType: 'opened',
        accountId: input.accountId,
        vintageId: input.vintageId,
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.occurredAt,
      },
      input,
    );
    this.entitlements.grantForVintage({
      tenantId: input.tenantId,
      memberRef: input.memberRef,
      vintageId: input.vintageId,
      componentRefs: input.componentRefs,
      authorityJournalId: input.authorityJournalId,
    });
    return this.account(input.tenantId, input.accountId);
  }

  public pause(input: StatusInput): MembershipAccount {
    return this.#transition(input, 'paused', (account) => {
      if (account.status !== 'active') throw new MembershipError('PAUSE_REQUIRES_ACTIVE');
    });
  }

  public resume(input: StatusInput): MembershipAccount {
    return this.#transition(input, 'resumed', (account) => {
      if (account.status !== 'paused') throw new MembershipError('RESUME_REQUIRES_PAUSED');
    });
  }

  public cancel(input: StatusInput): MembershipAccount {
    const prior = this.#replay(input.tenantId, input.idempotencyKey, input);
    if (prior !== undefined) return this.account(input.tenantId, input.accountId);
    const account = this.#require(input.tenantId, input.accountId);
    if (account.status === 'cancelled' || account.currentVintageId === null) {
      throw new MembershipError('CANCEL_REQUIRES_OPEN');
    }
    const vintageId = account.currentVintageId;
    this.#closeVintage(input.tenantId, vintageId, input.occurredAt);
    this.entitlements.reverseForVintage({
      tenantId: input.tenantId,
      memberRef: account.memberRef,
      vintageId,
      authorityJournalId: input.authorityJournalId,
    });
    account.status = 'cancelled';
    account.currentVintageId = null;
    this.#append(
      {
        tenantId: input.tenantId,
        eventId: input.eventId,
        eventType: 'cancelled',
        accountId: input.accountId,
        vintageId,
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.occurredAt,
      },
      input,
    );
    return this.account(input.tenantId, input.accountId);
  }

  public winBack(input: WinbackInput): MembershipAccount {
    this.#assertPrice(input.priceMinor, input.currency);
    const prior = this.#replay(input.tenantId, input.idempotencyKey, input);
    if (prior !== undefined) return this.account(input.tenantId, input.accountId);
    const account = this.#require(input.tenantId, input.accountId);
    if (account.status !== 'cancelled') throw new MembershipError('WINBACK_REQUIRES_CANCELLED');
    this.#vintages.push({
      tenantId: input.tenantId,
      vintageId: input.vintageId,
      accountId: input.accountId,
      offerRef: input.offerRef,
      priceMinor: input.priceMinor,
      currency: input.currency,
      openedAt: input.occurredAt,
      closedAt: null,
    });
    account.status = 'active';
    account.currentVintageId = input.vintageId;
    this.#append(
      {
        tenantId: input.tenantId,
        eventId: input.eventId,
        eventType: 'winback',
        accountId: input.accountId,
        vintageId: input.vintageId,
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.occurredAt,
      },
      input,
    );
    this.entitlements.grantForVintage({
      tenantId: input.tenantId,
      memberRef: account.memberRef,
      vintageId: input.vintageId,
      componentRefs: input.componentRefs,
      authorityJournalId: input.authorityJournalId,
    });
    return this.account(input.tenantId, input.accountId);
  }

  public account(tenantId: string, accountId: string): MembershipAccount {
    const account = this.#require(tenantId, accountId);
    return {
      tenantId: account.tenantId,
      accountId: account.accountId,
      memberRef: account.memberRef,
      status: account.status,
      currentVintageId: account.currentVintageId,
    };
  }

  public vintages(tenantId: string, accountId: string): readonly MembershipVintage[] {
    this.#require(tenantId, accountId);
    return this.#vintages.filter(
      (vintage) => vintage.tenantId === tenantId && vintage.accountId === accountId,
    );
  }

  public events(tenantId: string, accountId: string): readonly MembershipLifecycleEvent[] {
    this.#require(tenantId, accountId);
    return this.#events.filter(
      (event) => event.tenantId === tenantId && event.accountId === accountId,
    );
  }

  #transition(
    input: StatusInput,
    eventType: 'paused' | 'resumed',
    assert: (account: StoredAccount) => void,
  ): MembershipAccount {
    const prior = this.#replay(input.tenantId, input.idempotencyKey, input);
    if (prior !== undefined) return this.account(input.tenantId, input.accountId);
    const account = this.#require(input.tenantId, input.accountId);
    assert(account);
    if (account.currentVintageId === null) throw new MembershipError('ACCOUNT_NOT_FOUND');
    account.status = eventType === 'paused' ? 'paused' : 'active';
    this.#append(
      {
        tenantId: input.tenantId,
        eventId: input.eventId,
        eventType,
        accountId: input.accountId,
        vintageId: account.currentVintageId,
        idempotencyKey: input.idempotencyKey,
        occurredAt: input.occurredAt,
      },
      input,
    );
    return this.account(input.tenantId, input.accountId);
  }

  #require(tenantId: string, accountId: string): StoredAccount {
    const account = this.#accounts.get(this.#accountKey(tenantId, accountId));
    if (account === undefined) throw new MembershipError('ACCOUNT_NOT_FOUND');
    return account;
  }

  #closeVintage(tenantId: string, vintageId: string, closedAt: string): void {
    const index = this.#vintages.findIndex(
      (vintage) => vintage.tenantId === tenantId && vintage.vintageId === vintageId,
    );
    const vintage = this.#vintages[index];
    if (vintage === undefined) throw new MembershipError('ACCOUNT_NOT_FOUND');
    this.#vintages[index] = { ...vintage, closedAt };
  }

  #replay(
    tenantId: string,
    idempotencyKey: string,
    payload: object,
  ): MembershipLifecycleEvent | undefined {
    const key = JSON.stringify([tenantId, idempotencyKey]);
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const prior = this.#commands.get(key);
    if (prior === undefined) return undefined;
    if (prior.hash !== hash) throw new MembershipError('IDEMPOTENCY_CONFLICT');
    return prior.event;
  }

  #append(event: MembershipLifecycleEvent, command: object): void {
    const key = JSON.stringify([event.tenantId, event.idempotencyKey]);
    const commandHash = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    const eventHash = createHash('sha256').update(JSON.stringify(event)).digest('hex');
    const eventKey = JSON.stringify([event.tenantId, event.eventId]);
    const claimedBy = this.#eventIds.get(eventKey);
    if (claimedBy !== undefined && claimedBy !== eventHash) {
      throw new MembershipError('EVENT_ID_CONFLICT');
    }
    this.#events.push(event);
    this.#commands.set(key, { hash: commandHash, event });
    this.#eventIds.set(eventKey, eventHash);
  }

  #accountKey(tenantId: string, accountId: string): string {
    return JSON.stringify([tenantId, accountId]);
  }

  #assertPrice(priceMinor: number, currency: string): void {
    if (!Number.isInteger(priceMinor) || priceMinor < 0 || currency.length !== 3) {
      throw new MembershipError('PRICE_INVALID');
    }
  }
}
