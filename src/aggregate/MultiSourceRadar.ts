/**
 * Fan out to native marketplace providers and merge into one ListingStore.
 *
 * Parallel origin pulls (CC CDN ~30s floor, ME public). Cold full-book concurrent
 * pagination ~28s vs ~74s sequential (Solana pokemon ~21k rows;
 * docs/BOOTSTRAP_FULL_BOOK.md).
 *
 * Cold full book: {@link bootstrapAll} sets `bootstrap: true` so providers
 * paginate via pullAll (docs/BOOTSTRAP_FULL_BOOK.md).
 *
 * After each provider SyncResult with `pruned > 0`, runs
 * {@link applyDelistsFromSync} (orderbook clear + optional capture sold).
 * See docs/SOLD_TAKEDOWN.md.
 *
 * Optional FMV: {@link MultiSourceRadarOptions.fmvPlugins} (default []).
 * Runs after {@link syncAll} (store write-back) and/or {@link list} with
 */
import type { RunCapture } from "../capture/RunCapture.js";
import {
  applyDelistsFromSync,
  type DelistEvent,
} from "../lifecycle/delist.js";
import type { OrderbookStore } from "../orderbook/OrderbookStore.js";
import type { PullQuery } from "../providers/types.js";
import type { ListingsProvider } from "../providers/types.js";
import {
  createDefaultProviders,
  type DefaultProvidersOptions,
} from "../providers/registry.js";
import { filterListings } from "../filter.js";
import { applyFmvPlugins } from "../fmv/applyFmvPlugins.js";
import type { FmvProvider } from "../fmv/FmvProvider.js";
import { ListingStore } from "../store.js";
import { syncOnce } from "../sync.js";
import type { Listing, SyncResult } from "../types.js";
import {
  isWatchlistEmpty,
  mergeWatchlists,
  type Watchlist,
} from "../watchlist.js";

export interface MultiSourceRadarOptions {
  store?: ListingStore;
  /** Defaults to createDefaultProviders() (collectorcrypt + magiceden). */
  providers?: ListingsProvider[];
  /**
   * Shared filter for each provider pull (best-effort server-side) and
   * list({ clientFilter: true }). Fields: tcg, platform, priceMin, priceMax.
   * Cold bootstrap and warm PollEngine must share this decision filter.
   */
  filter?: PullQuery;
  /**
   * Client watchlist: name substrings, instrument keys, mint or card ids.
   * Merged into `filter.watchlist` for list({ clientFilter: true }) and exports.
   */
  watchlist?: Watchlist;
  /** Used only when providers is omitted. */
  defaultProviderOpts?: DefaultProvidersOptions;
  /**
   * Post-sync FMV plugins (null `fmv` only; origin wins). Default `[]`.
   * Applied after {@link syncAll} / {@link bootstrapAll} (store write-back)
   * and on {@link list} with `enrichFmv: true`. No default network oracle.
   */
  fmvPlugins?: FmvProvider[];
  /**
   * Optional book for poll-diff delist after each SyncResult with pruned>0.
   * See {@link applyDelistsFromSync} / docs/SOLD_TAKEDOWN.md.
   */
  orderbook?: OrderbookStore;
  /**
   * Optional capture: pruned ids write sold.jsonl via applyDelistsFromSync.
   */
  capture?: RunCapture;
  /**
   * Fired once per provider result that produced DelistEvents (pruned>0).
   */
  onDelist?: (events: DelistEvent[], result: SyncResult) => void;
}

/** Options for {@link MultiSourceRadar.list}. */
export interface MultiSourceListOptions {
  clientFilter?: boolean;
  /** Apply radar watchlist (or override) without other client filters. */
  watchlist?: boolean | Watchlist;
  provider?: string;
  /**
   * When true, apply {@link MultiSourceRadarOptions.fmvPlugins} to the
   * returned snapshot (async). Default false: sync list, no plugin work.
   */
  enrichFmv?: boolean;
}

export interface MultiSourceSyncResult {
  /** Successful provider syncs only (failed providers omitted; see errors). */
  results: SyncResult[];
  totalActive: number;
  byProvider: Record<string, number>;
  durationMs: number;
  /** Effective query after filter merge. */
  query: PullQuery;
  /** Per-provider soft-fail messages (e.g. Phygitals 500). */
  errors: Record<string, string>;
  /**
   * Delist events from SyncResults with pruned>0
   * ({@link applyDelistsFromSync}; empty when no prunes).
   */
  delists: DelistEvent[];
}

/** Options for cold full-book fan-out ({@link MultiSourceRadar.bootstrapAll}). */
export interface BootstrapAllOptions extends PullQuery {
  /**
   * Cap multi-page pulls per provider (`PullQuery.maxPages`). With bootstrap,
   * overrides the high default page cap.
   */
  maxPages?: number;
  /**
   * Decision filter merge (same fields as syncAll extra). Set radar.filter
   * once so warm poll reuses the same signature.
   */
  filter?: PullQuery;
}

export class MultiSourceRadar {
  readonly store: ListingStore;
  readonly providers: ListingsProvider[];
  readonly filter: PullQuery;
  /** Effective watchlist (opts.watchlist and/or filter.watchlist). */
  readonly watchlist: Watchlist;
  /** FMV plugins (default empty). See {@link MultiSourceRadarOptions.fmvPlugins}. */
  readonly fmvPlugins: readonly FmvProvider[];
  private readonly orderbook?: OrderbookStore;
  private readonly capture?: RunCapture;
  private readonly onDelist?: (
    events: DelistEvent[],
    result: SyncResult,
  ) => void;

  constructor(opts: MultiSourceRadarOptions = {}) {
    this.store = opts.store ?? new ListingStore();
    this.providers =
      opts.providers ?? createDefaultProviders(opts.defaultProviderOpts);
    const base = opts.filter ?? {};
    const watchlist = mergeWatchlists(base.watchlist, opts.watchlist);
    this.watchlist = watchlist;
    this.filter = isWatchlistEmpty(watchlist)
      ? { ...base }
      : { ...base, watchlist };
    this.fmvPlugins = opts.fmvPlugins ?? [];
    this.orderbook = opts.orderbook;
    this.capture = opts.capture;
    this.onDelist = opts.onDelist;
  }

  /**
   * Pull all providers in parallel; upsert into the shared store.
   * Soft-fails per provider (`Promise.allSettled`): one origin 5xx
   * (e.g. Phygitals) does not abort siblings or wipe their scopes/watermarks.
   * Soft empty + `lastError` lands in `errors` without rejecting the fan-out;
   * prior lastSuccessfulPullAt / lastRowCount stay on the failed origin.
   * Each provider has its own query-signature scope (sources do not prune each other).
   * Filters: tcg, platform, priceMin/priceMax, sort, limit (provider best-effort).
   *
   * Each provider runs {@link syncOnce} (scoped upsert+prune). No full-store wipe.
   * Pass `bootstrap: true` and/or `maxPages` for multi-page cold fills
   * (or use {@link bootstrapAll}).
   */
  async syncAll(extra: PullQuery = {}): Promise<MultiSourceSyncResult> {
    const t0 = performance.now();
    const query = { ...this.filter, ...extra };
    const settled = await Promise.allSettled(
      this.providers.map((p) =>
        syncOnce(this.store, p, {
          ...query,
          shortCircuitOnBuiltAt: false,
        }),
      ),
    );
    const results: SyncResult[] = [];
    const errors: Record<string, string> = {};
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      const provider = this.providers[i]!;
      const id = provider.id;
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
        // Provider-level soft-fail (e.g. Phygitals 500 → empty + lastError)
        const soft = provider.lastError ?? null;
        if (soft) {
          errors[id] = soft;
          // syncOnce already marked error on soft empty; keep watermark in sync
          if (!this.store.getWatermark(id)?.lastError) {
            this.store.markProviderError(id, soft);
          }
        }
      } else {
        const reason = outcome.reason;
        const msg =
          reason instanceof Error ? reason.message : String(reason);
        errors[id] = msg;
        // syncOnce marks error before rethrow; ensure watermark if throw was external
        if (!this.store.getWatermark(id)?.lastError) {
          this.store.markProviderError(id, msg);
        }
      }
    }
    // Poll-diff delist lifecycle: after each full warm/cold apply with prunes
    const delists: DelistEvent[] = [];
    for (const r of results) {
      const prunedN = r.pruned ?? r.prunedIds?.length ?? 0;
      if (prunedN <= 0) continue;
      const events = applyDelistsFromSync(r, this.orderbook, this.capture);
      if (events.length === 0) continue;
      delists.push(...events);
      this.onDelist?.(events, r);
    }

    // Optional FMV plugins after sync (origin fmv wins; empty plugins = no-op).
    if (this.fmvPlugins.length > 0) {
      await this.applyFmvToStore();
    }

    const byProvider: Record<string, number> = {};
    for (const p of this.providers) {
      byProvider[p.id] = this.store.size(p.id);
    }
    return {
      results,
      totalActive: this.store.size(),
      byProvider,
      durationMs: Math.round(performance.now() - t0),
      query,
      errors,
      delists,
    };
  }

  /**
   * Apply {@link fmvPlugins} to store listings; write back rows whose
   * `fmv`/`delta` changed. Soft-skips plugin errors (see applyFmvPlugins).
   */
  private async applyFmvToStore(): Promise<void> {
    if (this.fmvPlugins.length === 0) return;
    const raw = this.store.list();
    if (raw.length === 0) return;
    const enriched = await applyFmvPlugins(raw, this.fmvPlugins);
    const changed: Listing[] = [];
    for (let i = 0; i < enriched.length; i++) {
      const next = enriched[i]!;
      const prev = raw[i]!;
      if (next.fmv !== prev.fmv || next.delta !== prev.delta) {
        changed.push(next);
      }
    }
    if (changed.length > 0) {
      this.store.upsertMany(changed);
    }
  }

  /**
   * Cold full-book pull: {@link syncAll} with `bootstrap: true`. Providers
   * with pullAll paginate until `!hasMore` or `maxPages` (CC / ME / Beezie /
   * Phygitals). Short-circuit forced off.
   *
   * Decision filter = radar.filter merged with opts.filter / PullQuery fields.
   * Warm {@link PollEngine} must reuse the same decision filter (not bootstrap).
   * Equivalent: `syncAll({ ...filter, bootstrap: true, maxPages })`.
   */
  async bootstrapAll(
    opts: BootstrapAllOptions = {},
  ): Promise<MultiSourceSyncResult> {
    const { filter: filterExtra, maxPages, ...pullRest } = opts;
    const query: PullQuery = {
      ...this.filter,
      ...(filterExtra ?? {}),
      ...pullRest,
      bootstrap: true,
    };
    if (maxPages != null && Number.isFinite(maxPages)) {
      query.maxPages = Math.max(1, Math.floor(maxPages));
    }
    // syncAll forces shortCircuitOnBuiltAt: false (cold apply)
    return this.syncAll(query);
  }

  /**
   * Active listings. `clientFilter: true` applies this.filter
   * (tcg/platform/price/watchlist) client-side. `watchlist: true` (or a
   * Watchlist) applies watchlist only. `enrichFmv: true` runs {@link fmvPlugins}
   * on the snapshot (async); default path is sync; empty plugins leave rows as-is.
   */
  list(opts: MultiSourceListOptions & { enrichFmv: true }): Promise<Listing[]>;
  list(opts?: MultiSourceListOptions & { enrichFmv?: false }): Listing[];
  list(
    opts?: MultiSourceListOptions,
  ): Listing[] | Promise<Listing[]> {
    const base = this.listBase(opts);
    if (opts?.enrichFmv) {
      return applyFmvPlugins(base, this.fmvPlugins);
    }
    return base;
  }

  private listBase(opts?: MultiSourceListOptions): Listing[] {
    const raw = this.store.list(opts?.provider);
    if (opts?.clientFilter) return filterListings(raw, this.filter);
    if (opts?.watchlist === true) {
      return filterListings(raw, { watchlist: this.watchlist });
    }
    if (opts?.watchlist && typeof opts.watchlist === "object") {
      return filterListings(raw, { watchlist: opts.watchlist });
    }
    return raw;
  }
}

export function describeSources(providers: ListingsProvider[]): string {
  return providers.map((p) => p.id).join(", ");
}
