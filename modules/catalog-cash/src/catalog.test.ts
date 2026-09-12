import { describe, expect, it } from 'vitest';

import { Catalog, CatalogError, type CatalogOfferSnapshot } from './catalog.js';

const offer: CatalogOfferSnapshot = {
  tenantId: 'northwind-synthetic',
  catalogVersionRef: 'v1',
  offerVersionRef: 'o1',
  opaqueProcessorSkuRef: 'sku1',
  amountMinor: 100,
  currency: 'USD',
  expiresAt: '2027-01-01T00:00:00Z',
  componentLines: [
    {
      componentRef: 'c1',
      quantity: 1,
      ownerRole: 'guide',
      entitlementKind: 'once',
      fulfillmentKind: 'service',
    },
  ],
  cancellationPolicyRef: 'cancel-v1',
  refundPolicyRef: 'refund-v1',
  synthetic: true,
};

describe('Catalog', () => {
  it('returns an immutable-version quote before expiry and fails closed at expiry', () => {
    const catalog = new Catalog();
    catalog.add(offer);
    const quote = catalog.quoteForCheckout({
      tenantId: offer.tenantId,
      offerRef: offer.offerVersionRef,
      asOf: '2026-01-01T00:00:00Z',
    });
    expect(quote).toEqual(offer);
    expect(quote).not.toBe(offer);
    expect(Object.isFrozen(quote)).toBe(true);
    expect(Object.isFrozen(quote.componentLines)).toBe(true);
    expect(() =>
      catalog.quoteForCheckout({
        tenantId: offer.tenantId,
        offerRef: offer.offerVersionRef,
        asOf: offer.expiresAt,
      }),
    ).toThrowError(new CatalogError('OFFER_EXPIRED'));
  });

  it('rejects invalid expiry and observation timestamps', () => {
    expect(() => new Catalog().add({ ...offer, expiresAt: 'not-a-date' })).toThrow(
      'OFFER_UNCLASSIFIED',
    );
    const catalog = new Catalog();
    catalog.add(offer);
    expect(() =>
      catalog.quoteForCheckout({
        tenantId: offer.tenantId,
        offerRef: offer.offerVersionRef,
        asOf: 'invalid',
      }),
    ).toThrow('OFFER_UNCLASSIFIED');
  });

  it('keeps delimiter-bearing tenant and offer tuples distinct', () => {
    const catalog = new Catalog();
    catalog.add({ ...offer, tenantId: 'tenant:a', offerVersionRef: 'b' });
    catalog.add({ ...offer, tenantId: 'tenant', offerVersionRef: 'a:b' });
    expect(
      catalog.quoteForCheckout({
        tenantId: 'tenant:a',
        offerRef: 'b',
        asOf: '2026-01-01T00:00:00Z',
      }).tenantId,
    ).toBe('tenant:a');
    expect(
      catalog.quoteForCheckout({
        tenantId: 'tenant',
        offerRef: 'a:b',
        asOf: '2026-01-01T00:00:00Z',
      }).tenantId,
    ).toBe('tenant');
  });

  it('rejects zero-value paid offers and immutable-version replacement', () => {
    expect(() => new Catalog().add({ ...offer, amountMinor: 0 })).toThrow(/positive safe integer/);
    const catalog = new Catalog();
    catalog.add(offer);
    expect(() => catalog.add({ ...offer, amountMinor: offer.amountMinor + 1 })).toThrow(
      'OFFER_UNCLASSIFIED',
    );
  });

  it('clones the caller snapshot so later alias mutation cannot change an accepted version', () => {
    const mutable = structuredClone(offer) as CatalogOfferSnapshot;
    const catalog = new Catalog();
    catalog.add(mutable);
    (mutable as { amountMinor: number }).amountMinor = 777;
    (mutable.componentLines[0] as { ownerRole: string }).ownerRole = 'mutated';
    const quote = catalog.quoteForCheckout({
      tenantId: offer.tenantId,
      offerRef: offer.offerVersionRef,
      asOf: '2026-01-01T00:00:00Z',
    });
    expect(quote.amountMinor).toBe(offer.amountMinor);
    expect(quote.componentLines[0]?.ownerRole).toBe('guide');
  });
});
