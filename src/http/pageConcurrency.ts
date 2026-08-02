/**
 * Concurrent pagination with adaptive concurrency and backoff.
 * Cold bootstrap page walks (CC / ME / Phygitals). Measured full cold
 * (Solana pokemon ~21k rows): ~28s concurrent vs ~74s sequential
 * (docs/BOOTSTRAP_FULL_BOOK.md; npx tsx examples/bench-cold-compare.ts).
 */

export interface AdaptiveConcurrencyOptions {
  /** Starting in-flight limit (default 8). */
  start?: number;
  /** Floor (default 2). */
  min?: number;
  /** Ceiling (default 16). */
  max?: number;
  /** Successes at current level before +1 concurrency (default 3). */
  successesBeforeBump?: number;
}

/** In-flight page limit: half on throttle, slow ramp on success. */
export class AdaptiveConcurrency {
  current: number;
  readonly min: number;
  readonly max: number;
  private readonly successesBeforeBump: number;
  private successStreak = 0;

  constructor(opts: AdaptiveConcurrencyOptions = {}) {
    this.min = Math.max(1, opts.min ?? 2);
    this.max = Math.max(this.min, opts.max ?? 16);
    this.current = Math.min(
      this.max,
      Math.max(this.min, opts.start ?? 8),
    );
    this.successesBeforeBump = Math.max(1, opts.successesBeforeBump ?? 3);
  }

  onSuccess(): void {
    this.successStreak += 1;
    if (this.successStreak >= this.successesBeforeBump) {
      this.successStreak = 0;
      if (this.current < this.max) this.current += 1;
    }
  }

  onThrottle(): void {
    this.successStreak = 0;
    this.current = Math.max(this.min, Math.floor(this.current / 2));
  }
}

export function isThrottleError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|rate.?limit|too many|503|502|ECONNRESET|ETIMEDOUT|timeout/i.test(
    msg,
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface MapLimitAdaptiveOptions {
  concurrency?: AdaptiveConcurrencyOptions;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface MapLimitAdaptiveStats {
  items: number;
  ok: number;
  throttles: number;
  peakConcurrency: number;
  finalConcurrency: number;
  wallMs: number;
}

/**
 * mapLimit with adaptive concurrency and per-item throttle retry/backoff.
 * Preserves result order. Worker count follows AdaptiveConcurrency.
 */
export async function mapLimitAdaptive<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  opts: MapLimitAdaptiveOptions = {},
): Promise<{ results: R[]; stats: MapLimitAdaptiveStats }> {
  const t0 = performance.now();
  const adaptive = new AdaptiveConcurrency(opts.concurrency);
  if (items.length === 0) {
    return {
      results: [],
      stats: {
        items: 0,
        ok: 0,
        throttles: 0,
        peakConcurrency: 0,
        finalConcurrency: adaptive.current,
        wallMs: 0,
      },
    };
  }

  const sleep = opts.sleep ?? defaultSleep;
  const baseBackoff = opts.baseBackoffMs ?? 400;
  const maxBackoff = opts.maxBackoffMs ?? 15_000;
  const maxRetries = opts.maxRetries ?? 5;

  const out: R[] = new Array(items.length);
  let next = 0;
  let ok = 0;
  let throttles = 0;
  let peak = 0;
  const running = new Set<Promise<void>>();

  async function runOne(index: number): Promise<void> {
    const item = items[index]!;
    let attempt = 0;
    while (true) {
      try {
        out[index] = await fn(item, index);
        adaptive.onSuccess();
        ok += 1;
        return;
      } catch (err) {
        if (!isThrottleError(err) || attempt >= maxRetries) throw err;
        throttles += 1;
        adaptive.onThrottle();
        const delay = Math.min(maxBackoff, baseBackoff * 2 ** attempt);
        attempt += 1;
        await sleep(delay);
      }
    }
  }

  while (next < items.length || running.size > 0) {
    while (running.size < adaptive.current && next < items.length) {
      const i = next++;
      peak = Math.max(peak, running.size + 1);
      const p: Promise<void> = runOne(i).finally(() => {
        running.delete(p);
      });
      running.add(p);
    }
    if (running.size === 0) break;
    await Promise.race(running);
  }

  return {
    results: out,
    stats: {
      items: items.length,
      ok,
      throttles,
      peakConcurrency: peak,
      finalConcurrency: adaptive.current,
      wallMs: Math.round(performance.now() - t0),
    },
  };
}

export interface PageChunk<T> {
  listings: T[];
  /** True if origin may have another page after this one. */
  full: boolean;
}

export interface PaginateConcurrentOptions<T> {
  maxPages: number;
  /** First page (sequential). notModified short-circuits the whole walk. */
  fetchFirst: () => Promise<
    PageChunk<T> & {
      notModified?: boolean;
      /** 1-based total pages when origin provides it (CC). */
      knownTotalPages?: number | null;
    }
  >;
  /**
   * Remaining pages by 0-based index (1 = second page).
   * Called only for indices 1 .. planEnd-1.
   */
  fetchPage: (pageIndex: number) => Promise<PageChunk<T>>;
  concurrency?: AdaptiveConcurrencyOptions;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PaginateConcurrentResult<T> {
  listings: T[];
  pagesFetched: number;
  hasMore: boolean;
  notModified: boolean;
  stats: MapLimitAdaptiveStats & { firstPageMs: number };
}

/**
 * Page 0 sequential (discover total / hasMore), then concurrent remaining
 * pages with adaptive concurrency and backoff.
 */
export async function paginateConcurrent<T>(
  opts: PaginateConcurrentOptions<T>,
): Promise<PaginateConcurrentResult<T>> {
  const tFirst = performance.now();
  const first = await opts.fetchFirst();
  const firstPageMs = Math.round(performance.now() - tFirst);

  if (first.notModified) {
    return {
      listings: [],
      pagesFetched: 0,
      hasMore: false,
      notModified: true,
      stats: {
        items: 0,
        ok: 0,
        throttles: 0,
        peakConcurrency: 0,
        finalConcurrency: 0,
        wallMs: firstPageMs,
        firstPageMs,
      },
    };
  }

  if (!first.full || opts.maxPages <= 1) {
    return {
      listings: first.listings,
      pagesFetched: 1,
      hasMore: Boolean(first.full && opts.maxPages <= 1),
      notModified: false,
      stats: {
        items: 0,
        ok: 0,
        throttles: 0,
        peakConcurrency: 0,
        finalConcurrency: 0,
        wallMs: firstPageMs,
        firstPageMs,
      },
    };
  }

  const known =
    first.knownTotalPages != null && first.knownTotalPages > 0
      ? Math.floor(first.knownTotalPages)
      : null;

  const listings = [...first.listings];
  let pagesFetched = 1;
  let lastFull = true;
  let totalThrottles = 0;
  let totalOk = 0;
  let totalItems = 0;
  let peak = 0;
  let finalConc = 0;
  let restWall = 0;

  const adaptOpts = {
    concurrency: opts.concurrency,
    baseBackoffMs: opts.baseBackoffMs,
    maxBackoffMs: opts.maxBackoffMs,
    maxRetries: opts.maxRetries,
    sleep: opts.sleep,
  };

  if (known != null) {
    // Known total (CC-style): fan out remaining pages 1..planEnd-1 at once
    const planEnd = Math.min(opts.maxPages, known);
    const indices: number[] = [];
    for (let i = 1; i < planEnd; i++) indices.push(i);
    if (indices.length > 0) {
      const { results, stats } = await mapLimitAdaptive(
        indices,
        (pageIndex) => opts.fetchPage(pageIndex),
        adaptOpts,
      );
      totalThrottles += stats.throttles;
      totalOk += stats.ok;
      totalItems += stats.items;
      peak = Math.max(peak, stats.peakConcurrency);
      finalConc = stats.finalConcurrency;
      restWall += stats.wallMs;
      for (const r of results) {
        listings.push(...r.listings);
        pagesFetched += 1;
        lastFull = r.full;
        if (!r.full) break;
      }
    }
  } else {
    // Open-ended (ME-style): small waves so we don't fan out past a short page.
    // Cap wave at 3 unless caller raises start (known-total path is unbounded fan-out).
    const waveSize = Math.max(
      1,
      Math.min(
        3,
        opts.concurrency?.start ?? DEFAULT_PAGE_CONCURRENCY.start ?? 6,
      ),
    );
    let next = 1;
    while (lastFull && next < opts.maxPages) {
      const wave: number[] = [];
      for (
        let i = 0;
        i < waveSize && next + i < opts.maxPages;
        i++
      ) {
        wave.push(next + i);
      }
      if (wave.length === 0) break;
      const { results, stats } = await mapLimitAdaptive(
        wave,
        (pageIndex) => opts.fetchPage(pageIndex),
        adaptOpts,
      );
      totalThrottles += stats.throttles;
      totalOk += stats.ok;
      totalItems += stats.items;
      peak = Math.max(peak, stats.peakConcurrency);
      finalConc = stats.finalConcurrency;
      restWall += stats.wallMs;
      let stop = false;
      for (const r of results) {
        listings.push(...r.listings);
        pagesFetched += 1;
        lastFull = r.full;
        if (!r.full) {
          stop = true;
          break;
        }
      }
      if (stop) break;
      next += wave.length;
    }
  }

  const hasMore =
    lastFull &&
    (pagesFetched >= opts.maxPages ||
      (known != null && pagesFetched < known));

  return {
    listings,
    pagesFetched,
    hasMore,
    notModified: false,
    stats: {
      items: totalItems,
      ok: totalOk,
      throttles: totalThrottles,
      peakConcurrency: peak,
      finalConcurrency: finalConc,
      wallMs: firstPageMs + restWall,
      firstPageMs,
    },
  };
}

/** Default concurrency for cold bootstrap page walks. */
/** Adaptive page fan-out — capped to bound peak RAM during multi-page pulls. */
export const DEFAULT_PAGE_CONCURRENCY: AdaptiveConcurrencyOptions = {
  start: 6,
  min: 2,
  max: 12,
  successesBeforeBump: 3,
};
