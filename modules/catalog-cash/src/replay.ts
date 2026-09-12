import { createHash } from 'node:crypto';

import type { EntitlementEvent, EntitlementJournal } from '@practicehub/membership-entitlements';
import type { BalancedLedger, LedgerPostInput } from '@practicehub/payments-ledger';

import type { FulfillmentObligation, FulfillmentStore } from './fulfillment.js';
import type { PaidServiceOrder } from './paid-service-loop.js';

export interface PaidServiceReplayTuple {
  readonly correlationId: string;
  readonly order: Omit<PaidServiceOrder, 'entitlementEvents' | 'fulfillment'>;
  readonly journals: readonly LedgerPostInput[];
  readonly entitlementEvents: readonly EntitlementEvent[];
  readonly fulfillment: readonly FulfillmentObligation[];
}

export interface PaidServiceReplayResult {
  readonly rebuilt: PaidServiceReplayTuple;
  readonly matchesExpected: boolean;
}

/**
 * Rebuild the paid-service read tuple from each app-owned authority. Outbox or inbox state is
 * deliberately not an input and can never substitute for ledger or entitlement evidence.
 */
export function replayPaidServiceLoop(input: {
  readonly correlationId: string;
  readonly order: PaidServiceOrder;
  readonly ledger: BalancedLedger;
  readonly entitlements: EntitlementJournal;
  readonly fulfillment: FulfillmentStore;
  readonly expected?: PaidServiceReplayTuple;
}): PaidServiceReplayResult {
  const {
    entitlementEvents: _derivedEntitlements,
    fulfillment: _derivedFulfillment,
    ...order
  } = input.order;
  void _derivedEntitlements;
  void _derivedFulfillment;
  const currentJournal =
    order.ledgerReceipt === undefined
      ? undefined
      : input.ledger.journal(order.tenantId, order.ledgerReceipt.journalId);
  if (
    (order.state === 'reconciled' || order.state === 'refunded') &&
    (currentJournal === undefined || currentJournal.correlationId !== input.correlationId)
  ) {
    throw new Error('REPLAY_AUTHORITY_INCOMPLETE');
  }
  const originalJournal =
    currentJournal?.reversalOfJournalId === undefined
      ? undefined
      : input.ledger.journal(order.tenantId, currentJournal.reversalOfJournalId);
  if (currentJournal?.reversalOfJournalId !== undefined && originalJournal === undefined) {
    throw new Error('REPLAY_AUTHORITY_INCOMPLETE');
  }
  const journals = [originalJournal, currentJournal].filter(
    (journal): journal is LedgerPostInput => journal !== undefined,
  );
  const journalIds = new Set(journals.map((journal) => journal.journalId));
  if (
    (order.state === 'reconciled' || order.state === 'refunded') &&
    (order.ledgerReceipt === undefined || !journalIds.has(order.ledgerReceipt.journalId))
  ) {
    throw new Error('REPLAY_AUTHORITY_INCOMPLETE');
  }
  const entitlementEvents = input.entitlements
    .events()
    .filter(
      (event) => event.tenantId === order.tenantId && journalIds.has(event.authorityJournalId),
    );
  const fulfillment = input.fulfillment.forOrder(order.tenantId, order.orderId);
  const rebuilt: PaidServiceReplayTuple = {
    correlationId: input.correlationId,
    order,
    journals,
    entitlementEvents,
    fulfillment,
  };
  const authorityConsistent = validateAuthorityTuple(rebuilt);
  return {
    rebuilt,
    matchesExpected:
      authorityConsistent &&
      (input.expected === undefined || exactTuple(input.expected) === exactTuple(rebuilt)),
  };
}

const exactTuple = (tuple: PaidServiceReplayTuple): string => JSON.stringify(tuple);

function validateAuthorityTuple(tuple: PaidServiceReplayTuple): boolean {
  const { order, journals, entitlementEvents, fulfillment } = tuple;
  if (order.state !== 'reconciled' && order.state !== 'refunded') return true;
  if (
    order.tenantId !== order.offer.tenantId ||
    order.ledgerReceipt === undefined ||
    order.railEffectRef === undefined ||
    order.offer.componentLines.length === 0
  ) {
    return false;
  }
  const current = journals.find((journal) => journal.journalId === order.ledgerReceipt?.journalId);
  if (
    current === undefined ||
    createHash('sha256').update(JSON.stringify(current)).digest('hex') !==
      order.ledgerReceipt.canonicalPayloadHash
  ) {
    return false;
  }
  const original =
    current.reversalOfJournalId === undefined
      ? current
      : journals.find((journal) => journal.journalId === current.reversalOfJournalId);
  if (original === undefined || original.reversalOfJournalId !== undefined) return false;
  const expectedPaymentLines = [
    {
      accountRef: 'cash',
      side: 'debit',
      amountMinor: order.offer.amountMinor,
      currency: order.offer.currency,
      sourceRef: order.railEffectRef,
    },
    {
      accountRef: 'paid-service-liability',
      side: 'credit',
      amountMinor: order.offer.amountMinor,
      currency: order.offer.currency,
      sourceRef: order.railEffectRef,
    },
  ];
  if (exactSet(original.lines) !== exactSet(expectedPaymentLines)) return false;

  const components = order.offer.componentLines.flatMap((line) =>
    Array.from({ length: line.quantity }, (_, index) => ({
      componentRef: `${line.componentRef}#${index + 1}`,
      entitlementKind: line.entitlementKind,
      ownerRole: line.ownerRole,
    })),
  );
  const grants = entitlementEvents.filter((event) => event.eventType === 'granted');
  if (
    grants.length !== components.length ||
    components.some(
      (component) =>
        !grants.some(
          (event) =>
            event.tenantId === order.tenantId &&
            event.memberRef === order.memberRef &&
            event.componentRef === component.componentRef &&
            event.entitlementKind === component.entitlementKind &&
            event.authorityJournalId === original.journalId,
        ),
    )
  ) {
    return false;
  }
  const expectedState = order.state === 'refunded' ? 'refunded' : 'paid';
  if (
    fulfillment.length !== components.length ||
    components.some(
      (component) =>
        !fulfillment.some(
          (item) =>
            item.tenantId === order.tenantId &&
            item.orderRef === order.orderId &&
            item.offerVersionRef === order.offer.offerVersionRef &&
            item.componentRef === component.componentRef &&
            item.ownerRole === component.ownerRole &&
            item.state === expectedState,
        ),
    )
  ) {
    return false;
  }
  if (order.state === 'reconciled') {
    return current.reversalOfJournalId === undefined;
  }
  const reversals = entitlementEvents.filter((event) => event.eventType === 'reversed');
  return (
    current.reversalOfJournalId === original.journalId &&
    reversals.length === grants.length &&
    grants.every((grant) =>
      reversals.some(
        (event) =>
          event.reversalOfEventId === grant.eventId &&
          event.authorityJournalId === current.journalId &&
          event.memberRef === grant.memberRef &&
          event.componentRef === grant.componentRef &&
          event.entitlementKind === grant.entitlementKind,
      ),
    )
  );
}

const exactSet = (values: readonly unknown[]): string =>
  JSON.stringify(values.map((value) => JSON.stringify(value)).sort());
