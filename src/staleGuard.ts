/**
 * Last-write-wins for asynchronous replies.
 *
 * Mint a token before awaiting, ask `current(token)` after: only the newest mint is
 * current, and nothing is current once the guard is disposed (the owner unmounted or the
 * work was abandoned). `invalidate` marks every outstanding token stale without minting,
 * for an event that supersedes in-flight work (a live status push beating a snapshot fetch).
 */
export class StaleGuard {
  private generation = 0;
  private disposed = false;

  mint(): number {
    return ++this.generation;
  }

  current(token: number): boolean {
    return !this.disposed && this.generation === token;
  }

  invalidate(): void {
    this.generation++;
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
  }

  get alive(): boolean {
    return !this.disposed;
  }
}

/** One `StaleGuard` per key: a reply for key A never invalidates a reply for key B. */
export class KeyedStaleGuard<K> {
  private generations = new Map<K, number>();
  private disposed = false;

  mint(key: K): number {
    const next = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, next);
    return next;
  }

  current(key: K, token: number): boolean {
    return !this.disposed && this.generations.get(key) === token;
  }

  invalidate(key: K): void {
    this.mint(key);
  }

  invalidateAll(): void {
    for (const key of this.generations.keys()) this.mint(key);
  }

  dispose(): void {
    this.disposed = true;
    this.invalidateAll();
  }

  get alive(): boolean {
    return !this.disposed;
  }
}
