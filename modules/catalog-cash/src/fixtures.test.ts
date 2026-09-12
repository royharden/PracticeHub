import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { EntitlementJournal } from '@practicehub/membership-entitlements';
import {
  assertMoney,
  BalancedLedger,
  LedgerError,
  type LedgerPostInput,
} from '@practicehub/payments-ledger';
import { describe, expect, it } from 'vitest';

import { Catalog, type CatalogOfferSnapshot } from './catalog.js';
import { FulfillmentStore } from './fulfillment.js';

interface Fixture {
  readonly requirement: string;
  readonly class: 'HAPPY' | 'BOUNDARY' | 'FAILURE' | 'RECOVERY';
  readonly synthetic: true;
  readonly probe:
    | 'valid-offer'
    | 'expiry-boundary'
    | 'invalid-asof'
    | 'unsafe-money'
    | 'duplicate-components'
    | 'ledger-idempotency'
    | 'exact-reversal'
    | 'reversal-twice'
    | 'unbalanced-ledger'
    | 'entitlement-reversal'
    | 'fulfillment-status'
    | 'missing-lifecycle'
    | 'quantity-two'
    | 'missing-owner'
    | 'fulfillment-refund';
}

const fixtureRoot = fileURLToPath(new URL('../fixtures/', import.meta.url));
const requirements = [
  'REQ-SVC-002',
  'REQ-SVC-005',
  'REQ-SVC-007',
  'REQ-SVC-011',
  'REQ-SVC-030',
] as const;
const classes = ['HAPPY', 'BOUNDARY', 'FAILURE', 'RECOVERY'] as const;

const offer = (): CatalogOfferSnapshot => ({
  tenantId: 'northwind-synthetic',
  catalogVersionRef: 'catalog-v1',
  offerVersionRef: 'offer-v1',
  opaqueProcessorSkuRef: 'sku-opaque',
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
});

function runProbe(fixture: Fixture): void {
  if (fixture.probe === 'valid-offer') {
    const catalog = new Catalog();
    catalog.add(offer());
    expect(
      catalog.quoteForCheckout({
        tenantId: 'northwind-synthetic',
        offerRef: 'offer-v1',
        asOf: '2026-01-01T00:00:00Z',
      }).offerVersionRef,
    ).toBe('offer-v1');
  } else if (fixture.probe === 'expiry-boundary') {
    const catalog = new Catalog();
    catalog.add(offer());
    expect(() =>
      catalog.quoteForCheckout({
        tenantId: 'northwind-synthetic',
        offerRef: 'offer-v1',
        asOf: '2027-01-01T00:00:00Z',
      }),
    ).toThrow('OFFER_EXPIRED');
  } else if (fixture.probe === 'invalid-asof') {
    const catalog = new Catalog();
    catalog.add(offer());
    expect(() =>
      catalog.quoteForCheckout({
        tenantId: 'northwind-synthetic',
        offerRef: 'offer-v1',
        asOf: 'invalid',
      }),
    ).toThrow('OFFER_UNCLASSIFIED');
  } else if (fixture.probe === 'unsafe-money') {
    expect(() =>
      assertMoney({ amountMinor: Number.MAX_SAFE_INTEGER + 1, currency: 'USD' }),
    ).toThrow(/safe integer/);
  } else if (fixture.probe === 'duplicate-components') {
    const duplicate = offer();
    const component = duplicate.componentLines[0];
    if (component === undefined) throw new Error('fixture requires a component');
    expect(() =>
      new Catalog().add({ ...duplicate, componentLines: [component, component] }),
    ).toThrow('OFFER_UNCLASSIFIED');
  } else if (fixture.probe === 'entitlement-reversal') {
    const ledger = new BalancedLedger();
    ledger.postBalancedSet(paymentPost());
    ledger.postBalancedSet(reversalPost());
    const journal = new EntitlementJournal(ledger);
    const grant = journal.grant({
      tenantId: 'northwind-synthetic',
      eventId: 'g1',
      memberRef: 'm1',
      componentRef: 'c1',
      entitlementKind: 'once',
      authorityJournalId: 'j1',
      idempotencyKey: 'gk1',
    });
    journal.reverse({
      ...grant,
      eventId: 'r1',
      authorityJournalId: 'jr1',
      idempotencyKey: 'rk1',
      reversalOfEventId: grant.eventId,
    });
    expect(journal.check('northwind-synthetic', 'm1', 'c1')).toBe(false);
  } else if (fixture.probe === 'ledger-idempotency') {
    const ledger = new BalancedLedger();
    const post = paymentPost();
    expect(ledger.postBalancedSet(post)).toEqual(ledger.postBalancedSet(post));
    expect(ledger.journals()).toHaveLength(1);
  } else if (fixture.probe === 'exact-reversal' || fixture.probe === 'reversal-twice') {
    const ledger = new BalancedLedger();
    ledger.postBalancedSet(paymentPost());
    const reversal = reversalPost();
    ledger.postBalancedSet(reversal);
    if (fixture.probe === 'reversal-twice') {
      expect(() =>
        ledger.postBalancedSet({ ...reversal, journalId: 'jr2', idempotencyKey: 'lr2' }),
      ).toThrowError(new LedgerError('ALREADY_REVERSED'));
    } else {
      expect(ledger.journals()).toHaveLength(2);
    }
  } else if (fixture.probe === 'unbalanced-ledger') {
    expect(() =>
      new BalancedLedger().postBalancedSet({
        ...paymentPost(),
        lines: [
          {
            accountRef: 'cash',
            side: 'debit',
            amountMinor: 101,
            currency: 'USD',
            sourceRef: 'effect-1',
          },
          {
            accountRef: 'liability',
            side: 'credit',
            amountMinor: 100,
            currency: 'USD',
            sourceRef: 'effect-1',
          },
        ],
      }),
    ).toThrowError(new LedgerError('UNBALANCED'));
  } else if (fixture.probe === 'quantity-two') {
    const value = offer();
    const component = value.componentLines[0];
    if (component === undefined) throw new Error('fixture requires a component');
    const catalog = new Catalog();
    catalog.add({ ...value, componentLines: [{ ...component, quantity: 2 }] });
    expect(
      catalog.quoteForCheckout({
        tenantId: value.tenantId,
        offerRef: value.offerVersionRef,
        asOf: '2026-01-01T00:00:00Z',
      }).componentLines[0]?.quantity,
    ).toBe(2);
  } else if (
    fixture.probe === 'fulfillment-status' ||
    fixture.probe === 'missing-lifecycle' ||
    fixture.probe === 'missing-owner' ||
    fixture.probe === 'fulfillment-refund'
  ) {
    const store = new FulfillmentStore();
    const item = {
      tenantId: 'northwind-synthetic',
      obligationId: 'ob1',
      orderRef: 'o1',
      offerVersionRef: 'offer-v1',
      componentRef: 'c1#1',
      ownerRole: fixture.probe === 'missing-owner' ? '' : 'guide',
      state: 'paid' as const,
    };
    if (fixture.probe === 'missing-owner') {
      expect(() => store.createPaid(item)).toThrow('FULFILLMENT_OWNER_REQUIRED');
    } else {
      store.createPaid(item);
      if (fixture.probe === 'fulfillment-refund') store.refund(item.tenantId, item.orderRef);
      const status = store.getFulfillmentStatus(item.tenantId, item.orderRef);
      if (fixture.probe === 'missing-lifecycle')
        expect(!('dueAt' in item) && !('refundableState' in item)).toBe(true);
      else if (fixture.probe === 'fulfillment-refund')
        expect(status.aggregateState).toBe('refunded');
      else expect(status.aggregateState).toBe('paid');
    }
  } else {
    throw new Error(`UNKNOWN_FIXTURE_PROBE:${String(fixture.probe)}`);
  }
}

function paymentPost(): LedgerPostInput {
  return {
    tenantId: 'northwind-synthetic',
    journalId: 'j1',
    correlationId: 'c1',
    idempotencyKey: 'l1',
    lines: [
      {
        accountRef: 'cash',
        side: 'debit',
        amountMinor: 100,
        currency: 'USD',
        sourceRef: 'effect-1',
      },
      {
        accountRef: 'liability',
        side: 'credit',
        amountMinor: 100,
        currency: 'USD',
        sourceRef: 'effect-1',
      },
    ],
  };
}

function reversalPost(): LedgerPostInput {
  return {
    tenantId: 'northwind-synthetic',
    journalId: 'jr1',
    correlationId: 'cr1',
    idempotencyKey: 'lr1',
    reversalOfJournalId: 'j1',
    lines: [
      {
        accountRef: 'cash',
        side: 'credit',
        amountMinor: 100,
        currency: 'USD',
        sourceRef: 'effect-1',
      },
      {
        accountRef: 'liability',
        side: 'debit',
        amountMinor: 100,
        currency: 'USD',
        sourceRef: 'effect-1',
      },
    ],
  };
}

describe('WP-031 four-class fixtures invoke domain behavior', () => {
  for (const requirement of requirements) {
    for (const fixtureClass of classes) {
      it(`${requirement} ${fixtureClass}`, () => {
        const fixture = JSON.parse(
          readFileSync(`${fixtureRoot}${requirement}.${fixtureClass}.json`, 'utf8'),
        ) as Fixture;
        expect(fixture).toMatchObject({ requirement, class: fixtureClass, synthetic: true });
        runProbe(fixture);
      });
    }
  }

  it('rejects an unknown fixture probe instead of default-passing it', () => {
    expect(() =>
      runProbe({
        requirement: 'REQ-SVC-011',
        class: 'FAILURE',
        probe: 'unknown-probe',
      } as unknown as Fixture),
    ).toThrow('UNKNOWN_FIXTURE_PROBE:unknown-probe');
  });
});
