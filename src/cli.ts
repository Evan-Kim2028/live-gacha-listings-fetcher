#!/usr/bin/env node
/**
 * CLI — default product path is native multi-source radar (CC + ME).
 *
 * Poll: PollEngine / PollScheduler — multi-source poll with per-provider
 * minIntervalMs (CC 30s / ME 20s / Beezie 20s by default). --all =
 * CC+Courtyard+Beezie+Renaiss+DYLI (+ME). Each origin is polled independently.
 *
 * Native origin hops in parallel are typically faster than a single
 * aggregator re-scrape hop for the same venues.
 */
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ListingStore } from "./store.js";
import { syncOnce } from "./sync.js";
import { createFixtureProvider } from "./providers/fixture.js";
import {
  getProvider,
  createDefaultProviders,
  createSolanaProviders,
} from "./providers/registry.js";
import type { ListingsProvider } from "./providers/types.js";
import type { PullQuery } from "./providers/types.js";
import type { SyncOptions } from "./sync.js";
import type { SyncResult } from "./types.js";
import {
  isWatchlistEmpty,
  loadWatchlistFile,
  mergeWatchlists,
  parseWatchlistString,
  type Watchlist,
} from "./watchlist.js";
import { listingOpenUrl } from "./trader/deepLinks.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
/** Total-row cap applied to `bootstrap` when `--limit` is omitted. */
const BOOTSTRAP_DEFAULT_LIMIT = 50_000;

function usage(): never {
  console.error(`Usage:
  traded-listings [radar|native] [--solana] [--all] [--beezie] [--tcg pokemon] [--platform cc|me] [--price-min N] [--price-max N] [--limit N] [--watch 'charizard,pikachu'] [--watch-file path] [--me|--no-me] [--courtyard] [--urls]
  traded-listings bootstrap [--solana|--all] [--beezie] [--courtyard] [--tcg pokemon] [--max-pages N] [--limit N] [--watch ...] [--watch-file path] [--resume] [--out data/books/<scope>] [--poll] [--seconds N] [--offline]
  traded-listings poll [--all] [--solana] [--beezie] [--courtyard] [--seconds N] [--interval-ms N] [--parallel] [--tcg pokemon] [--limit N] [--watch ...] [--watch-file path] [--no-me]
  traded-listings monitor [--offline] [--all] [--beezie] [--courtyard] [--seconds N] [--interval-ms N] [--out data/runs/<auto>] [--sample N]
  traded-listings sync [--live] [--limit N] [--fixture path] [--provider collectorcrypt|magiceden|courtyard|fixture]

Default command: radar (native MultiSourceRadar)
Bootstrap: cold MultiSourceRadar.bootstrapAll (pullAll + bootstrap:true) →
  persist data/books/<scope>/; --resume hydrates when snapshot is fresh.
  Optional --poll warm PollEngine on the SAME filter/signature (short-circuit on).
Poll: PollEngine parallel by default for --solana/--all; per-provider intervals
  (CC 30s, ME 20s, Beezie 20s). Logs only ticks with upserted>0 (noise reduction).
Monitor: PollEngine + OrderbookFeed native + RunCapture (data/runs/<iso>).
--all: CC + Courtyard + Beezie (Base) + Beezie Solana + Renaiss + DYLI (+ Magic Eden unless --no-me)
--beezie (with --solana): add Beezie Base (777 live pokemon listings, api.beezie.com)
  + Beezie Solana (thin, solana-api.beezie.com); without --solana it is ignored
--courtyard: add Courtyard (Polygon) — works with --solana too (cross-chain breadth)
--tcg pokemon|one_piece|all  (default pokemon; **all** = every category each venue carries —
  Beezie walks all /dropItems/categories, CC/Courtyard/Phygitals drop their category facet)
--watch / --watch-file: client watchlist (name substrings, or id:/key: prefixes; JSON file ok)
--urls: after radar JSON, print one line per listing: id\\topenUrl (deep-link only)

Examples:
  npx tsx src/cli.ts
  npx tsx src/cli.ts radar --tcg pokemon --limit 20
  npx tsx src/cli.ts radar --watch 'charizard,pikachu' --limit 50
  npx tsx src/cli.ts radar --watch-file ./watchlist.txt
  npx tsx src/cli.ts radar --limit 10 --urls
  npx tsx src/cli.ts bootstrap --solana --tcg pokemon --max-pages 2
  npx tsx src/cli.ts bootstrap --offline --resume --poll --seconds 5
  npx tsx src/cli.ts poll --seconds 35 --tcg pokemon --all
  npx tsx src/cli.ts poll --solana --seconds 45 --tcg pokemon
  npx tsx src/cli.ts monitor --offline --seconds 15
  npx tsx src/cli.ts sync --provider collectorcrypt --limit 20 --live
`);
  process.exit(2);
}

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

function buildFilter(args: string[]): PullQuery {
  const tcgRaw = flagStr(args, "--tcg");
  const filter: PullQuery = {
    // --tcg all = every category the venues carry (no category filter)
    tcg: tcgRaw && tcgRaw !== "all" ? tcgRaw : undefined,
    limit: flagNum(args, "--limit") ?? 20,
    sort: "new",
  };
  const platform = flagStr(args, "--platform");
  if (platform) filter.platform = platform;
  const priceMin = flagNum(args, "--price-min");
  if (priceMin != null) filter.priceMin = priceMin;
  const priceMax = flagNum(args, "--price-max");
  if (priceMax != null) filter.priceMax = priceMax;
  const watch = buildWatchlistFromArgs(args);
  if (watch) filter.watchlist = watch;
  return filter;
}

/** --watch 'a,b' and/or --watch-file path → merged Watchlist (or undefined). */
function buildWatchlistFromArgs(args: string[]): Watchlist | undefined {
  const parts: Watchlist[] = [];
  const csv = flagStr(args, "--watch");
  if (csv) parts.push(parseWatchlistString(csv));
  const file = flagStr(args, "--watch-file");
  if (file) parts.push(loadWatchlistFile(resolve(file)));
  if (parts.length === 0) return undefined;
  const merged = mergeWatchlists(...parts);
  return isWatchlistEmpty(merged) ? undefined : merged;
}

function buildProviders(args: string[]): ListingsProvider[] {
  if (args.includes("--solana") && !args.includes("--all")) {
    const useBeezie = args.includes("--beezie");
    const allCategories = flagStr(args, "--tcg") === "all";
    return createSolanaProviders({
      includeBeezie: useBeezie,
      includeBeezieSolana: useBeezie,
      courtyard: args.includes("--courtyard"),
      beezieAllCategories: allCategories,
    });
  }
  const useAll = args.includes("--all");
  const useCy = args.includes("--courtyard");
  const noMe = args.includes("--no-me");
  let providers = createDefaultProviders({
    all: useAll,
    courtyard: useCy || useAll,
    magiceden: noMe ? false : undefined,
    beezieAllCategories: flagStr(args, "--tcg") === "all",
  });
  // --me is default; keep for docs symmetry
  return providers;
}

async function runRadar(args: string[]): Promise<void> {
  const { MultiSourceRadar } = await import("./aggregate/MultiSourceRadar.js");
  const solana = args.includes("--solana");
  const filter = buildFilter(args);
  const finalProviders = buildProviders(args);
  const radar = new MultiSourceRadar({
    providers: finalProviders,
    filter,
    watchlist: filter.watchlist,
  });
  const r = await radar.syncAll();
  const listings = radar.list({ clientFilter: true });
  console.log(
    JSON.stringify(
      {
        ok: r.totalActive > 0,
        solana,
        sources: finalProviders.map((p) => p.id),
        filter,
        watchlist: radar.watchlist,
        totalActive: r.totalActive,
        filteredCount: listings.length,
        byProvider: r.byProvider,
        durationMs: r.durationMs,
        errors: r.errors,
        sample: listings.slice(0, 5).map((l) => ({
          id: l.id,
          provider: l.provider,
          platform: l.platform,
          price: l.price,
          name: l.name.slice(0, 48),
          openUrl: listingOpenUrl(l),
        })),
        note: solana
          ? "Solana MultiSourceRadar (createSolanaProviders) — parallel origin hops; live via poll --solana"
          : "MultiSourceRadar — parallel origin hops; live via poll",
      },
      null,
      2,
    ),
  );
  // Optional operator deep-link dump (read-only; no buy/tx).
  if (args.includes("--urls")) {
    for (const l of listings) {
      const url = listingOpenUrl(l);
      console.log(url ? `${l.id}\t${url}` : `${l.id}\t`);
    }
  }
  if (r.totalActive < 1) process.exit(1);
}

/**
 * Cold full-book bootstrap → disk snapshot under data/books/ (or --out).
 * --resume hydrates when snapshot is fresh enough; optional --poll warm path
 * reuses the same decision filter / querySignature (short-circuit on).
 */
async function runBootstrap(args: string[]): Promise<void> {
  const { MultiSourceRadar } = await import("./aggregate/MultiSourceRadar.js");
  const {
    PollEngine,
    DEFAULT_PROVIDER_MIN_INTERVAL_MS,
    minConfiguredIntervalMs,
  } = await import("./aggregate/PollEngine.js");
  const {
    saveBook,
    loadBook,
    resolveBookDir,
    decisionFilter,
    DEFAULT_BOOK_MAX_AGE_MS,
  } = await import("./book.js");
  const { querySignature } = await import("./querySignature.js");

  const offline = args.includes("--offline");
  const resume = args.includes("--resume");
  const doPoll = args.includes("--poll");
  const forceCold = args.includes("--force-cold");
  const solana = args.includes("--solana");
  const useAll = args.includes("--all");
  const maxPages = flagNum(args, "--max-pages");
  const maxAgeMs = flagNum(args, "--max-age-ms") ?? DEFAULT_BOOK_MAX_AGE_MS;
  const seconds = flagNum(args, "--seconds") ?? 10;
  const intervalOverride = flagNum(args, "--interval-ms");
  const outFlag = flagStr(args, "--out");
  const fixtureFlag = flagStr(args, "--fixture");

  // Decision filter: shared by cold + warm (no bootstrap/maxPages in signature)
  const filter = decisionFilter(buildFilter(args));
  // `--limit` is a TOTAL row cap, not a page size. A cold bootstrap wants the
  // whole book, so default it high enough not to truncate (measured full pokemon
  // book ≈ 21k rows across cc + me + phygitals); pass --limit explicitly to cap.
  if (flagNum(args, "--limit") == null && !offline) {
    filter.limit = BOOTSTRAP_DEFAULT_LIMIT;
  }

  let providers: ListingsProvider[];
  if (offline) {
    const fixPath = resolve(
      fixtureFlag ?? join(root, "fixtures", "radar-sample.json"),
    );
    providers = [
      createFixtureProvider({ path: fixPath, providerId: "fixture" }),
      createFixtureProvider({ path: fixPath, providerId: "fixture_b" }),
    ];
  } else {
    providers = buildProviders(args);
  }

  const providerIds = providers.map((p) => p.id);
  const outDir = resolveBookDir({
    filter,
    providers: providerIds,
    outDir: outFlag,
    booksRoot: join(root, "data", "books"),
  });
  const qsig = querySignature(filter);

  const radar = new MultiSourceRadar({ providers, filter });
  let skippedCold = false;
  let loadReason: string | undefined;
  let cold: {
    durationMs: number;
    byProvider: Record<string, number>;
    errors: Record<string, string>;
    totalActive: number;
  } | null = null;

  if (resume && !forceCold) {
    const loaded = loadBook({
      store: radar.store,
      outDir,
      filter,
      maxAgeMs,
    });
    loadReason = loaded.reason;
    if (loaded.loaded && loaded.fresh) {
      skippedCold = true;
    }
  }

  if (!skippedCold) {
    cold = await radar.bootstrapAll({
      maxPages: maxPages ?? (offline ? 1 : undefined),
    });
    // Persist only when we have rows (never wipe disk book with soft-fail empty)
    if (radar.store.size() > 0) {
      saveBook({
        store: radar.store,
        filter,
        providers: providerIds,
        outDir,
        maxAgeMs,
      });
    }
  }

  let pollTicks = 0;
  let changedTicks = 0;
  let pollDurationMs = 0;
  const warmShortCircuits: string[] = [];

  if (doPoll) {
    const minIntervalMs =
      intervalOverride != null
        ? intervalOverride
        : offline
          ? 1_000
          : { ...DEFAULT_PROVIDER_MIN_INTERVAL_MS };
    const displayIntervalMs =
      typeof minIntervalMs === "number"
        ? minIntervalMs
        : minConfiguredIntervalMs(minIntervalMs);
    const poll = new PollEngine({
      store: radar.store,
      providers,
      filter, // SAME decision filter / querySignature as cold
      minIntervalMs,
      tickMs: Math.min(2_000, displayIntervalMs),
      parallel: true,
      onSync: (id, result: SyncResult) => {
        pollTicks += 1;
        if (result.shortCircuited) warmShortCircuits.push(id);
        if (result.upserted > 0) changedTicks += 1;
      },
      onError: (id, err) => {
        console.error(`[bootstrap-poll] error ${id}: ${err.message}`);
      },
    });
    const p0 = performance.now();
    poll.start();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    poll.stop();
    pollDurationMs = Math.round(performance.now() - p0);
    // Re-save after warm if store non-empty
    if (radar.store.size() > 0) {
      saveBook({
        store: radar.store,
        filter,
        providers: providerIds,
        outDir,
        maxAgeMs,
      });
    }
  }

  const totalActive = radar.store.size();
  console.log(
    JSON.stringify(
      {
        ok: totalActive > 0,
        command: "bootstrap",
        skippedCold,
        resume,
        offline,
        solana,
        all: useAll,
        sources: providerIds,
        filter,
        querySignature: qsig,
        outDir,
        maxPages: maxPages ?? null,
        coldDurationMs: cold?.durationMs ?? null,
        coldByProvider: cold?.byProvider ?? null,
        coldErrors: cold?.errors ?? null,
        loadReason: loadReason ?? null,
        totalActive,
        byProvider: Object.fromEntries(
          providerIds.map((id) => [id, radar.store.size(id)]),
        ),
        ...(doPoll
          ? {
              pollSeconds: seconds,
              pollTicks,
              changedTicks,
              pollDurationMs,
              warmShortCircuits: [...new Set(warmShortCircuits)],
            }
          : {}),
        sample: radar
          .list({ clientFilter: true })
          .slice(0, 5)
          .map((l) => ({
            id: l.id,
            provider: l.provider,
            price: l.price,
            name: l.name.slice(0, 48),
            fmv: l.fmv,
          })),
        note: skippedCold
          ? "Resumed from data/books snapshot; warm poll uses same filter/signature"
          : "Cold bootstrapAll(bootstrap:true) → saved book; FMV origin-only",
      },
      null,
      2,
    ),
  );
  if (totalActive < 1) process.exit(1);
}

async function runPoll(args: string[]): Promise<void> {
  const { MultiSourceRadar } = await import("./aggregate/MultiSourceRadar.js");
  // PollScheduler is alias of PollEngine
  const {
    PollScheduler,
    DEFAULT_PROVIDER_MIN_INTERVAL_MS,
    DEFAULT_MIN_INTERVAL_MS,
    minConfiguredIntervalMs,
  } = await import("./aggregate/PollEngine.js");
  const { OrderbookFeed } = await import("./orderbook/OrderbookFeed.js");
  const { CollectorCryptBidsProvider } = await import(
    "./providers/collectorcrypt.js"
  );
  const { MagicEdenBidsProvider } = await import("./providers/magiceden.js");

  const solana = args.includes("--solana");
  const useAll = args.includes("--all");
  const filter = buildFilter(args);
  const providers = buildProviders(args);
  const seconds = flagNum(args, "--seconds") ?? (solana && !useAll ? 60 : 35);
  // Global override via --interval-ms; otherwise per-provider map (CC 30s / ME 20s / Beezie 20s).
  const intervalOverride = flagNum(args, "--interval-ms");
  const minIntervalMs =
    intervalOverride != null
      ? intervalOverride
      : { ...DEFAULT_PROVIDER_MIN_INTERVAL_MS };
  const displayIntervalMs =
    typeof minIntervalMs === "number"
      ? minIntervalMs
      : minConfiguredIntervalMs(minIntervalMs);
  // --all / --solana / --parallel → parallel origin refresh (efficiency default)
  const parallel =
    useAll || solana || args.includes("--parallel");
  const hasMe = providers.some((p) => p.id === "magiceden");

  const radar = new MultiSourceRadar({ providers, filter });
  const first = await radar.syncAll();
  console.error(
    `[poll] firstSync durationMs=${first.durationMs} totalActive=${first.totalActive} byProvider=${JSON.stringify(first.byProvider)} errors=${JSON.stringify(first.errors)}`,
  );

  // Optional ME offers for top mints; live SOL price (CoinGecko)
  const bidsProviders = [
    new CollectorCryptBidsProvider(),
    ...(hasMe ? [new MagicEdenBidsProvider({ sampleMints: 8 })] : []),
  ];
  const orderbook = new OrderbookFeed({
    listingStore: radar.store,
    listingFilter: filter,
    watchlist: filter.watchlist,
    native: true,
    bidsProvider: bidsProviders,
  });
  await orderbook.start();

  let ticks = 0;
  let changedTicks = 0;
  const syncMetrics: Array<{
    provider: string;
    upserted: number;
    activeCount: number;
    fetched: number;
    durationMs: number;
  }> = [];
  const poll = new PollScheduler({
    store: radar.store,
    providers,
    filter,
    minIntervalMs,
    tickMs: Math.min(5_000, displayIntervalMs),
    parallel,
    onSync: (id, result: SyncResult) => {
      ticks += 1;
      orderbook.refreshAsks();
      // Noise reduction: only record/log ticks with actual upserts
      if (result.upserted <= 0) return;
      changedTicks += 1;
      const row = {
        provider: id,
        upserted: result.upserted,
        activeCount: result.activeCount,
        fetched: result.fetched,
        durationMs: result.durationMs,
      };
      syncMetrics.push(row);
      console.error(
        `[poll] ${id} upserted=${result.upserted} active=${result.activeCount} durationMs=${result.durationMs}`,
      );
    },
    onError: (id, err) => {
      console.error(`[poll] error ${id}: ${err.message}`);
    },
  });
  poll.start();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  poll.stop();
  orderbook.stop();

  const intervalByProvider = Object.fromEntries(
    providers.map((p) => [
      p.id,
      typeof minIntervalMs === "number"
        ? minIntervalMs
        : (minIntervalMs[p.id] ?? DEFAULT_MIN_INTERVAL_MS),
    ]),
  );
  const book = orderbook.getOrderbookStore();
  console.log(
    JSON.stringify(
      {
        ok: radar.store.size() > 0,
        solana,
        all: useAll,
        sources: providers.map((p) => p.id),
        filter,
        firstSyncMs: first.durationMs,
        firstByProvider: first.byProvider,
        firstErrors: first.errors,
        pollTicks: ticks,
        changedTicks,
        minIntervalMs: intervalByProvider,
        parallel,
        totalActive: radar.store.size(),
        byProvider: Object.fromEntries(
          providers.map((p) => [p.id, radar.store.size(p.id)]),
        ),
        syncMetrics,
        askCount: book.allAsks().length,
        bidCount: book.allBids().length,
        sampleAsks: radar
          .list({ clientFilter: true })
          .slice(0, 3)
          .map((l) => ({
            id: l.id,
            provider: l.provider,
            price: l.price,
            name: l.name.slice(0, 40),
          })),
        note: useAll
          ? `PollScheduler multi-source --all parallel=${parallel} per-provider minInterval (CC 30s/ME 20s/Beezie 20s)`
          : solana
            ? `Solana real-time: PollScheduler parallel=${parallel} per-provider minInterval (CC 30s/ME 20s/Beezie 20s; no single SSE)`
            : `PollScheduler parallel=${parallel} per-provider minInterval — CC CDN ~30s`,
      },
      null,
      2,
    ),
  );
  if (radar.store.size() < 1) process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) usage();

  // Default product: native multi-source radar
  const known = new Set([
    "radar",
    "native",
    "bootstrap",
    "poll",
    "monitor",
    "sync",
  ]);
  const first = args[0];
  const cmd = first && known.has(first) ? first : "radar";
  const rest = first && known.has(first) ? args.slice(1) : args;

  if (cmd === "radar" || cmd === "native") {
    await runRadar(rest);
    return;
  }

  if (cmd === "bootstrap") {
    await runBootstrap(rest);
    return;
  }

  if (cmd === "poll") {
    await runPoll(rest);
    return;
  }

  if (cmd === "monitor") {
    // Same harness as npm run runtime-monitor / examples/runtime-monitor.ts
    const { spawn } = await import("node:child_process");
    const example = join(root, "examples", "runtime-monitor.ts");
    const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
    await new Promise<void>((resolvePromise, reject) => {
      const proc = spawn(process.execPath, [tsxCli, example, ...rest], {
        stdio: "inherit",
        cwd: root,
        env: process.env,
      });
      proc.on("exit", (code) => {
        if (code === 0) resolvePromise();
        else process.exit(code ?? 1);
      });
      proc.on("error", reject);
    });
    return;
  }

  if (cmd !== "sync") usage();

  const live = rest.includes("--live");
  const limit = flagNum(rest, "--limit") ?? 50;
  const fixIdx = rest.indexOf("--fixture");
  const fixture = resolve(
    fixIdx >= 0 ? rest[fixIdx + 1]! : join(root, "fixtures", "radar-sample.json"),
  );
  const provIdx = rest.indexOf("--provider");
  // Default: native collectorcrypt (live) or fixture offline
  const providerId =
    provIdx >= 0
      ? rest[provIdx + 1]!
      : fixIdx >= 0
        ? "fixture"
        : live
          ? "collectorcrypt"
          : "fixture";

  const store = new ListingStore();
  let provider: ListingsProvider;
  let options: SyncOptions;

  if (providerId === "fixture" || (!live && fixIdx >= 0 && !provIdx)) {
    provider = createFixtureProvider({ path: fixture, providerId: "fixture" });
    options = {
      limit,
      shortCircuitOnBuiltAt: false,
      fixturePath: fixture,
    };
  } else {
    provider = getProvider(providerId);
    options = {
      limit,
      sort: "new",
      shortCircuitOnBuiltAt: false,
      ...(live ? {} : fixIdx >= 0 ? { fixturePath: fixture } : {}),
    };
  }

  const result = await syncOnce(store, provider, options);
  const sample = result.listings.slice(0, 5).map((l) => ({
    id: l.id,
    platform: l.platform,
    price: l.price,
    name: l.name.slice(0, 60),
    listedAt: l.listedAt,
  }));
  console.log(
    JSON.stringify(
      {
        provider: result.provider,
        shortCircuited: result.shortCircuited,
        builtAt: result.builtAt,
        fetched: result.fetched,
        upserted: result.upserted,
        unchanged: result.unchanged,
        activeCount: result.activeCount,
        durationMs: result.durationMs,
        sample,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
