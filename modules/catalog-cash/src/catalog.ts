import { assertMoney } from '@practicehub/payments-ledger';

export interface CatalogComponentLine {
  readonly componentRef: string;
  readonly quantity: number;
  readonly ownerRole: string;
  readonly entitlementKind: string;
  readonly fulfillmentKind: string;
}

export interface CatalogOfferSnapshot {
  readonly tenantId: string;
  readonly catalogVersionRef: string;
  readonly offerVersionRef: string;
  readonly opaqueProcessorSkuRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly expiresAt: string;
  readonly componentLines: readonly CatalogComponentLine[];
  readonly cancellationPolicyRef: string;
  readonly refundPolicyRef: string;
  readonly synthetic: true;
}

const catalogKey = (tenantId: string, offerVersionRef: string): string =>
  JSON.stringify([tenantId, offerVersionRef]);

const immutableSnapshot = (snapshot: CatalogOfferSnapshot): CatalogOfferSnapshot => {
  const componentLines = Object.freeze(
    snapshot.componentLines.map((line) => Object.freeze({ ...line })),
  );
  return Object.freeze({ ...snapshot, componentLines });
};

export class CatalogError extends Error {
  public constructor(
    public readonly code:
      'OFFER_NOT_FOUND' | 'OFFER_EXPIRED' | 'OFFER_UNCLASSIFIED' | 'COMPONENT_MAPPING_MISSING',
  ) {
    super(code);
    this.name = 'CatalogError';
  }
}

export class Catalog {
  readonly #offers = new Map<string, CatalogOfferSnapshot>();

  public add(snapshot: CatalogOfferSnapshot): void {
    assertMoney({ amountMinor: snapshot.amountMinor, currency: snapshot.currency });
    if (!Number.isFinite(Date.parse(snapshot.expiresAt)))
      throw new CatalogError('OFFER_UNCLASSIFIED');
    if (
      snapshot.componentLines.length === 0 ||
      snapshot.componentLines.some(
        (line) =>
          line.componentRef === '' ||
          line.ownerRole === '' ||
          line.entitlementKind === '' ||
          line.fulfillmentKind === '' ||
          !Number.isSafeInteger(line.quantity) ||
          line.quantity <= 0,
      )
    ) {
      throw new CatalogError('COMPONENT_MAPPING_MISSING');
    }
    const refs = snapshot.componentLines.map((line) => line.componentRef);
    if (new Set(refs).size !== refs.length) throw new CatalogError('OFFER_UNCLASSIFIED');
    const stored = immutableSnapshot(snapshot);
    const key = catalogKey(stored.tenantId, stored.offerVersionRef);
    const prior = this.#offers.get(key);
    if (prior !== undefined) {
      if (JSON.stringify(prior) !== JSON.stringify(stored))
        throw new CatalogError('OFFER_UNCLASSIFIED');
      return;
    }
    this.#offers.set(key, stored);
  }

  public quoteForCheckout(input: {
    readonly tenantId: string;
    readonly offerRef: string;
    readonly asOf: string;
  }): CatalogOfferSnapshot {
    if (!Number.isFinite(Date.parse(input.asOf))) throw new CatalogError('OFFER_UNCLASSIFIED');
    const offer = this.#offers.get(catalogKey(input.tenantId, input.offerRef));
    if (offer === undefined) throw new CatalogError('OFFER_NOT_FOUND');
    if (Date.parse(input.asOf) >= Date.parse(offer.expiresAt))
      throw new CatalogError('OFFER_EXPIRED');
    return offer;
  }
}
