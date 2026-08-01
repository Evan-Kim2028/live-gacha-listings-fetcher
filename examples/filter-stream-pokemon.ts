/**
 * Filtered live stream: only Pokémon listing updates.
 * npx tsx examples/filter-stream-pokemon.ts
 */
import { ListingStore, ListingsFeed } from "../src/index.js";

async function main(): Promise<void> {
  const store = new ListingStore();
  let upserts = 0;
  let closes = 0;
  const feed = new ListingsFeed({
    store,
    snapshotQuery: { tcg: "pokemon", limit: 30, sort: "new" },
    snapshotIntervalMs: 120_000,
    onEvent: (ev) => {
      if (ev.kind === "upsert") {
        upserts += 1;
        if (ev.listing.tcg && ev.listing.tcg !== "pokemon") {
          console.error("non-pokemon slipped through", ev.listing.id);
          process.exit(2);
        }
      }
      if (ev.kind === "close") closes += 1;
    },
  });
  await feed.start();
  await new Promise((r) => setTimeout(r, 12_000));
  const stats = feed.getStats();
  feed.stop();
  const bad = store.list().filter((l) => l.tcg && l.tcg !== "pokemon");
  console.log(
    JSON.stringify(
      {
        ok: bad.length === 0,
        stats,
        upserts,
        closes,
        active: store.size(),
        badTcg: bad.length,
      },
      null,
      2,
    ),
  );
  if (bad.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
