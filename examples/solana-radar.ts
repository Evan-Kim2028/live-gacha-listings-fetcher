/**
 * Solana multi-source radar — one-shot timed pull + optional PollEngine loop.
 *
 * Real-time strategy (no single SSE for all origins):
 *   PollEngine parallel, minIntervalMs 15–30s per source (CC CDN s-maxage≈30).
 *   Each origin (CC / ME / Phygitals; optional Beezie Base + Solana via --beezie)
 *   is polled independently.
 *
 *   npx tsx examples/solana-radar.ts
 *   npx tsx examples/solana-radar.ts --poll
 *   npx tsx examples/solana-radar.ts --beezie --courtyard --poll --seconds 30 --interval-ms 20000
 *   npx tsx examples/solana-radar.ts --beezie --courtyard --tcg all --limit 100  # every category
 */
import {
  MultiSourceRadar,
  createSolanaProviders,
  PollEngine,
  CollectorCryptBidsProvider,
  MagicEdenBidsProvider,
  OrderbookFeed,
} from "../src/index.js";

function flagNum(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const doPoll = args.includes("--poll");
  const useBeezie = args.includes("--beezie");
  const useCourtyard = args.includes("--courtyard");
  const tcgRaw = flagStr(args, "--tcg") ?? "pokemon";
  const allCategories = tcgRaw === "all";
  const tcg = allCategories ? undefined : tcgRaw;
  const seconds = flagNum(args, "--seconds") ?? 30;
  // 15–30s per source; default 20s for Solana real-time
  const intervalMs = flagNum(args, "--interval-ms") ?? 20_000;
  const limit = flagNum(args, "--limit") ?? 15;

  const providers = createSolanaProviders({
    includeBeezie: useBeezie,
    includeBeezieSolana: useBeezie,
    courtyard: useCourtyard,
    beezieAllCategories: allCategories,
  });
  const filter = {
    ...(tcg ? { tcg: tcg as "pokemon" } : {}),
    limit,
    sort: "new" as const,
  };
  const radar = new MultiSourceRadar({ providers, filter });

  // --- One-shot timed total pull ---
  const t0 = performance.now();
  const result = await radar.syncAll();
  const oneShotMs = Math.round(performance.now() - t0);

  const hasMe = providers.some((p) => p.id === "magiceden");
  const bookFeed = new OrderbookFeed({
    listingStore: radar.store,
    listingFilter: filter,
    native: true,
    bidsProvider: [
      new CollectorCryptBidsProvider(),
      ...(hasMe ? [new MagicEdenBidsProvider({ sampleMints: 8 })] : []),
    ],
  });
  await bookFeed.start();

  let pollTicks = 0;
  let pollDurationMs = 0;

  // --- Optional PollEngine: parallel per-source, minInterval 15–30s ---
  if (doPoll) {
    const poll = new PollEngine({
      store: radar.store,
      providers,
      filter,
      minIntervalMs: intervalMs,
      tickMs: Math.min(5_000, intervalMs),
      parallel: true,
      onSync: (id, r) => {
        pollTicks += 1;
        bookFeed.refreshAsks();
        if (process.env.DEBUG) {
          console.error(
            `[solana-poll] ${id} upserted=${r.upserted} active=${r.activeCount}`,
          );
        }
      },
    });
    const p0 = performance.now();
    poll.start();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    poll.stop();
    pollDurationMs = Math.round(performance.now() - p0);
  }

  const book = bookFeed.getOrderbookStore();
  bookFeed.stop();


  console.log(
    JSON.stringify(
      {
        ok: result.totalActive > 0,
        mode: doPoll ? "one-shot+poll" : "one-shot",
        sources: providers.map((p) => p.id),
        filter,
        oneShotMs,
        totalActive: result.totalActive,
        byProvider: result.byProvider,
        errors: result.errors,
        ...(doPoll
          ? {
              pollSeconds: seconds,
              minIntervalMs: intervalMs,
              parallel: true,
              pollTicks,
              pollDurationMs,
              afterPollActive: radar.store.size(),
            }
          : {}),
        sampleListings: radar
          .list({ clientFilter: true })
          .slice(0, 3)
          .map((l) => ({
            id: l.id,
            provider: l.provider,
            platform: l.platform,
            market: l.market,
            price: l.price,
            name: l.name.slice(0, 50),
          })),
        bidCount: book.allBids().length,
        askCount: book.allAsks().length,
        note:
          "Solana: PollEngine parallel minInterval 15–30s per origin",
      },
      null,
      2,
    ),
  );
  if (result.totalActive < 1) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
