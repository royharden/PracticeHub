import type { OnCallRosterPort } from '../types.js';

/** Local WP-023 on-call roster double. Does not import modules/events. */
export class Wp023OnCallDoubleV1 implements OnCallRosterPort {
  readonly #primaries = new Map<string, string>();

  public setPrimary(tenantId: string, memberRef: string): void {
    this.#primaries.set(tenantId, memberRef);
  }

  public primary(tenantId: string): string | null {
    return this.#primaries.get(tenantId) ?? null;
  }
}
