import type { ListingsProvider, PullQuery } from "../providers/types.js";
import {
  createTradedGgProvider,
  type TradedGgOptions,
} from "../providers/tradedgg.js";
import type { ListingStore } from "../store.js";
import { syncOnce, type SyncOptions } from "../sync.js";
import { applyTradedDelta, STREAM_SCOPE, streamScope } from "./applyDelta.js";
import { SseParser } from "./parseSse.js";
import type {
  FeedEvent,
  FeedStats,
  FeedStatus,
  TradedStreamWire,
} from "./types.js";

export interface ListingsFeedOptions {
  store: ListingStore;
  /** Snapshot provider (default traded.gg). */
  provider?: ListingsProvider;
  /** Initial + reconcile snapshot query. */
  snapshotQuery?: PullQuery;
  baseUrl?: string;
  /** SSE path (default /api/radar/stream). */
  streamPath?: string;
  /** Full snapshot while live (default 60_000, matches traded.gg client). */
  snapshotIntervalMs?: number;
  /** Poll interval after stream never opens (default 20_000). */
  pollIntervalMs?: number;
  /** Open failures before falling back to poll (default 3). */
  openFailBeforePoll?: number;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  tradedgg?: TradedGgOptions;
  /** Called for every feed event (optional; also available via async iterator). */
  onEvent?: (ev: FeedEvent) => void;
  /** Disable live network SSE (tests); only use injectDelta / manual snapshot. */
  offline?: boolean;
}

/**
 * Streaming listings session:
 *  1. Snapshot bootstrap (correctness baseline)
 *  2. SSE deltas (new / reprice / closed) for low latency
 *  3. 60s snapshot reconcile while live
 *  4. 20s poll fallback if stream never opens
 *
 * Mirrors traded.gg Radar client first principles; store remains identity-stable.
 */
export class ListingsFeed {
  private readonly store: ListingStore;
  private readonly provider: ListingsProvider;
  private readonly snapshotQuery: PullQuery;
  private readonly baseUrl: string;
  private readonly streamPath: string;
  private readonly snapshotIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly openFailBeforePoll: number;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly offline: boolean;
  private readonly onEvent?: (ev: FeedEvent) => void;

  private status: FeedStatus = "stopped";
  private stopped = true;
  private abort: AbortController | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private openFails = 0;
  private everLive = false;
  private stats: FeedStats = {
    status: "stopped",
    snapshots: 0,
    upserts: 0,
    closes: 0,
    errors: 0,
    lastEventAt: null,
    lastBuiltAt: null,
  };

  private waiters: Array<(ev: FeedEvent) => void> = [];
  private queue: FeedEvent[] = [];

  constructor(opts: ListingsFeedOptions) {
    this.store = opts.store;
    this.provider =
      opts.provider ??
      createTradedGgProvider({
        baseUrl: opts.baseUrl,
        userAgent: opts.userAgent,
        fetchImpl: opts.fetchImpl,
        ...opts.tradedgg,
      });
    this.snapshotQuery = opts.snapshotQuery ?? {
      limit: 300,
      sort: "new",
    };
    this.baseUrl = opts.baseUrl ?? "https://www.traded.gg";
    this.streamPath = opts.streamPath ?? "/api/radar/stream";
    this.snapshotIntervalMs = opts.snapshotIntervalMs ?? 60_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 20_000;
    this.openFailBeforePoll = opts.openFailBeforePoll ?? 3;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.userAgent = opts.userAgent ?? "traded-listings/0.2 (+stream)";
    this.offline = opts.offline === true;
    this.onEvent = opts.onEvent;
  }

  getStats(): FeedStats {
    return { ...this.stats, status: this.status };
  }

  getStore(): ListingStore {
    return this.store;
  }

  /** Start feed (snapshot + stream). Idempotent if already running. */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.abort = new AbortController();
    this.setStatus("connecting");
    await this.reconcileSnapshot();
    if (this.offline) {
      this.setStatus("polling");
      return;
    }
    void this.runSseLoop();
    this.snapshotTimer = setInterval(() => {
      if (!this.stopped && this.everLive) void this.reconcileSnapshot();
    }, this.snapshotIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.abort = null;
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.snapshotTimer = null;
    this.pollTimer = null;
    this.setStatus("stopped");
  }

  /**
   * Async iterator of feed events (backpressure-friendly pull).
   * Snapshot/SSE push into an unbounded queue — consumers should drain promptly.
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<FeedEvent> {
    while (!this.stopped || this.queue.length > 0) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.stopped) return;
      const ev = await new Promise<FeedEvent>((resolve) => {
        this.waiters.push(resolve);
      });
      yield ev;
    }
  }

  /** Test / offline inject of a wire delta (respects snapshotQuery filter). */
  injectDelta(wire: TradedStreamWire): FeedEvent | null {
    const at = new Date().toISOString();
    const ev = applyTradedDelta(this.store, wire, {
      at,
      filter: this.snapshotQuery,
    });
    if (ev) this.emit(ev);
    return ev;
  }

  async reconcileSnapshot(): Promise<void> {
    try {
      const opts: SyncOptions = {
        ...this.snapshotQuery,
        // Stream live scope uses dedicated signature; snapshot uses decision query
        shortCircuitOnBuiltAt: true,
      };
      // Apply snapshot into stream scope so closed ids not in page get pruned on full replace
      // when using replace — for stream we merge snapshot rows via upsertOne then
      // optionally prune only for decision query. Here: syncOnce for decision scope,
      // plus merge into stream scope.
      const result = await syncOnce(this.store, this.provider, opts);
      const scope = streamScope(this.snapshotQuery);
      // replace filtered decision scope + mirror into stream scope
      for (const l of result.listings) {
        this.store.upsertOne(l, scope);
      }
      this.stats.snapshots += 1;
      this.stats.lastBuiltAt = result.builtAt;
      this.emit({
        kind: "snapshot",
        result,
        at: new Date().toISOString(),
      });
    } catch (e) {
      this.stats.errors += 1;
      this.emit({
        kind: "error",
        error: e instanceof Error ? e.message : String(e),
        at: new Date().toISOString(),
      });
    }
  }

  private async runSseLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.openSseOnce();
      } catch (e) {
        if (this.stopped) return;
        this.stats.errors += 1;
        this.emit({
          kind: "error",
          error: e instanceof Error ? e.message : String(e),
          at: new Date().toISOString(),
        });
      }
      if (this.stopped) return;
      this.openFails += 1;
      if (!this.everLive && this.openFails >= this.openFailBeforePoll) {
        this.enterPollMode();
        return;
      }
      this.setStatus("reconnecting");
      await sleep(Math.min(5000 * this.openFails, 15_000), this.abort?.signal);
    }
  }

  private enterPollMode(): void {
    this.setStatus("polling");
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (!this.stopped) void this.reconcileSnapshot();
    }, this.pollIntervalMs);
  }

  private async openSseOnce(): Promise<void> {
    const url = new URL(this.streamPath, this.baseUrl.endsWith("/")
      ? this.baseUrl
      : this.baseUrl + "/");
    const res = await this.fetchImpl(url.toString(), {
      headers: {
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
        "User-Agent": this.userAgent,
      },
      signal: this.abort?.signal,
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE HTTP ${res.status}`);
    }

    // first byte / open
    if (!this.everLive) {
      this.everLive = true;
      this.openFails = 0;
      this.setStatus("live");
      // reconnect snapshot like traded.gg client
      void this.reconcileSnapshot();
    } else {
      this.setStatus("live");
      this.openFails = 0;
    }

    const parser = new SseParser();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (!this.stopped) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const msg of parser.push(text)) {
        this.handleSseData(msg.data);
      }
    }
  }

  private handleSseData(data: string): void {
    try {
      const wire = JSON.parse(data) as TradedStreamWire;
      const at = new Date().toISOString();
      const ev = applyTradedDelta(this.store, wire, {
        at,
        filter: this.snapshotQuery,
      });
      if (!ev) return;
      if (ev.kind === "upsert") this.stats.upserts += 1;
      if (ev.kind === "close") this.stats.closes += 1;
      this.emit(ev);
    } catch (e) {
      this.stats.errors += 1;
      this.emit({
        kind: "error",
        error: e instanceof Error ? e.message : String(e),
        at: new Date().toISOString(),
      });
    }
  }

  private setStatus(status: FeedStatus): void {
    this.status = status;
    this.stats.status = status;
    this.emit({
      kind: "status",
      status,
      at: new Date().toISOString(),
    });
  }

  private emit(ev: FeedEvent): void {
    this.stats.lastEventAt = "at" in ev ? ev.at : new Date().toISOString();
    this.onEvent?.(ev);
    const waiter = this.waiters.shift();
    if (waiter) waiter(ev);
    else this.queue.push(ev);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

export { STREAM_SCOPE, streamScope };
