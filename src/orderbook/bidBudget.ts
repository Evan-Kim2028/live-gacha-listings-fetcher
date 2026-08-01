/**
 * Shared bids-detail budget helpers: TTL cache (provider+asset/mint),
 * mapLimit concurrency, and sample cap. See docs/BIDS_BUDGET.md.
 */

export interface BidBudgetOptions {
  /** In-flight detail requests. Default 4. */
  maxConcurrent?: number;
  /** Per-key cache TTL in ms. Default 30_000. */
  ttlMs?: number;
  /** Max instruments that get a detail hop (sample cap). */
  maxSample?: number;
}

export const DEFAULT_MAX_CONCURRENT = 4;
export const DEFAULT_TTL_MS = 30_000;

/** Cache key: provider + asset/mint id. */
export function bidCacheKey(provider: string, assetOrMint: string): string {
  return `${provider}\0${assetOrMint}`;
}

export interface TtlCacheEntry<V> {
  value: V;
  /** Epoch ms when entry expires. */
  expiresAt: number;
}

/**
 * Simple process-local TTL map. Keys are opaque strings
 * (prefer {@link bidCacheKey}).
 */
export class TtlCache<V> {
  private readonly store = new Map<string, TtlCacheEntry<V>>();
  readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = Math.max(0, ttlMs);
  }

  /** Fresh value or undefined (miss / expired). ttlMs ≤ 0 ⇒ always miss. */
  get(key: string, now = Date.now()): V | undefined {
    if (this.ttlMs <= 0) return undefined;
    const e = this.store.get(key);
    if (!e) return undefined;
    if (now >= e.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return e.value;
  }

  /** True when key is present and not expired. */
  has(key: string, now = Date.now()): boolean {
    return this.get(key, now) !== undefined;
  }

  set(key: string, value: V, now = Date.now()): void {
    this.store.set(key, {
      value,
      expiresAt: now + this.ttlMs,
    });
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * mapLimit: run `fn` over items with at most `concurrency` in flight.
 * Preserves input order in the result array.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const out: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return out;
}

export interface BidBudgetRunResult<R> {
  /** One slot per input item (after maxSample slice); cache hits reuse stored value. */
  results: R[];
  cacheHits: number;
  httpCalls: number;
  sampleUsed: number;
  maxConcurrent: number;
  ttlMs: number;
}

export interface MapWithBidBudgetOptions<T, R> extends BidBudgetOptions {
  /** Stable provider id for the cache key. */
  provider: string;
  /** Asset / mint id for each item. */
  assetOf: (item: T) => string;
  /** Detail fetch (only called on cache miss). */
  fetch: (item: T, index: number) => Promise<R>;
  /** Optional shared cache; created with ttlMs when omitted. */
  cache?: TtlCache<R>;
  /** Clock override for tests. */
  now?: () => number;
}

/**
 * Apply maxSample → TTL cache → mapLimit(maxConcurrent) for detail fetches.
 * Cache hits skip `fetch` and do not count as httpCalls.
 */
export async function mapWithBidBudget<T, R>(
  items: readonly T[],
  opts: MapWithBidBudgetOptions<T, R>,
): Promise<BidBudgetRunResult<R>> {
  const maxConcurrent = Math.max(1, opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const cache = opts.cache ?? new TtlCache<R>(ttlMs);
  const nowFn = opts.now ?? Date.now;

  const capped =
    opts.maxSample !== undefined && opts.maxSample >= 0
      ? items.slice(0, opts.maxSample)
      : items.slice();
  const sampleUsed = capped.length;

  let cacheHits = 0;
  let httpCalls = 0;

  type Slot =
    | { kind: "hit"; value: R }
    | { kind: "miss"; item: T; index: number };

  const slots: Slot[] = capped.map((item, index) => {
    const key = bidCacheKey(opts.provider, opts.assetOf(item));
    const hit = cache.get(key, nowFn());
    if (hit !== undefined) {
      cacheHits += 1;
      return { kind: "hit" as const, value: hit };
    }
    return { kind: "miss" as const, item, index };
  });

  const misses = slots
    .map((s, i) => ({ s, i }))
    .filter((x): x is { s: Extract<Slot, { kind: "miss" }>; i: number } => x.s.kind === "miss");

  const fetched = await mapLimit(misses, maxConcurrent, async ({ s }) => {
    httpCalls += 1;
    const value = await opts.fetch(s.item, s.index);
    const key = bidCacheKey(opts.provider, opts.assetOf(s.item));
    cache.set(key, value, nowFn());
    return value;
  });

  const results: R[] = new Array(slots.length);
  let fi = 0;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!;
    if (s.kind === "hit") {
      results[i] = s.value;
    } else {
      results[i] = fetched[fi++]!;
    }
  }

  return {
    results,
    cacheHits,
    httpCalls,
    sampleUsed,
    maxConcurrent,
    ttlMs: cache.ttlMs,
  };
}

/** Normalize constructor-style budget knobs. */
export function resolveBidBudgetOptions(
  opts?: BidBudgetOptions,
): Required<Pick<BidBudgetOptions, "maxConcurrent" | "ttlMs">> & {
  maxSample: number | undefined;
} {
  return {
    maxConcurrent: Math.max(1, opts?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT),
    ttlMs: opts?.ttlMs ?? DEFAULT_TTL_MS,
    maxSample: opts?.maxSample,
  };
}
