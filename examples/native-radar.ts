/**
 * Native multi-source radar — product spine demo.
 * MultiSourceRadar + ListingStore + identity + OrderbookFeed (native).
 *
 *   npx tsx examples/native-radar.ts
 *   npx tsx examples/native-radar.ts --no-me
 *   npx tsx examples/native-radar.ts --courtyard
 */
import {
  MultiSourceRadar,
  createDefaultProviders,
  createCollectorCryptProvider,
  CollectorCryptBidsProvider,
  MagicEdenBidsProvider,
  OrderbookFeed,
} from "../src/index.js";

async function main(): Promise<void> {
  const skipMe = process.argv.includes("--no-me");
  const useAll = process.argv.includes("--all");
  const useCy = process.argv.includes("--courtyard") || useAll;

  // DEFAULT: collectorcrypt + magiceden. --all = CC+Courtyard+Beezie+Renaiss+DYLI (+ME).
  let providers = createDefaultProviders({
    all: useAll,
    courtyard: useCy,
    magiceden: skipMe ? false : undefined,
  });
  if (providers.length === 0) providers = [createCollectorCryptProvider()];

  const filter = { tcg: "pokemon" as const, limit: 10, sort: "new" as const };
  const radar = new MultiSourceRadar({
    providers,
    filter,
  });

  const t0 = performance.now();
  const result = await radar.syncAll();
  const ms = Math.round(performance.now() - t0);

  // OrderbookFeed native: asks + optional ME offers for top mints (live SOL)
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
  const book = bookFeed.getOrderbookStore();


  console.log(
    JSON.stringify(
      {
        ok: result.totalActive > 0,
        sources: providers.map((p) => p.id),
        durationMs: ms,
        totalActive: result.totalActive,
        byProvider: result.byProvider,
        sampleListings: radar.list({ clientFilter: true }).slice(0, 3).map((l) => ({
          id: l.id,
          provider: l.provider,
          price: l.price,
          name: l.name.slice(0, 50),
          platform: l.platform,
        })),
        bidCount: book.allBids().length,
        askCount: book.allAsks().length,
        note: "MultiSourceRadar + ListingStore + OrderbookFeed (native origins)",
      },
      null,
      2,
    ),
  );
  bookFeed.stop();
  if (result.totalActive < 1) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
