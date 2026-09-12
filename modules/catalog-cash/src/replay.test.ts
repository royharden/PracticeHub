import { EntitlementJournal } from '@practicehub/membership-entitlements';
import { BalancedLedger } from '@practicehub/payments-ledger';
import { describe, expect, it } from 'vitest';

import { FulfillmentStore } from './fulfillment.js';
import type { PaidServiceOrder } from './paid-service-loop.js';
import { replayPaidServiceLoop } from './replay.js';

describe('replayPaidServiceLoop', () => {
  it('rebuilds from app-owned authorities and detects a corrupt derived projection', () => {
    const ledger = new BalancedLedger();
    const receipt = ledger.postBalancedSet({
      tenantId: 'northwind-synthetic',
      journalId: 'journal-1',
      correlationId: 'corr-1',
      idempotencyKey: 'ledger-1',
      lines: [
        { accountRef: 'cash', side: 'debit', amountMinor: 100, currency: 'USD', sourceRef: 'e1' },
        {
          accountRef: 'paid-service-liability',
          side: 'credit',
          amountMinor: 100,
          currency: 'USD',
          sourceRef: 'e1',
        },
      ],
    });
    const entitlements = new EntitlementJournal(ledger);
    const grant = entitlements.grant({
      tenantId: 'northwind-synthetic',
      eventId: 'grant-1',
      memberRef: 'member-1',
      componentRef: 'component-1#1',
      entitlementKind: 'once',
      authorityJournalId: receipt.journalId,
      idempotencyKey: 'grant-key-1',
    });
    const fulfillment = new FulfillmentStore();
    const obligation = fulfillment.createPaid({
      tenantId: 'northwind-synthetic',
      obligationId: 'obligation-1',
      orderRef: 'order-1',
      offerVersionRef: 'offer-v1',
      componentRef: 'component-1#1',
      ownerRole: 'guide',
      state: 'paid',
    });
    const order: PaidServiceOrder = {
      tenantId: 'northwind-synthetic',
      orderId: 'order-1',
      buyerRef: 'buyer-1',
      memberRef: 'member-1',
      offer: {
        tenantId: 'northwind-synthetic',
        catalogVersionRef: 'catalog-v1',
        offerVersionRef: 'offer-v1',
        opaqueProcessorSkuRef: 'sku-1',
        amountMinor: 100,
        currency: 'USD',
        expiresAt: '2027-01-01T00:00:00Z',
        componentLines: [
          {
            componentRef: 'component-1',
            quantity: 1,
            ownerRole: 'guide',
            entitlementKind: 'once',
            fulfillmentKind: 'service',
          },
        ],
        cancellationPolicyRef: 'cancel-v1',
        refundPolicyRef: 'refund-v1',
        synthetic: true,
      },
      state: 'reconciled',
      railEffectRef: 'e1',
      ledgerReceipt: receipt,
      entitlementEvents: [grant],
      fulfillment: [obligation],
    };
    const first = replayPaidServiceLoop({
      correlationId: 'corr-1',
      order,
      ledger,
      entitlements,
      fulfillment,
    });
    expect(first.matchesExpected).toBe(true);
    expect(first.rebuilt.entitlementEvents).toEqual([grant]);
    expect(first.rebuilt.fulfillment).toEqual([obligation]);
    ledger.postBalancedSet({
      tenantId: 'northwind-synthetic',
      journalId: 'other-order-journal',
      correlationId: 'corr-1',
      idempotencyKey: 'other-order-ledger',
      lines: [
        { accountRef: 'cash', side: 'debit', amountMinor: 9, currency: 'USD', sourceRef: 'e2' },
        { accountRef: 'other', side: 'credit', amountMinor: 9, currency: 'USD', sourceRef: 'e2' },
      ],
    });
    expect(
      replayPaidServiceLoop({
        correlationId: 'corr-1',
        order,
        ledger,
        entitlements,
        fulfillment,
      }).rebuilt.journals.map((journal) => journal.journalId),
    ).toEqual(['journal-1']);
    expect(
      replayPaidServiceLoop({
        correlationId: 'corr-1',
        order,
        ledger,
        entitlements,
        fulfillment,
        expected: { ...first.rebuilt, fulfillment: [] },
      }).matchesExpected,
    ).toBe(false);
    expect(() =>
      replayPaidServiceLoop({
        correlationId: 'missing-correlation',
        order,
        ledger,
        entitlements,
        fulfillment,
      }),
    ).toThrow('REPLAY_AUTHORITY_INCOMPLETE');
    expect(
      replayPaidServiceLoop({
        correlationId: 'corr-1',
        order: { ...order, memberRef: 'wrong-member' },
        ledger,
        entitlements,
        fulfillment,
      }).matchesExpected,
    ).toBe(false);
    expect(
      replayPaidServiceLoop({
        correlationId: 'corr-1',
        order: { ...order, offer: { ...order.offer, amountMinor: 700 } },
        ledger,
        entitlements,
        fulfillment,
      }).matchesExpected,
    ).toBe(false);
  });
});
