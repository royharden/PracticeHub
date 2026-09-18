export class ScopedAsyncLock {
  readonly #tails = new Map<string, Promise<void>>();

  async runExclusive<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#tails.set(
      key,
      previous.then(() => current),
    );
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
