import type { CatalogComposition, CoverageClass } from '../types.js';

export class CatalogDouble {
  readonly #bySku = new Map<string, CatalogComposition>();

  put(composition: CatalogComposition): void {
    this.#bySku.set(composition.skuRef, composition);
  }

  get(skuRef: string): CatalogComposition | undefined {
    return this.#bySku.get(skuRef);
  }

  coverageOf(skuRef: string, componentRef: string): CoverageClass | undefined {
    return this.#bySku.get(skuRef)?.lines.find((line) => line.componentRef === componentRef)
      ?.coverage;
  }
}
