export class ScopedAsyncLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
    const acquired: Array<{ key: string; tail: Promise<void>; release: () => void }> = [];
    for (const key of [...new Set(keys)].sort()) {
      const previous = this.tails.get(key) ?? Promise.resolve();
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => gate);
      this.tails.set(key, tail);
      await previous;
      acquired.push({ key, tail, release });
    }
    try {
      return await work();
    } finally {
      for (const lock of acquired.reverse()) {
        lock.release();
        if (this.tails.get(lock.key) === lock.tail) this.tails.delete(lock.key);
      }
    }
  }
}
