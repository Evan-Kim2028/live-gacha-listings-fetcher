/**
 * Accuracy + speed verification vs live traded.gg radar + SSE.
 * Run: npx tsx examples/stream-accuracy.ts
 */
import {
  ListingStore,
  createTradedGgProvider,
  normalizeTradedRow,
  syncOnce,
  ListingsFeed,
  listingId,
  type TradedRadarRow,
} from "../src/index.js";

async function main(): Promise<void> {
  const report: Record<string, unknown> = { ok: false };

  // --- 1) Snapshot field accuracy ---
  const store = new ListingStore();
  const provider = createTradedGgProvider();
  const t0 = performance.now();
  const snap = await syncOnce(store, provider, {
    limit: 50,
    sort: "new",
    shortCircuitOnBuiltAt: false,
  });
  const snapMs = Math.round(performance.now() - t0);

  // Re-fetch raw for comparison
  const rawRes = await fetch(
    "https://www.traded.gg/api/radar?limit=50&sort=new",
    { headers: { Accept: "application/json", "User-Agent": "traded-listings-accuracy/0.2" } },
  );
  const raw = (await rawRes.json()) as {
    builtAt?: string;
    rows?: TradedRadarRow[];
  };
  const rawById = new Map(
    (raw.rows ?? []).map((r) => [
      listingId({
        provider: "tradedgg",
        platform: r.platform,
        nativeId: r.instance_id,
      }),
      r,
    ]),
  );

  let matched = 0;
  let priceMatch = 0;
  let fieldMismatches = 0;
  for (const l of store.list("tradedgg")) {
    const r = rawById.get(l.id);
    if (!r) continue;
    matched += 1;
    const n = normalizeTradedRow(r);
    if (n.price === l.price && n.id === l.id) priceMatch += 1;
    if (
      n.price !== r.price ||
      n.nativeId !== r.instance_id ||
      n.platform !== r.platform ||
      (r.fmv != null && n.fmv !== r.fmv)
    ) {
      fieldMismatches += 1;
    }
  }

  report.snapshot = {
    snapMs,
    fetched: snap.fetched,
    builtAt: snap.builtAt,
    rawBuiltAt: raw.builtAt,
    matched,
    priceMatch,
    fieldMismatches,
    priceOkRate: matched ? priceMatch / matched : 0,
  };

  // --- 2) Stream for ~25s ---
  const feedStore = new ListingStore();
  const events: string[] = [];
  const feed = new ListingsFeed({
    store: feedStore,
    snapshotQuery: { limit: 30, sort: "new" },
    snapshotIntervalMs: 120_000,
    onEvent: (ev) => {
      if (ev.kind === "upsert" || ev.kind === "close" || ev.kind === "status") {
        events.push(ev.kind === "status" ? `status:${ev.status}` : ev.kind);
      }
    },
  });

  const tStream = performance.now();
  await feed.start();
  await new Promise((r) => setTimeout(r, 25_000));
  const stats = feed.getStats();
  feed.stop();
  const streamMs = Math.round(performance.now() - tStream);

  // lag: for any upsert with listedAt, measure wall - listedAt
  let minLag: number | null = null;
  // re-scan via inject path not available; use store listedAt vs now
  const now = Date.now();
  for (const l of feedStore.list("tradedgg")) {
    if (!l.listedAt) continue;
    const lag = (now - Date.parse(l.listedAt)) / 1000;
    if (Number.isFinite(lag) && lag >= 0) {
      minLag = minLag == null ? lag : Math.min(minLag, lag);
    }
  }

  report.stream = {
    streamMs,
    stats,
    eventSample: events.slice(0, 40),
    upserts: stats.upserts,
    closes: stats.closes,
    storeSize: feedStore.size(),
    minListedAtLagSec: minLag,
  };

  const ok =
    matched >= 1 &&
    fieldMismatches === 0 &&
    priceMatch === matched &&
    (stats.upserts + stats.closes > 0 || stats.snapshots >= 1);

  report.ok = ok;
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
