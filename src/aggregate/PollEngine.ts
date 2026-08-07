/**
 * Multi-source poll loop: stagger origins, respect minIntervalMs
 * when you poll native providers. PollScheduler is an alias of PollEngine.
 *
 * Full warm pulls with `pruned > 0` run {@link applyDelistsFromSync} (orderbook
 * clear + optional RunCapture sold) before `onSync` — docs/SOLD_TAKEDOWN.md.
 */
import type { RunCapture } from "../capture/RunCapture.js";
import {
  applyDelistsFromSync,
  type DelistEvent,
} from "../lifecycle/delist.js";
import type { OrderbookStore } from "../orderbook/OrderbookStore.js";
import type { ListingsProvider, PullQuery } from "../providers/types.js";
import type { ListingStore } from "../store.js";
import type { HistoryStore } from "../history/HistoryStore.js";
import { getMetrics } from "../http/metrics.js";
import { syncOnce, type SyncOptions } from "../sync.js";
import type { SyncResult } from "../types.js";

/** Default floor when no per-provider entry (CC CDN s-maxage≈30). */
export const DEFAULT_MIN_INTERVAL_MS = 30_000;

/**
 * Default per-provider floors: CC ~30s (CDN), ME / Beezie ~20s.
 * Missing keys use DEFAULT_MIN_INTERVAL_MS.
 */
export const DEFAULT_PROVIDER_MIN_INTERVAL_MS: Readonly<Record<string, number>> =
  {
    collectorcrypt: 30_000,
    magiceden: 20_000,
    beezie: 20_000,
  };

export type MinIntervalMs = number | Readonly<Record<string, number>>;

/** Per-provider sync counters (short-circuit rate = shortCircuits / syncs). */
export interface ProviderPollStats {
  /** Completed syncOnce results observed by this engine. */
  syncs: number;
  /** Subset of syncs with `shortCircuited: true`. */
  shortCircuits: number;
}

export type PollStatsSnapshot = Record<string, ProviderPollStats>;

export interface PollEngineOptions {
  store: ListingStore;
  providers: ListingsProvider[];
  /**
   * Decision filter (tcg/limit/sort/…); identity for store scopes.
   * Transport flags (bootstrap, maxPages) go in {@link pullExtras}.
   */
  filter?: PullQuery;
  /**
   * Merged into every syncOnce pull (e.g. `{ bootstrap: true, maxPages: 500 }`)
   * so warm full-book polls re-walk pages. Not part of querySignature
   * (bootstrap/maxPages are not decision fields).
   */
  pullExtras?: PullQuery;
  /**
   * Minimum ms between pulls per provider.
   * number: same floor for every provider (default 30_000).
   * map: per-provider floors; missing keys use DEFAULT_MIN_INTERVAL_MS.
   */
  minIntervalMs?: MinIntervalMs;
  /** Global tick ms (default 5_000). */
  tickMs?: number;
  /**
   * When true, each eligible tick pulls all due providers in parallel
   * (still respects minIntervalMs per source). Default false: round-robin.
   */
  parallel?: boolean;
  onSync?: (providerId: string, result: SyncResult) => void;
  onError?: (providerId: string, err: Error) => void;
  /**
   * Log pulls/errors/latency_ms per provider after each successful onSync.
   * Default false.
   */
  logMetrics?: boolean;
  /**
   * Optional durable price/lifecycle history (SQLite). Records new/reprice
   * per tick and closed on delists.
   */
  history?: HistoryStore;
  /**
   * Optional book for poll-diff delist: when `result.pruned > 0`,
   * {@link applyDelistsFromSync} clears asks / residual bids (docs/SOLD_TAKEDOWN.md).
   */
  orderbook?: OrderbookStore;
  /**
   * Optional capture: delists with pruned>0 write `sold.jsonl` via
   * {@link applyDelistsFromSync} (`reason: delisted_or_sold` | `ask_removed`).
   */
  capture?: RunCapture;
  /**
   * Fired after {@link applyDelistsFromSync} when the sync pruned ids
   * (empty array not emitted). Hosts log DelistEvents here.
   */
  onDelist?: (events: DelistEvent[], result: SyncResult) => void;
}

function resolveInterval(
  minIntervalMs: MinIntervalMs,
  providerId: string,
): number {
  if (typeof minIntervalMs === "number") return minIntervalMs;
  return minIntervalMs[providerId] ?? DEFAULT_MIN_INTERVAL_MS;
}

/** Smallest configured interval (tickMs / CLI display). */
export function minConfiguredIntervalMs(minIntervalMs: MinIntervalMs): number {
  if (typeof minIntervalMs === "number") return minIntervalMs;
  const vals = Object.values(minIntervalMs);
  if (vals.length === 0) return DEFAULT_MIN_INTERVAL_MS;
  return Math.min(...vals);
}

export class PollEngine {
  private readonly store: ListingStore;
  private readonly providers: ListingsProvider[];
  private readonly filter: PullQuery;
  private readonly pullExtras: PullQuery;
  private readonly minIntervalMs: MinIntervalMs;
  private readonly tickMs: number;
  private readonly parallel: boolean;
  private readonly onSync?: (providerId: string, result: SyncResult) => void;
  private readonly onError?: (providerId: string, err: Error) => void;
  private readonly logMetrics: boolean;
  private readonly orderbook?: OrderbookStore;
  private readonly capture?: RunCapture;
  private readonly history?: HistoryStore;
  private readonly onDelist?: (
    events: DelistEvent[],
    result: SyncResult,
  ) => void;
  private readonly lastPull = new Map<string, number>();
  private readonly pollStats = new Map<string, ProviderPollStats>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private tickIndex = 0;
  private inFlight = false;

  constructor(opts: PollEngineOptions) {
    this.store = opts.store;
    this.providers = opts.providers;
    this.filter = opts.filter ?? {};
    this.pullExtras = opts.pullExtras ?? {};
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.tickMs = opts.tickMs ?? 5_000;
    this.parallel = opts.parallel ?? false;
    this.onSync = opts.onSync;
    this.onError = opts.onError;
    this.logMetrics = opts.logMetrics ?? false;
    this.orderbook = opts.orderbook;
    this.capture = opts.capture;
    this.onDelist = opts.onDelist;
    this.history = opts.history;
  }

  /** Decision filter plus transport extras for a pull. */
  private pullQuery(extra: PullQuery = {}): PullQuery {
    return { ...this.filter, ...this.pullExtras, ...extra };
  }

  /** Resolved min interval for a provider id. */
  intervalFor(providerId: string): number {
    return resolveInterval(this.minIntervalMs, providerId);
  }

  /** Configured intervals (number or map as passed). */
  get configuredMinIntervalMs(): MinIntervalMs {
    return this.minIntervalMs;
  }

  /** Per-provider counters: pulls, errors, latency_ms. */
  getMetrics() {
    return getMetrics();
  }

  /**
   * Per-provider sync / short-circuit counters (trader health HUD).
   * Updated on every successful emitSync (tick or syncNow).
   */
  getPollStats(): PollStatsSnapshot {
    const out: PollStatsSnapshot = {};
    for (const [id, row] of this.pollStats) {
      out[id] = { ...row };
    }
    return out;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Immediate staggered first pull
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Force one full parallel sync (ignores interval once).
   * Soft-fails per provider (`Promise.allSettled`); one origin throw does not
   * abort siblings (same as {@link MultiSourceRadar.syncAll}).
   * Failed providers are omitted from the return array; onError fires;
   * watermarks keep lastError (syncOnce or markProviderError).
   */
  async syncNow(extra: PullQuery = {}): Promise<SyncResult[]> {
    const query = this.pullQuery(extra);
    const settled = await Promise.allSettled(
      this.providers.map((p) =>
        syncOnce(this.store, p, {
          ...query,
          shortCircuitOnBuiltAt: true,
        } as SyncOptions),
      ),
    );
    const results: SyncResult[] = [];
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!;
      const p = this.providers[i]!;
      if (outcome.status === "fulfilled") {
        this.lastPull.set(p.id, Date.now());
        this.emitSync(p.id, outcome.value);
        // Provider soft-fail (empty + lastError): ensure watermark + onError
        const soft = p.lastError ?? null;
        if (soft) {
          if (!this.store.getWatermark(p.id)?.lastError) {
            this.store.markProviderError(p.id, soft);
          }
          this.onError?.(p.id, new Error(soft));
        }
        results.push(outcome.value);
      } else {
        const reason = outcome.reason;
        const err = reason instanceof Error ? reason : new Error(String(reason));
        this.onError?.(p.id, err);
        // syncOnce marks error before rethrow; ensure watermark if external throw
        if (!this.store.getWatermark(p.id)?.lastError) {
          this.store.markProviderError(p.id, err.message);
        }
      }
    }
    return results;
  }

  private dueProviders(): ListingsProvider[] {
    const now = Date.now();
    return this.providers.filter((p) => {
      const last = this.lastPull.get(p.id) ?? 0;
      return now - last >= this.intervalFor(p.id);
    });
  }

  private notePollStats(providerId: string, result: SyncResult): void {
    let row = this.pollStats.get(providerId);
    if (!row) {
      row = { syncs: 0, shortCircuits: 0 };
      this.pollStats.set(providerId, row);
    }
    row.syncs += 1;
    if (result.shortCircuited) row.shortCircuits += 1;
  }

  private emitSync(providerId: string, result: SyncResult): void {
    this.notePollStats(providerId, result);
    // Full warm reconcile: prune → delist lifecycle before host onSync
    // (refreshAsks / capture). Soft-fail / incomplete pages have pruned=0.
    const prunedN = result.pruned ?? result.prunedIds?.length ?? 0;
    if (prunedN > 0) {
      const delists = applyDelistsFromSync(
        result,
        this.orderbook,
        this.capture,
      );
      if (delists.length > 0) {
        this.onDelist?.(delists, result);
        this.history?.recordDelists(delists);
      }
    }
    this.history?.recordSyncResult(result);
    this.history?.recordIdentities(result.listings);
    this.onSync?.(providerId, result);
    if (this.logMetrics) {
      const m = getMetrics()[providerId];
      const ps = this.pollStats.get(providerId);
      // Compact one-liner for operators / containers
      console.log(
        `[PollEngine] ${providerId} fetched=${result.fetched} durationMs=${result.durationMs}` +
          (m
            ? ` metrics={pulls:${m.pulls},errors:${m.errors},latency_ms:${m.latency_ms}}`
            : "") +
          (ps
            ? ` shortCircuit=${ps.shortCircuits}/${ps.syncs}`
            : "") +
          (prunedN > 0 ? ` pruned=${prunedN}` : ""),
      );
    }
  }

  private async pullOne(p: ListingsProvider): Promise<void> {
    try {
      const r = await syncOnce(this.store, p, {
        ...this.pullQuery(),
        shortCircuitOnBuiltAt: true,
      } as SyncOptions);
      this.lastPull.set(p.id, Date.now());
      this.emitSync(p.id, r);
    } catch (e) {
      this.onError?.(
        p.id,
        e instanceof Error ? e : new Error(String(e)),
      );
    }
  }

  private async tick(): Promise<void> {
    if (!this.running || this.providers.length === 0 || this.inFlight) return;
    this.inFlight = true;
    try {
      if (this.parallel) {
        const due = this.dueProviders();
        if (due.length === 0) return;
        // allSettled: pullOne already swallows errors, but never hard-fail the tick
        await Promise.allSettled(due.map((p) => this.pullOne(p)));
        return;
      }
      // Round-robin one provider per tick to smooth load
      const p = this.providers[this.tickIndex % this.providers.length]!;
      this.tickIndex += 1;
      const last = this.lastPull.get(p.id) ?? 0;
      if (Date.now() - last < this.intervalFor(p.id)) return;
      await this.pullOne(p);
    } finally {
      this.inFlight = false;
    }
  }
}

/** Alias: same staggered/parallel poll loop. */
export { PollEngine as PollScheduler };
export type PollSchedulerOptions = PollEngineOptions;
