/**
 * Filtered subset pull: Pokémon only.
 * npx tsx examples/filter-pokemon.ts
 */
import {
  ListingStore,
  createTradedGgProvider,
  syncOnce,
} from "../src/index.js";

async function main(): Promise<void> {
  const store = new ListingStore();
  const result = await syncOnce(store, createTradedGgProvider(), {
    tcg: "pokemon",
    limit: 40,
    sort: "new",
    shortCircuitOnBuiltAt: false,
  });
  const rows = store.list();
  const allTcg = rows.every((l) => !l.tcg || l.tcg === "pokemon");
  console.log(
    JSON.stringify(
      {
        ok: allTcg && result.fetched > 0,
        fetched: result.fetched,
        active: result.activeCount,
        querySignature: result.querySignature,
        allTcg,
        sample: rows.slice(0, 3).map((l) => ({
          id: l.id,
          tcg: l.tcg,
          price: l.price,
          platform: l.platform,
        })),
      },
      null,
      2,
    ),
  );
  if (!allTcg || result.fetched < 1) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
