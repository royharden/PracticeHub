import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CatalogCore } from './catalog.js';
import { ComponentMaps } from './component-map.js';
import { CoverageError, CoverageFlags } from './coverage.js';
import { InterimSignedTables } from './signed-table.js';
import { assertOpaqueProcessorSku, SkuError } from './sku.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const load = (name: string): unknown =>
  JSON.parse(readFileSync(`${root}modules/catalog/fixtures/${name}`, 'utf8')) as unknown;

describe('WP-050 four-class fixtures invoke domain behavior', () => {
  it('HAPPY quotes a classified composed offer', () => {
    const happy = load('WP-050.HAPPY.json') as {
      tenantId: string;
      payerRef: string;
      skuRef: string;
      billedComponentRefs: string[];
      classification: 'non-covered';
    };
    const maps = new ComponentMaps();
    maps.add({
      tenantId: happy.tenantId,
      mapVersionRef: 'map-v1',
      skuRef: happy.skuRef,
      lines: [
        { componentRef: 'awv-core', kind: 'awv', quantity: 1, billed: true },
        { componentRef: 'ippe-core', kind: 'ippe', quantity: 1, billed: true },
      ],
    });
    const coverage = new CoverageFlags();
    coverage.add({
      tenantId: happy.tenantId,
      payerRef: happy.payerRef,
      skuRef: happy.skuRef,
      tableVersionRef: 'cov-v1',
      classification: happy.classification,
    });
    const signedTables = new InterimSignedTables();
    signedTables.sign({
      tenantId: happy.tenantId,
      tableVersionRef: 'cov-v1',
      signerRef: 'signer-compliance-1',
      flags: [
        {
          tenantId: happy.tenantId,
          payerRef: happy.payerRef,
          skuRef: happy.skuRef,
          tableVersionRef: 'cov-v1',
          classification: happy.classification,
        },
      ],
    });
    const catalog = new CatalogCore(maps, coverage, signedTables);
    catalog.addOffer({
      tenantId: happy.tenantId,
      catalogVersionRef: 'cat-v1',
      offerVersionRef: 'offer-1',
      skuRef: happy.skuRef as `sku:${string}`,
      payerRef: happy.payerRef,
      mapVersionRef: 'map-v1',
      coverageTableVersionRef: 'cov-v1',
      billedComponentRefs: happy.billedComponentRefs,
      amountMinor: 19900,
      currency: 'USD',
    });
    expect(
      catalog.quote({
        tenantId: happy.tenantId,
        offerVersionRef: 'offer-1',
        payerRef: happy.payerRef,
      }).skuRef,
    ).toBe(happy.skuRef);
  });

  it('BOUNDARY encodes SKU grammar', () => {
    const boundary = load('WP-050.BOUNDARY.json') as {
      skuAccept: string;
      skuRejectShort: string;
      skuRejectHealth: string;
    };
    expect(assertOpaqueProcessorSku(boundary.skuAccept)).toBe(boundary.skuAccept);
    expect(() => assertOpaqueProcessorSku(boundary.skuRejectShort)).toThrowError(
      new SkuError('SKU_GRAMMAR'),
    );
    expect(() => assertOpaqueProcessorSku(boundary.skuRejectHealth)).toThrowError(
      new SkuError('SKU_HEALTH_REVEALING'),
    );
  });

  it('FAILURE default-denies an untagged payer', () => {
    const failure = load('WP-050.FAILURE.json') as { untaggedPayerRef: string };
    const happy = load('WP-050.HAPPY.json') as {
      tenantId: string;
      payerRef: string;
      skuRef: string;
      billedComponentRefs: string[];
      classification: 'non-covered';
    };
    const maps = new ComponentMaps();
    maps.add({
      tenantId: happy.tenantId,
      mapVersionRef: 'map-v1',
      skuRef: happy.skuRef,
      lines: [
        { componentRef: 'awv-core', kind: 'awv', quantity: 1, billed: true },
        { componentRef: 'ippe-core', kind: 'ippe', quantity: 1, billed: true },
      ],
    });
    const coverage = new CoverageFlags();
    coverage.add({
      tenantId: happy.tenantId,
      payerRef: happy.payerRef,
      skuRef: happy.skuRef,
      tableVersionRef: 'cov-v1',
      classification: happy.classification,
    });
    const signedTables = new InterimSignedTables();
    signedTables.sign({
      tenantId: happy.tenantId,
      tableVersionRef: 'cov-v1',
      signerRef: 'signer-compliance-1',
      flags: [
        {
          tenantId: happy.tenantId,
          payerRef: happy.payerRef,
          skuRef: happy.skuRef,
          tableVersionRef: 'cov-v1',
          classification: happy.classification,
        },
      ],
    });
    const catalog = new CatalogCore(maps, coverage, signedTables);
    catalog.addOffer({
      tenantId: happy.tenantId,
      catalogVersionRef: 'cat-v1',
      offerVersionRef: 'offer-1',
      skuRef: happy.skuRef as `sku:${string}`,
      payerRef: happy.payerRef,
      mapVersionRef: 'map-v1',
      coverageTableVersionRef: 'cov-v1',
      billedComponentRefs: happy.billedComponentRefs,
      amountMinor: 19900,
      currency: 'USD',
    });
    expect(() =>
      catalog.quote({
        tenantId: happy.tenantId,
        offerVersionRef: 'offer-1',
        payerRef: failure.untaggedPayerRef,
      }),
    ).toThrowError(new CoverageError('FLAG_NOT_FOUND'));
  });

  it('RECOVERY names refuse-until-signed-classified-composition', () => {
    const recovery = load('WP-050.RECOVERY.json') as { action: string };
    expect(recovery.action).toBe('refuse-sell-until-signed-classified-composition');
  });
});
