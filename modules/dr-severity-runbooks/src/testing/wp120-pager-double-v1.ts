import type { PagerPort } from '../types.js';

/** Local WP-120 degraded-pager double. Vendor-down is a drill, not a drop. */
export class Wp120PagerDoubleV1 implements PagerPort {
  public vendorDown = false;
  readonly #pages: {
    readonly tenantId: string;
    readonly memberRef: string;
    readonly incidentId: string;
  }[] = [];

  public page(input: {
    readonly tenantId: string;
    readonly memberRef: string;
    readonly incidentId: string;
  }): 'delivered' | 'vendor_down' {
    this.#pages.push(input);
    return this.vendorDown ? 'vendor_down' : 'delivered';
  }

  public snapshot(): readonly {
    readonly tenantId: string;
    readonly memberRef: string;
    readonly incidentId: string;
  }[] {
    return [...this.#pages];
  }
}
