import type { WhiteLabelProfile } from '../types.js';

/** Local WP-126 white-label double. Does not import D23 trees. */
export class Wp126WhiteLabelDoubleV1 {
  readonly #profiles = new Map<string, WhiteLabelProfile>();

  public register(profile: WhiteLabelProfile): void {
    this.#profiles.set(profile.tenantId, profile);
  }

  public brandFor(tenantId: string): WhiteLabelProfile | undefined {
    return this.#profiles.get(tenantId);
  }
}
