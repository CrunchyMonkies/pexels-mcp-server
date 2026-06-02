/**
 * A small in-memory cache with both LRU (least-recently-used) eviction by entry
 * count and per-entry TTL (time-to-live) expiry.
 *
 * Implemented on a `Map`, which preserves insertion order: the first key is the
 * oldest. On a hit the entry is re-inserted (moved to the most-recent position);
 * once the size exceeds `maxEntries` the oldest key is evicted. Expired entries
 * are dropped lazily on access.
 *
 * `now` is injectable so tests can advance the clock deterministically.
 */
export class TtlLruCache<V> {
  private readonly store = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Mark as most-recently-used.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: V): void {
    if (this.maxEntries <= 0) return;
    // Overwrite resets recency and TTL.
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
    // Evict oldest entries beyond the size bound.
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

/** Read a positive integer from the environment, or fall back to a default. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
