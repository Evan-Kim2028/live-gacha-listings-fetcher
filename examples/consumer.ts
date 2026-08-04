/**
 * Fresh consumer path: import public API only, fixture sync, assert decision fields.
 * Run: npx tsx examples/consumer.ts
 */
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ListingStore,
  createFixtureProvider,
  syncOnce,
  listingId,
} from "../src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "fixtures", "radar-sample.json");

async function main(): Promise<void> {
  const store = new ListingStore();
  const provider = createFixtureProvider({
    path: fixture,
    providerId: "fixture",
  });

  const r1 = await syncOnce(store, provider, {
    limit: 50,
    shortCircuitOnBuiltAt: false,
  });

  if (r1.listings.length < 1) {
    throw new Error("consumer: expected ≥1 listing from fixture");
  }

  for (const l of r1.listings) {
    if (!l.id || !l.platform || !(l.price > 0)) {
      throw new Error(`consumer: bad listing ${JSON.stringify(l)}`);
    }
    const expected = listingId({
      provider: l.provider,
      platform: l.platform,
      nativeId: l.nativeId,
    });
    if (l.id !== expected) {
      throw new Error(`consumer: id mismatch ${l.id} vs ${expected}`);
    }
  }

  // Idempotent second sync
  const r2 = await syncOnce(store, provider, {
    limit: 50,
    shortCircuitOnBuiltAt: false,
  });

  if (r2.activeCount !== r1.activeCount) {
    throw new Error(
      `consumer: row count changed on re-sync ${r1.activeCount} -> ${r2.activeCount}`,
    );
  }

  // Short-circuit path
  const r3 = await syncOnce(store, provider, {
    limit: 50,
    shortCircuitOnBuiltAt: true,
  });
  if (!r3.shortCircuited) {
    throw new Error("consumer: expected builtAt short-circuit on third sync");
  }

  const platforms = new Set(r1.listings.map((l) => l.platform));
  console.log(
    JSON.stringify(
      {
        ok: true,
        activeCount: r1.activeCount,
        platforms: [...platforms],
        sampleIds: r1.listings.slice(0, 3).map((l) => l.id),
        doubleSyncActiveCount: r2.activeCount,
        shortCircuited: r3.shortCircuited,
        durationMs: r1.durationMs,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
