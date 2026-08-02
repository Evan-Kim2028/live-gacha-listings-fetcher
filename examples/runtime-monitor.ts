/**
 * Runtime monitor — PollEngine parallel + OrderbookFeed native + RunCapture.
 *
 * Captures under data/runs/<iso>/ with only real listing/book changes + soft-fails
 * (docs/RUNTIME_PROOF.md).
 *
 * Full seed + warm (recommended get-started):
 *   npx tsx examples/runtime-monitor.ts --bootstrap --solana --seconds 21600
 *   # cold bootstrapAll (paginated) → data/books/ + data/runs/… snapshots
 *   # then warm poll updates memory + disk (events/books/sold/health)
 *
 * Window / smoke:
 *   npx tsx examples/runtime-monitor.ts --offline --seconds 15
 *   npx tsx examples/runtime-monitor.ts --seconds 45 --limit 50
 *   npx tsx examples/runtime-monitor.ts --all --seconds 60 --interval-ms 20000
 *   npx tsx examples/runtime-monitor.ts --out data/runs/my-run --seconds 30
 */
import { mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MultiSourceRadar,
  PollEngine,
  ListingStore,
  DEFAULT_PROVIDER_MIN_INTERVAL_MS,
  DEFAULT_MIN_INTERVAL_MS,
  minConfiguredIntervalMs,
  createSolanaProviders,
  createDefaultProviders,
  createFixtureProvider,
  OrderbookFeed,
  FixtureBidsProvider,
  CollectorCryptBidsProvider,
  MagicEdenBidsProvider,
  RunCapture,
  traderHealthSummary,
  formatHealthHud,
  saveBook,
  loadBook,
  resolveBookDir,
  decisionFilter,
  DEFAULT_BOOK_MAX_AGE_MS,
  type ListingsProvider,
  type PullPage,
  type PullQuery,
  type SyncResult,
  type InstrumentSoldEvent,
  type DelistEvent,
} from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function flagNum(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

function flagStr(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

/** Path-safe UTC ISO for auto run directory names. */
function runIdFromDate(d = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:.]/g, "-");
}

/** Offline provider that always soft-fails (isolation proof). */
function createSoftFailProvider(id = "softfail"): ListingsProvider {
  return {
    id,
    lastError: null as string | null,
    async pull(_query: PullQuery = {}): Promise<PullPage> {
      this.lastError = `soft-fail HTTP 500 (fixture ${id})`;
      return {
        listings: [],
        hasMore: false,
        meta: {
          provider: id,
          builtAt: null,
          total: 0,
          universe: 0,
          fetchedAt: new Date().toISOString(),
          querySignature: "",
        },
      };
    },
  };
}

function buildProviders(args: string[], offline: boolean): ListingsProvider[] {
  if (offline) {
    return [
      createFixtureProvider({
        path: join(root, "fixtures", "radar-sample.json"),
        providerId: "fixture",
      }),
      createFixtureProvider({
        path: join(root, "fixtures", "radar-sample.json"),
        providerId: "fixture_b",
        builtAt: "1970-01-01T00:00:01.000Z",
      }),
      createSoftFailProvider("softfail"),
    ];
  }
  if (args.includes("--all")) {
    return createDefaultProviders({ all: true });
  }
  return createSolanaProviders();
}

function resolveRunDir(outFlag: string | undefined): string {
  const runsRoot = resolve(root, "data", "runs");
  if (!outFlag || outFlag.includes("<auto>")) {
    mkdirSync(runsRoot, { recursive: true });
    return join(runsRoot, runIdFromDate());
  }
  const abs = resolve(outFlag);
  // bare data/runs → auto child
  if (/[/\\]runs[/\\]?$/.test(abs)) {
    mkdirSync(abs, { recursive: true });
    return join(abs, runIdFromDate());
  }
  mkdirSync(dirname(abs), { recursive: true });
  return abs;
}

/** Dedupe identical soft_fail event lines (health still written every pull). */
const lastSoftFail = new Map<string, string>();

function wireSync(
  capture: RunCapture,
  store: MultiSourceRadar["store"],
  providerId: string,
  result: SyncResult,
  providers: ListingsProvider[],
): number {
  const p = providers.find((x) => x.id === providerId);
  const soft = p?.lastError ?? store.getWatermark(providerId)?.lastError ?? null;
  const wm = store.getWatermark(providerId) ?? null;
  const isSoftEmpty = Boolean(soft) && result.fetched === 0;

  if (isSoftEmpty) {
    // Health every soft pull; soft_fail event only when error text changes
    if (lastSoftFail.get(providerId) === soft) {
      capture.onHealth({
        ts: new Date().toISOString(),
        provider: providerId,
        durationMs: result.durationMs,
        shortCircuited: result.shortCircuited,
        fetched: result.fetched,
        upserted: result.upserted,
        unchanged: result.unchanged,
        pruned: result.pruned,
        activeCount: result.activeCount,
        builtAt: result.builtAt,
        querySignature: result.querySignature,
        softFail: true,
        lastError: soft,
        lastSuccessfulPullAt: wm?.lastSuccessfulPullAt ?? null,
        lastRowCount: wm?.lastRowCount,
      });
      return 0;
    }
    lastSoftFail.set(providerId, soft!);
  } else if (!soft) {
    lastSoftFail.delete(providerId);
  }

  const events = capture.onSyncResult(result, {
    softFail: isSoftEmpty,
    lastError: isSoftEmpty ? soft : null,
    watermark: wm,
  });
  let logged = 0;
  for (const ev of events) {
    console.error(`[monitor] ${ev.kind} ${JSON.stringify(ev)}`);
    logged += 1;
  }
  return logged;
}

function captureAllBooks(capture: RunCapture, orderbook: OrderbookFeed): number {
  const book = orderbook.getOrderbookStore();
  let n = 0;
  for (const key of book.instrumentKeys()) {
    const b = book.book(key);
    const ccy = b.asks[0]?.currency ?? b.bids[0]?.currency;
    const rec = capture.onBookChange({
      instrumentKey: key,
      bestBid: b.bestBid,
      bestAsk: b.bestAsk,
      spread: b.spread,
      mid: b.mid,
      currency: ccy,
    });
    if (rec) {
      console.error(
        `[monitor] book ${rec.instrumentKey} bid=${rec.bestBid} ask=${rec.bestAsk}`,
      );
      n += 1;
    }
  }
  return n;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const useAll = args.includes("--all");
  /** Full cold pullAll seed (not a single page of limit=50). */
  const bootstrap =
    args.includes("--bootstrap") ||
    args.includes("--full") ||
    args.includes("--full-seed");
  const resume = args.includes("--resume");
  const forceCold = args.includes("--force-cold");
  const seconds = flagNum(args, "--seconds") ?? 15;
  // Window mode default 15; bootstrap omits limit (walk until !hasMore / maxPages).
  // Pass --limit only if you intentionally want a cap.
  const limitFlag = flagNum(args, "--limit");
  const limit =
    limitFlag ?? (offline ? 20 : bootstrap ? undefined : 15);
  const maxPages =
    flagNum(args, "--max-pages") ??
    (offline ? 1 : bootstrap ? 500 : undefined);
  const sampleBudget = flagNum(args, "--sample") ?? 8;
  const outFlag = flagStr(args, "--out");
  const bookOutFlag = flagStr(args, "--book-out");
  const intervalOverride = flagNum(args, "--interval-ms");
  const checkpointMs =
    flagNum(args, "--checkpoint-ms") ?? (offline ? 60_000 : 300_000);
  const maxAgeMs = flagNum(args, "--max-age-ms") ?? DEFAULT_BOOK_MAX_AGE_MS;
  /** Re-pull bids every N poll ticks (0 = only at start/end). */
  const bidsEvery = flagNum(args, "--bids-every") ?? (bootstrap ? 3 : 5);

  // Decision filter: cold + warm MUST share this (no bootstrap flag in signature).
  // Full-universe bootstrap: no limit field so pullAll walks until !hasMore.
  const filter = decisionFilter({
    tcg: flagStr(args, "--tcg") ?? "pokemon",
    sort: "new",
    ...(limit != null ? { limit } : {}),
  });

  const providers = buildProviders(args, offline);
  const providerIds = providers.map((p) => p.id);
  const minIntervalMs: number | Record<string, number> =
    intervalOverride != null
      ? intervalOverride
      : offline
        ? 2_000
        : { ...DEFAULT_PROVIDER_MIN_INTERVAL_MS };
  const displayInterval =
    typeof minIntervalMs === "number"
      ? minIntervalMs
      : minConfiguredIntervalMs(minIntervalMs);
  const tickMs = Math.min(offline ? 1_000 : 5_000, displayInterval);

  const runDir = resolveRunDir(outFlag);
  const bookDir = resolveBookDir({
    filter,
    providers: providerIds,
    outDir: bookOutFlag
      ? resolve(bookOutFlag)
      : join(root, "data", "books", bootstrap ? "full-solana" : "window"),
    booksRoot: join(root, "data", "books"),
  });

  let skippedCold = false;
  let loadReason: string | undefined;
  const listingStore = new ListingStore();

  if (bootstrap && resume && !forceCold && !offline) {
    const loaded = loadBook({
      store: listingStore,
      outDir: bookDir,
      filter,
      maxAgeMs,
    });
    loadReason = loaded.reason;
    if (loaded.loaded && loaded.fresh) skippedCold = true;
  }

  const capture = RunCapture.open(runDir, {
    checkpointMs,
    meta: {
      filter,
      providers: providerIds,
      minIntervalMs,
      tickMs,
      parallel: true,
      orderbook: true,
      offline,
      sampleBudget,
      bootstrap,
      maxPages: maxPages ?? null,
      bookDir,
      skippedCold,
      loadReason: loadReason ?? null,
      libNote: bootstrap
        ? "FULL seed bootstrapAll → warm PollEngine + RunCapture + sold.jsonl"
        : "PollEngine + ListingStore + OrderbookFeed native + RunCapture",
    },
  });

  let eventLogCount = 0;
  let bookLogCount = 0;
  let soldLogCount = 0;

  // Radar with capture: syncAll/bootstrapAll applyDelistsFromSync on pruned>0
  const radar = new MultiSourceRadar({
    store: listingStore,
    providers,
    filter,
    capture,
    onDelist: (events, result) => {
      for (const d of events) {
        soldLogCount += 1;
        console.error(
          `[monitor] delist ${d.listingId} reason=${d.reason} source=${d.source}` +
            ` provider=${result.provider} lastAsk=${d.lastBestAsk} lastBid=${d.lastBestBid}` +
            (d.instrumentKey ? ` key=${d.instrumentKey}` : ""),
        );
      }
    },
  });

  // --- Cold: full bootstrap or single-page syncAll ---
  const first = skippedCold
    ? {
        results: providerIds.map((id) => ({
          provider: id,
          shortCircuited: true,
          builtAt: null,
          previousBuiltAt: null,
          querySignature: "",
          fetched: radar.store.size(id),
          upserted: 0,
          unchanged: radar.store.size(id),
          pruned: 0,
          prunedIds: [] as string[],
          activeCount: radar.store.size(id),
          durationMs: 0,
          listings: radar.store.list(id),
        })),
        totalActive: radar.store.size(),
        byProvider: Object.fromEntries(
          providerIds.map((id) => [id, radar.store.size(id)]),
        ),
        durationMs: 0,
        query: filter,
        errors: {} as Record<string, string>,
        delists: [] as DelistEvent[],
      }
    : bootstrap
      ? await radar.bootstrapAll({ maxPages })
      : await radar.syncAll();

  for (const r of first.results) {
    eventLogCount += wireSync(capture, radar.store, r.provider, r, providers);
  }
  // Delist lines already logged via radar.onDelist when pruned>0 + capture.onSold

  if (bootstrap && !skippedCold && radar.store.size() > 0) {
    saveBook({
      store: radar.store,
      filter,
      providers: providerIds,
      outDir: bookDir,
      maxAgeMs,
    });
    console.error(
      `[monitor] cold full seed saved bookDir=${bookDir} totalActive=${radar.store.size()} coldMs=${first.durationMs}`,
    );
  }
  // first.errors often duplicates soft lastError already handled via results
  for (const [id, err] of Object.entries(first.errors)) {
    if (lastSoftFail.get(id) === err) continue;
    if (first.results.some((r) => r.provider === id && r.fetched === 0)) continue;
    const wm = radar.store.getWatermark(id);
    lastSoftFail.set(id, err);
    const softEv = capture.onSyncResult(
      {
        provider: id,
        shortCircuited: false,
        builtAt: null,
        previousBuiltAt: null,
        querySignature: "",
        fetched: 0,
        upserted: 0,
        unchanged: 0,
        pruned: 0,
        prunedIds: [],
        activeCount: radar.store.size(id),
        durationMs: 0,
        listings: [],
      },
      {
        softFail: true,
        lastError: err,
        watermark: wm ?? null,
      },
    );
    for (const ev of softEv) {
      console.error(`[monitor] ${ev.kind} ${JSON.stringify(ev)}`);
      eventLogCount += 1;
    }
  }

  const hasMe = providers.some((p) => p.id === "magiceden");
  const bidsProvider = offline
    ? new FixtureBidsProvider(join(root, "fixtures", "bids-sample.json"))
    : [
        new CollectorCryptBidsProvider({
          sampleCards: sampleBudget,
          maxSample: sampleBudget,
        }),
        ...(hasMe
          ? [new MagicEdenBidsProvider({ sampleMints: sampleBudget })]
          : []),
      ];

  const orderbook = new OrderbookFeed({
    listingStore: radar.store,
    listingFilter: filter,
    native: true,
    offline,
    bidsProvider,
    onEvent: (ev) => {
      if (ev.kind === "error") {
        console.error(`[monitor] orderbook ${ev.error}`);
      }
    },
  });
  // Listings poll must continue even if bids providers throw (403/rate-limit).
  try {
    await orderbook.start();
    bookLogCount += captureAllBooks(capture, orderbook);
  } catch (e) {
    console.error(
      `[monitor] orderbook.start soft-fail: ${e instanceof Error ? e.message : e}`,
    );
  }

  let ticks = 0;
  let bidRefreshTicks = 0;
  const poll = new PollEngine({
    store: radar.store,
    providers,
    filter,
    // Warm full-book: re-walk pages so prune/sold is correct (not a single page wipe)
    pullExtras: bootstrap
      ? {
          bootstrap: true,
          ...(maxPages != null ? { maxPages } : {}),
        }
      : {},
    minIntervalMs,
    tickMs,
    parallel: true,
    // Poll-diff delist: applyDelistsFromSync when pruned>0 → onSold + book clear
    orderbook: orderbook.getOrderbookStore(),
    capture,
    onDelist: (events: DelistEvent[], result: SyncResult) => {
      for (const d of events) {
        soldLogCount += 1;
        console.error(
          `[monitor] delist ${d.listingId} reason=${d.reason} source=${d.source}` +
            ` provider=${result.provider} lastAsk=${d.lastBestAsk} lastBid=${d.lastBestBid}` +
            (d.instrumentKey ? ` key=${d.instrumentKey}` : ""),
        );
      }
    },
    onSync: (id: string, result: SyncResult) => {
      ticks += 1;
      eventLogCount += wireSync(capture, radar.store, id, result, providers);
      // Delists already applied (orderbook+capture) when pruned>0.
      // refreshAsks reconciles remaining asks; residual sold → onSold.
      const soldEv: InstrumentSoldEvent[] = orderbook.refreshAsks();
      for (const s of soldEv) {
        capture.onSold({
          instrumentKey: s.instrumentKey,
          lastBestBid: s.lastBestBid,
          lastBestAsk: s.lastBestAsk,
          currency: s.currency,
          listingIds: s.listingIds,
          reason: s.reason, // SoldReason: delisted_or_sold | ask_removed
          ts: s.at,
        });
        soldLogCount += 1;
        console.error(
          `[monitor] sold ${s.instrumentKey} reason=${s.reason}` +
            ` lastAsk=${s.lastBestAsk} lastBid=${s.lastBestBid}`,
        );
      }
      bookLogCount += captureAllBooks(capture, orderbook);
      // Persist book often enough for live ops: every 3 syncs, and immediately
      // after any prune so sold/delist removals hit disk without long lag.
      const prunedN = result.pruned ?? result.prunedIds?.length ?? 0;
      if (
        bootstrap &&
        radar.store.size() > 0 &&
        (ticks % 3 === 0 || prunedN > 0)
      ) {
        saveBook({
          store: radar.store,
          filter,
          providers: providerIds,
          outDir: bookDir,
          maxAgeMs,
        });
      }
      // Stream bids into current book over time
      if (bidsEvery > 0 && ticks % bidsEvery === 0) {
        bidRefreshTicks += 1;
        void orderbook.refreshBids().catch(() => {
          /* soft */
        });
      }
    },
    onError: (id, err) => {
      const wm = radar.store.getWatermark(id);
      const events = capture.onSyncResult(
        {
          provider: id,
          shortCircuited: false,
          builtAt: null,
          previousBuiltAt: null,
          querySignature: "",
          fetched: 0,
          upserted: 0,
          unchanged: 0,
          pruned: 0,
          prunedIds: [],
          activeCount: radar.store.size(id),
          durationMs: 0,
          listings: [],
        },
        {
          softFail: true,
          lastError: err.message,
          watermark: wm ?? null,
        },
      );
      for (const ev of events) {
        console.error(`[monitor] ${ev.kind} ${JSON.stringify(ev)}`);
        eventLogCount += 1;
      }
    },
  });

  poll.start();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  poll.stop();

  try {
    await orderbook.refreshBids();
  } catch {
    /* bids soft-empty */
  }
  bookLogCount += captureAllBooks(capture, orderbook);
  if (bootstrap && radar.store.size() > 0) {
    saveBook({
      store: radar.store,
      filter,
      providers: providerIds,
      outDir: bookDir,
      maxAgeMs,
    });
  }
  orderbook.stop();
  capture.close();

  const book = orderbook.getOrderbookStore();
  const intervalByProvider = Object.fromEntries(
    providers.map((p) => [
      p.id,
      typeof minIntervalMs === "number"
        ? minIntervalMs
        : ((minIntervalMs as Record<string, number>)[p.id] ??
          DEFAULT_MIN_INTERVAL_MS),
    ]),
  );

  const events = capture.readEvents();
  const health = capture.readHealth();
  const books = capture.readBooks();

  const traderHealth = traderHealthSummary({
    store: radar.store,
    poll,
    providerIds: providers.map((p) => p.id),
  });
  console.log(formatHealthHud(traderHealth));

  const ok = offline
    ? radar.store.size() > 0 && events.length > 0
    : radar.store.size() > 0 || first.results.some((r) => r.fetched > 0);

  console.log(
    JSON.stringify(
      {
        ok,
        offline,
        all: useAll,
        bootstrap,
        skippedCold,
        loadReason: loadReason ?? null,
        runDir,
        bookDir: bootstrap ? bookDir : null,
        sources: providers.map((p) => p.id),
        filter,
        maxPages: maxPages ?? null,
        soldLogCount,
        bidRefreshTicks,
        seconds,
        minIntervalMs: intervalByProvider,
        parallel: true,
        sampleBudget,
        firstSyncMs: first.durationMs,
        firstByProvider: first.byProvider,
        firstErrors: first.errors,
        pollTicks: ticks,
        totalActive: radar.store.size(),
        askCount: book.allAsks().length,
        bidCount: book.allBids().length,
        traderHealth: {
          at: traderHealth.at,
          totalActive: traderHealth.totalActive,
          providers: traderHealth.providers.map((r) => ({
            provider: r.provider,
            lastSuccessfulPullAt: r.lastSuccessfulPullAt,
            lastError: r.lastError,
            lastRowCount: r.lastRowCount,
            shortCircuitRate: r.shortCircuitRate,
            syncs: r.syncs,
            shortCircuits: r.shortCircuits,
            pulls: r.pulls,
            errors: r.errors,
          })),
        },
        capture: {
          eventLines: events.length,
          healthLines: health.length,
          bookLines: books.length,
          softFails: events.filter((e) => e.kind === "soft_fail").length,
          loggedChanges: eventLogCount,
          loggedBooks: bookLogCount,
        },
        note: offline
          ? "Offline fixtures + soft-fail isolation; RunCapture under data/runs"
          : useAll
            ? "PollEngine --all parallel + OrderbookFeed native bids budget + RunCapture"
            : "PollEngine createSolanaProviders parallel + OrderbookFeed native bids budget + RunCapture",
      },
      null,
      2,
    ),
  );

  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
