import type { ComponentMap, ComponentMaps } from './component-map.js';
import type { CoverageFlags } from './coverage.js';
import type { InterimSignedTables } from './signed-table.js';
import { assertOpaqueProcessorSku, type OpaqueProcessorSku } from './sku.js';

export interface CatalogOffer {
  readonly tenantId: string;
  readonly catalogVersionRef: string;
  readonly offerVersionRef: string;
  readonly skuRef: OpaqueProcessorSku;
  readonly payerRef: string;
  readonly mapVersionRef: string;
  readonly coverageTableVersionRef: string;
  readonly billedComponentRefs: readonly string[];
  readonly amountMinor: number;
  readonly currency: string;
}

export class CatalogV2Error extends Error {
  public constructor(public readonly code: 'OFFER_NOT_FOUND' | 'OFFER_INVALID') {
    super(code);
    this.name = 'CatalogV2Error';
  }
}

const offerKey = (tenantId: string, offerVersionRef: string): string =>
  JSON.stringify([tenantId, offerVersionRef]);

export class CatalogCore {
  public constructor(
    public readonly maps: ComponentMaps,
    public readonly coverage: CoverageFlags,
    public readonly signedTables: InterimSignedTables,
  ) {}

  readonly #offers = new Map<string, CatalogOffer>();

  public addOffer(offer: CatalogOffer): ComponentMap {
    if (offer.amountMinor <= 0 || offer.currency !== 'USD')
      throw new CatalogV2Error('OFFER_INVALID');
    const sku = assertOpaqueProcessorSku(offer.skuRef);
    this.signedTables.get(offer.tenantId, offer.coverageTableVersionRef);
    this.coverage.resolve({
      tenantId: offer.tenantId,
      payerRef: offer.payerRef,
      skuRef: sku,
      tableVersionRef: offer.coverageTableVersionRef,
    });
    const map = this.maps.proveComposition({
      tenantId: offer.tenantId,
      skuRef: sku,
      mapVersionRef: offer.mapVersionRef,
      billedComponentRefs: offer.billedComponentRefs,
    });
    const stored = Object.freeze({
      ...offer,
      skuRef: sku,
      billedComponentRefs: Object.freeze([...offer.billedComponentRefs]),
    });
    this.#offers.set(offerKey(stored.tenantId, stored.offerVersionRef), stored);
    return map;
  }

  public quote(input: {
    readonly tenantId: string;
    readonly offerVersionRef: string;
    readonly payerRef: string;
  }): CatalogOffer {
    const offer = this.#offers.get(offerKey(input.tenantId, input.offerVersionRef));
    if (offer === undefined) throw new CatalogV2Error('OFFER_NOT_FOUND');
    this.coverage.resolve({
      tenantId: offer.tenantId,
      payerRef: input.payerRef,
      skuRef: offer.skuRef,
      tableVersionRef: offer.coverageTableVersionRef,
    });
    this.maps.proveComposition({
      tenantId: offer.tenantId,
      skuRef: offer.skuRef,
      mapVersionRef: offer.mapVersionRef,
      billedComponentRefs: offer.billedComponentRefs,
    });
    return offer;
  }
}
