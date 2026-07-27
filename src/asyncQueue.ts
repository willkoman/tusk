/** Serialize asynchronous work per key. A rejected task never blocks later work. */
export class KeyedSerialQueue<K> {
  private tails = new Map<K, Promise<void>>();

  run<T>(key: K, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(task);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
