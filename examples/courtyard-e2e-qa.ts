/**
 * Courtyard end-to-end QA run: bootstrap full pokemon book → quality checks →
 * curation → warm poll with delist cleanup. Emits a JSON report.
 *
 *   npx tsx examples/courtyard-e2e-qa.ts                          # full run
 *   npx tsx examples/courtyard-e2e-qa.ts --seconds 30             # shorter warm poll
 *   npx tsx examples/courtyard-e2e-qa.ts --watch 'charizard,umbreon'
 *   npx tsx examples/courtyard-e2e-qa.ts --offline                # fixture path only
 *
 * Report: data/runs/courtyard-e2e-<iso>/report.json
 * Book:   data/books/courtyard-pokemon/ (snapshot.json + meta.json)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  MultiSourceRadar,
  PollEngine,
  ListingStore,
  createCourtyardProvider,
  saveBook,
  isStale,
  querySignature,
} from "../src/index.js";
import type { Listing } from "../src/types.js";

function flagNum(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

function flagStr(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

const args = process.argv.slice(2);
const offline = args.includes("--offline");
const warmSeconds = flagNum(args, "--seconds") ?? 60;
const intervalMs = flagNum(args, "--interval-ms") ?? 20_000;
const watchCsv = flagStr(args, "--watch") ?? "charizard,umbreon,eevee";
const outDir = resolve(flagStr(args, "--out") ?? join("data", "runs", `courtyard-e2e-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`));

const FILTER = { tcg: "pokemon" as const, sort: "new" as const };
const BOOK_DIR = resolve(flagStr(args, "--book-out") ?? "data/books/courtyard-pokemon");

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function main(): Promise<void> {
  const provider = createCourtyardProvider();
  const radar = new MultiSourceRadar({ providers: [provider], filter: FILTER });
  const report: Record<string, unknown> = {
    ts: new Date().toISOString(),
    filter: FILTER,
    source: "courtyard (Algolia marketplace_prod_recently_listed, Polygon)",
  };

  // ── Phase 1: bootstrap full book ──────────────────────────────────────────
  const t0 = performance.now();
  const cold = await radar.bootstrapAll({ maxPages: 60 });
  const rows = radar.list({ clientFilter: true });
  report.phase1_bootstrap = {
    durationMs: Math.round(performance.now() - t0),
    fetched: cold.totalActive,
    byProvider: cold.byProvider,
    errors: cold.errors,
    rowsInStore: rows.length,
    uniqueIds: new Set(rows.map((l) => l.id)).size,
    metaTotal: radar.store.getMeta("courtyard", querySignature(FILTER))?.total ?? null,
  };

  // ── Phase 2: quality checks ───────────────────────────────────────────────
  const n = rows.length;
  const field = (fn: (l: Listing) => unknown) =>
    rows.filter((l) => fn(l) != null && fn(l) !== "" && fn(l) !== 0).length;
  const prices = rows.map((l) => l.price).filter((p) => Number.isFinite(p));
  const fmvs = rows.filter((l) => l.fmv != null && l.fmv > 0).map((l) => l.fmv!);
  const deltas = rows
    .filter((l) => l.delta != null && Number.isFinite(l.delta))
    .map((l) => l.delta!);
  const anomalies = rows
    .filter((l) => l.fmv != null && l.fmv > 0 && l.price > l.fmv * 10)
    .sort((a, b) => b.price - a.price);
  const byDay: Record<string, number> = {};
  for (const l of rows) {
    const d = (l.listedAt ?? "").slice(0, 10);
    if (d) byDay[d] = (byDay[d] ?? 0) + 1;
  }
  const days = Object.keys(byDay).sort();
  const stale = rows.filter((l) => isStale(l, 7 * 24 * 3600 * 1000)).length;
  report.phase2_quality = {
    rows: n,
    fieldCoverage: {
      name: field((l) => l.name),
      priceGt0: prices.filter((p) => p > 0).length,
      currency: field((l) => l.currency),
      externalUrl: field((l) => l.externalUrl),
      imageUrl: field((l) => l.imageUrl),
      listedAt: field((l) => l.listedAt),
      tcg: rows.filter((l) => l.tcg === "pokemon").length,
      grader: field((l) => l.grader),
      grade: field((l) => l.grade),
      setRaw: field((l) => l.setRaw),
      year: field((l) => l.year),
      cardNumber: field((l) => l.cardNumber),
    },
    price: {
      min: prices.length ? Math.min(...prices) : null,
      max: prices.length ? Math.max(...prices) : null,
      mean: prices.length ? Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100 : null,
      median: median(prices),
      bucket_under10: prices.filter((p) => p < 10).length,
      bucket_10_100: prices.filter((p) => p >= 10 && p <= 100).length,
      bucket_over100: prices.filter((p) => p > 100).length,
    },
    fmv: {
      coverage: fmvs.length,
      mean: fmvs.length ? Math.round((fmvs.reduce((a, b) => a + b, 0) / fmvs.length) * 100) / 100 : null,
    },
    delta: {
      coverage: deltas.length,
      mean: deltas.length ? Math.round((deltas.reduce((a, b) => a + b, 0) / deltas.length) * 100) / 100 : null,
      median: median(deltas),
      underpriced_gt20pct: deltas.filter((d) => d < -20).length,
      overpriced_gt20pct: deltas.filter((d) => d > 20).length,
    },
    anomalies: {
      priceGt10xFMV: anomalies.length,
      sample: anomalies.slice(0, 5).map((l) => ({
        name: l.name,
        price: l.price,
        fmv: l.fmv,
        delta: l.delta,
        url: l.externalUrl,
      })),
    },
    freshness: {
      listedToday: byDay[days[days.length - 1] ?? ""] ?? 0,
      listedLast7d: rows.filter((l) => {
        const t = l.listedAt ? new Date(l.listedAt).getTime() : 0;
        return Date.now() - t < 7 * 24 * 3600 * 1000;
      }).length,
      stale7d: stale,
      dateSpan: days.length ? `${days[0]} → ${days[days.length - 1]}` : null,
    },
    duplicates: n - new Set(rows.map((l) => l.id)).size,
  };

  // Identity stability: re-pull page 0 twice → same ids, same order sample
  const p1 = await provider.pull({ tcg: "pokemon", limit: 50, offset: 0 });
  const p2 = await provider.pull({ tcg: "pokemon", limit: 50, offset: 0 });
  report.phase2_identity_stability = {
    page0Ids: p1.listings.map((l) => l.id),
    stable: JSON.stringify(p1.listings.map((l) => l.id)) === JSON.stringify(p2.listings.map((l) => l.id)),
    page0Priced: p1.listings.filter((l) => l.price > 0).length,
  };

  // ── Phase 3: curation ─────────────────────────────────────────────────────
  const watchNames = watchCsv.split(",").map((s) => s.trim()).filter(Boolean);
  const curated = rows.filter((l) =>
    watchNames.some((w) => l.name.toLowerCase().includes(w.toLowerCase())),
  );
  const cheap = rows.filter((l) => l.price <= 50 && l.price > 0);
  const graded = rows.filter((l) => l.grader && l.grade);
  const undervalued = [...rows]
    .filter((l) => l.delta != null)
    .sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0))
    .slice(0, 10);
  report.phase3_curation = {
    watchlist: watchNames,
    watchHits: curated.length,
    watchSample: curated.slice(0, 10).map((l) => ({
      id: l.id,
      name: l.name,
      price: l.price,
      fmv: l.fmv,
      delta: l.delta,
      grader: l.grader,
      grade: l.grade,
      set: l.setRaw,
      url: l.externalUrl,
    })),
    filters: {
      priceLte50: cheap.length,
      graded: graded.length,
    },
    topUndervaluedByDelta: undervalued.map((l) => ({
      name: l.name,
      price: l.price,
      fmv: l.fmv,
      delta: l.delta,
      url: l.externalUrl,
    })),
  };

  // ── Phase 4: warm poll + delist cleanup ───────────────────────────────────
  const delistEvents: Array<{ id: string; provider: string; reason: string }> = [];
  const pollLog: Array<{ provider: string; upserted: number; pruned: number; active: number; ms: number }> = [];
  let pollErrors: Record<string, string> = {};
  if (offline) {
    report.phase4_warm = { skipped: "offline" };
  } else {
    const poll = new PollEngine({
      store: radar.store,
      providers: [provider],
      filter: FILTER,
      minIntervalMs: intervalMs,
      tickMs: Math.min(5_000, intervalMs),
      parallel: false,
      onSync: (_id, r) => {
        pollLog.push({
          provider: r.provider,
          upserted: r.upserted,
          pruned: r.pruned,
          active: r.activeCount,
          ms: r.durationMs,
        });
        if (r.pruned > 0) {
          for (const id of r.prunedIds) {
            delistEvents.push({ id, provider: r.provider, reason: "left retrievable set" });
          }
        }
      },
      onError: (providerId, err) => {
        pollErrors[providerId] = String(err);
      },
    });
    poll.start();
    await new Promise((r) => setTimeout(r, warmSeconds * 1000));
    poll.stop();
    const finalRows = radar.list({ clientFilter: true });
    report.phase4_warm = {
      seconds: warmSeconds,
      ticks: pollLog.length,
      upsertsTotal: pollLog.reduce((a, r) => a + r.upserted, 0),
      prunesTotal: pollLog.reduce((a, r) => a + r.pruned, 0),
      delistEvents: delistEvents.slice(0, 25),
      errors: pollErrors,
      bookBefore: rows.length,
      bookAfter: finalRows.length,
      netChange: finalRows.length - rows.length,
    };
  }

  // ── Persist: book + report ────────────────────────────────────────────────
  mkdirSync(BOOK_DIR, { recursive: true });
  const bookMeta = saveBook({
    store: radar.store,
    filter: FILTER,
    providers: ["courtyard"],
    outDir: BOOK_DIR,
  });
  report.book = { dir: BOOK_DIR, meta: bookMeta };

  mkdirSync(outDir, { recursive: true });
  const reportPath = join(outDir, "report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  report.reportPath = reportPath;

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
