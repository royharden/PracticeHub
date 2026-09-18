import { describe, expect, it } from 'vitest';

import { CatalogCore, CatalogV2Error, type CatalogOffer } from './catalog.js';
import { ComponentMaps } from './component-map.js';
import { CoverageError, CoverageFlags } from './coverage.js';
import { InterimSignedTables } from './signed-table.js';
import { SkuError } from './sku.js';

const tenantId = 'northwind-synthetic';
const skuRef = 'sku:nwind-o1-aaaa';
const tableVersionRef = 'cov-v1';

const seed = (): CatalogCore => {
  const maps = new ComponentMaps();
  maps.add({
    tenantId,
    mapVersionRef: 'map-v1',
    skuRef,
    lines: [
      { componentRef: 'awv-core', kind: 'awv', quantity: 1, billed: true },
      { componentRef: 'ippe-core', kind: 'ippe', quantity: 1, billed: true },
    ],
  });
  const coverage = new CoverageFlags();
  coverage.add({
    tenantId,
    payerRef: 'payer-cash',
    skuRef,
    tableVersionRef,
    classification: 'non-covered',
  });
  const signedTables = new InterimSignedTables();
  signedTables.sign({
    tenantId,
    tableVersionRef,
    signerRef: 'signer-compliance-1',
    flags: [
      {
        tenantId,
        payerRef: 'payer-cash',
        skuRef,
        tableVersionRef,
        classification: 'non-covered',
      },
    ],
  });
  return new CatalogCore(maps, coverage, signedTables);
};

const offer: CatalogOffer = {
  tenantId,
  catalogVersionRef: 'cat-v1',
  offerVersionRef: 'offer-1',
  skuRef,
  payerRef: 'payer-cash',
  mapVersionRef: 'map-v1',
  coverageTableVersionRef: tableVersionRef,
  billedComponentRefs: ['awv-core', 'ippe-core'],
  amountMinor: 19900,
  currency: 'USD',
};

describe('CatalogCore', () => {
  it('quotes only after SKU, signed coverage, and composition succeed', () => {
    const catalog = seed();
    catalog.addOffer(offer);
    expect(
      catalog.quote({ tenantId, offerVersionRef: offer.offerVersionRef, payerRef: 'payer-cash' })
        .skuRef,
    ).toBe(skuRef);
  });

  it('default-denies an untagged payer context', () => {
    const catalog = seed();
    catalog.addOffer(offer);
    expect(() =>
      catalog.quote({
        tenantId,
        offerVersionRef: offer.offerVersionRef,
        payerRef: 'payer-unknown',
      }),
    ).toThrowError(new CoverageError('FLAG_NOT_FOUND'));
  });

  it('rejects a health-revealing SKU before coverage runs', () => {
    const catalog = seed();
    expect(() => catalog.addOffer({ ...offer, skuRef: 'sku:awv-visit-01' })).toThrowError(
      new SkuError('SKU_HEALTH_REVEALING'),
    );
  });

  it('fails closed when the offer is absent', () => {
    expect(() =>
      seed().quote({ tenantId, offerVersionRef: 'missing', payerRef: 'payer-cash' }),
    ).toThrowError(new CatalogV2Error('OFFER_NOT_FOUND'));
  });
});
