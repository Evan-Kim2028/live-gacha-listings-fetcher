/**
 * Cold full-book bootstrap → disk snapshot → optional warm PollEngine.
 *
 * Offline smoke (default):
 *   npx tsx examples/bootstrap-book.ts
 *   npx tsx examples/bootstrap-book.ts --offline --resume --poll --seconds 3
 *
 * Live page-limited:
 *   npx tsx examples/bootstrap-book.ts --live --solana --max-pages 1 --limit 20
 *   npx tsx examples/bootstrap-book.ts --live --solana --resume --poll --seconds 20
 *
 * No traded.gg. FMV/delta only from origin fields (no external oracle).
 */
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MultiSourceRadar,
  PollEngine,
  createSolanaProviders,
  createDefaultProviders,
  createFixtureProvider,
  saveBook,
  loadBook,
  resolveBookDir,
  decisionFilter,
  querySignature,
  DEFAULT_BOOK_MAX_AGE_MS,
  type ListingsProvider,
  type SyncResult,
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const offline = !live || args.includes("--offline");
  const resume = args.includes("--resume");
  const doPoll = args.includes("--poll");
  const forceCold = args.includes("--force-cold");
  const solana = args.includes("--solana");
  const useAll = args.includes("--all");
  const maxPages = flagNum(args, "--max-pages") ?? (offline ? 1 : 2);
  const limit = flagNum(args, "--limit") ?? (offline ? 50 : 40);
  const tcg = flagStr(args, "--tcg") ?? "pokemon";
  const maxAgeMs = flagNum(args, "--max-age-ms") ?? DEFAULT_BOOK_MAX_AGE_MS;
  const seconds = flagNum(args, "--seconds") ?? 3;
  const outFlag = flagStr(args, "--out");

  const filter = decisionFilter({
    tcg,
    limit,
    sort: "new",
  });

  let providers: ListingsProvider[];
  if (offline) {
    const fix = join(root, "fixtures", "radar-sample.json");
    providers = [
      createFixtureProvider({ path: fix, providerId: "fixture" }),
      createFixtureProvider({ path: fix, providerId: "fixture_b" }),
    ];
  } else if (solana) {
    providers = createSolanaProviders();
  } else if (useAll) {
    providers = createDefaultProviders({ all: true });
  } else {
    providers = createDefaultProviders();
  }

  const providerIds = providers.map((p) => p.id);
  const outDir = resolveBookDir({
    filter,
    providers: providerIds,
    outDir: outFlag
      ? resolve(outFlag)
      : join(root, "data", "books", "example-bootstrap"),
  });
  const qsig = querySignature(filter);

  const radar = new MultiSourceRadar({ providers, filter });
  let skippedCold = false;
  let loadReason: string | undefined;
  let coldMs: number | null = null;
  let coldBy: Record<string, number> | null = null;
  let coldErrors: Record<string, string> | null = null;

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
    const t0 = performance.now();
    const cold = await radar.bootstrapAll({ maxPages });
    coldMs = Math.round(performance.now() - t0);
    coldBy = cold.byProvider;
    coldErrors = cold.errors;
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
  let shortCircuitHits = 0;
  let pollDurationMs = 0;

  if (doPoll) {
    const poll = new PollEngine({
      store: radar.store,
      providers,
      filter, // identical decision filter → same querySignature scopes
      minIntervalMs: offline ? 500 : 15_000,
      tickMs: offline ? 500 : 5_000,
      parallel: true,
      onSync: (_id, result: SyncResult) => {
        pollTicks += 1;
        if (result.shortCircuited) shortCircuitHits += 1;
      },
    });
    const p0 = performance.now();
    poll.start();
    await new Promise((r) => setTimeout(r, seconds * 1000));
    poll.stop();
    pollDurationMs = Math.round(performance.now() - p0);
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

  const usedTradedGg = providerIds.includes("tradedgg");
  const totalActive = radar.store.size();
  const ok = totalActive > 0 && !usedTradedGg;

  console.log(
    JSON.stringify(
      {
        ok,
        mode: offline ? "offline-fixture" : "live",
        skippedCold,
        sources: providerIds,
        filter,
        querySignature: qsig,
        outDir,
        maxPages,
        coldMs,
        coldByProvider: coldBy,
        coldErrors,
        loadReason: loadReason ?? null,
        totalActive,
        byProvider: Object.fromEntries(
          providerIds.map((id) => [id, radar.store.size(id)]),
        ),
        ...(doPoll
          ? {
              pollSeconds: seconds,
              pollTicks,
              shortCircuitHits,
              pollDurationMs,
            }
          : {}),
        sample: radar
          .list({ clientFilter: true })
          .slice(0, 3)
          .map((l) => ({
            id: l.id,
            provider: l.provider,
            price: l.price,
            name: l.name.slice(0, 40),
            fmv: l.fmv,
            delta: l.delta,
          })),
        usedTradedGg,
        note:
          "bootstrapAll → data/books; warm PollEngine same filter; FMV origin-only; no traded.gg",
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
