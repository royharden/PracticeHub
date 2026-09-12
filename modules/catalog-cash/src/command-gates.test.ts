import {
  CapabilityDeniedError,
  capabilityRegistryV1,
  foldCapabilityEvents,
  syntheticCapabilitySeedV1,
  type CapabilityGrant,
} from '@practicehub/platform-core';
import { describe, expect, it } from 'vitest';

import { consumePaidServiceEventCommand } from './commands/consume-paid-service-event.command.js';
import { createPaidServiceOrderCommand } from './commands/create-paid-service-order.command.js';
import type { PaidServiceEvent } from './event-port.js';
import type { PaidServiceLoop, PurchaseInput } from './paid-service-loop.js';

const grants: readonly CapabilityGrant[] = [
  ...syntheticCapabilitySeedV1.initialGrants,
  ...foldCapabilityEvents(capabilityRegistryV1, [], syntheticCapabilitySeedV1.events),
];
const event: PaidServiceEvent = {
  eventId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  tenantId: 'northwind-synthetic',
  type: 'payment.reconciled',
  orderRef: 'order-1',
  journalRef: 'journal-1',
  occurredAt: '2026-04-01T12:00:00Z',
  correlationId: 'corr:1',
  idempotencyKey: 'event-key-1',
  externalReceiptRef: 'receipt-1',
};
const purchase: Omit<PurchaseInput, 'capabilityAllowed'> = {
  tenantId: 'northwind-synthetic',
  buyerRef: 'buyer-1',
  memberRef: 'member-1',
  offerRef: 'offer-1',
  processorAccountRef: 'account-1',
  identityEligibility: 'eligible',
  correlationId: 'corr:1',
  idempotencyKey: 'purchase-key-1',
  occurredAt: '2026-04-01T12:00:00Z',
  responseDueAt: '2026-04-01T13:00:00Z',
  ownerRef: 'synthetic-staff:finance-1',
  ids: {
    orderId: 'o1',
    paymentJournalId: 'j1',
    paymentEventId: 'e1',
    refundJournalId: 'jr1',
    refundEventId: 'er1',
    workItemId: 'w1',
  },
};

describe('cash.paid-service-loop command gates', () => {
  it('allows Northwind at simulated on enqueue and passes capabilityAllowed only after approval', async () => {
    let called = false;
    const loop = {
      purchase: (value: PurchaseInput) => {
        called = value.capabilityAllowed;
        return Promise.resolve({});
      },
    } as unknown as PaidServiceLoop;
    const invocation = createPaidServiceOrderCommand.invoke(
      capabilityRegistryV1,
      grants,
      { tenantId: 'northwind-synthetic', scope: {} },
      { loop, purchase },
      { checkpoint: 'enqueue' },
    );
    await invocation.result;
    expect(invocation.decision.allowed).toBe(true);
    expect(called).toBe(true);
  });

  it('denies Riverbend before the enqueue handler body runs', () => {
    let called = false;
    const loop = {
      purchase: () => {
        called = true;
        return Promise.resolve({});
      },
    } as unknown as PaidServiceLoop;
    expect(() =>
      createPaidServiceOrderCommand.invoke(
        capabilityRegistryV1,
        grants,
        { tenantId: 'riverbend-synthetic', scope: {} },
        { loop, purchase: { ...purchase, tenantId: 'riverbend-synthetic' } },
        { checkpoint: 'enqueue' },
      ),
    ).toThrow(CapabilityDeniedError);
    expect(called).toBe(false);
  });

  it('rechecks at drain and runs the consumer effect only when allowed', async () => {
    let effects = 0;
    const allowed = consumePaidServiceEventCommand.invoke(
      capabilityRegistryV1,
      grants,
      { tenantId: 'northwind-synthetic', scope: {} },
      {
        event,
        consume: () => {
          effects += 1;
          return Promise.resolve('done');
        },
      },
      { checkpoint: 'drain' },
    );
    expect(await allowed.result).toBe('done');
    expect(effects).toBe(1);
    expect(() =>
      consumePaidServiceEventCommand.invoke(
        capabilityRegistryV1,
        grants,
        { tenantId: 'riverbend-synthetic', scope: {} },
        {
          event: { ...event, tenantId: 'riverbend-synthetic' },
          consume: () => {
            effects += 1;
            return Promise.resolve('bad');
          },
        },
        { checkpoint: 'drain' },
      ),
    ).toThrow(CapabilityDeniedError);
    expect(effects).toBe(1);
  });
});
