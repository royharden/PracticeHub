export interface AthenaCacheEntry {
  readonly key: string;
  readonly tenantId: string;
  readonly payloadHash: string;
  readonly observedAt: string;
  readonly staleAfter: string;
}

export class AthenaSimCache {
  readonly #entries = new Map<string, AthenaCacheEntry>();

  public put(entry: AthenaCacheEntry): void {
    this.#entries.set(entry.key, entry);
  }

  public get(key: string): AthenaCacheEntry | undefined {
    return this.#entries.get(key);
  }

  public isStale(key: string, now: string): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return true;
    return now >= entry.staleAfter;
  }

  public purge(): number {
    const n = this.#entries.size;
    this.#entries.clear();
    return n;
  }
}
