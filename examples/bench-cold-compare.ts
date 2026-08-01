/**
 * Live cold bootstrap: sequential vs concurrent page walks.
 *
 *   npx tsx examples/bench-cold-compare.ts
 *   npx tsx examples/bench-cold-compare.ts --order concurrent-first
 *
 * Default order: sequential first (true cold), concurrent second (may benefit CDN).
 * Use concurrent-first then re-run sequential in a fresh process for both-cold.
 */
import {
  MultiSourceRadar,
  CollectorCryptProvider,
  MagicEdenProvider,
  createPhygitalsProvider,
  type ListingsProvider,
} from "../src/index.js";

type Conc = { start: number; min: number; max: number };

function providersFor(c: Conc): ListingsProvider[] {
  return [
    new CollectorCryptProvider({ pageConcurrency: c }),
    new MagicEdenProvider({
      pageConcurrency: c,
      symbol: "collector_crypt",
    }),
    createPhygitalsProvider({ pageConcurrency: c }),
  ];
}

async function run(
  label: string,
  conc: Conc,
): Promise<{
  label: string;
  wallMs: number;
  totalActive: number;
  byProvider: Record<string, number>;
  stats: Record<
    string,
    {
      active: number;
      pages: number | undefined;
      peakConc: number;
      throttles: number;
      walkMs: number | undefined;
    }
  >;
}> {
  const providers = providersFor(conc);
  const radar = new MultiSourceRadar({
    providers,
    filter: { tcg: "pokemon", sort: "new" },
  });
  const t0 = performance.now();
  const r = await radar.bootstrapAll({ maxPages: 500 });
  const wallMs = Math.round(performance.now() - t0);
  const stats: Record<
    string,
    {
      active: number;
      pages: number | undefined;
      peakConc: number;
      throttles: number;
      walkMs: number | undefined;
    }
  > = {};
  for (const p of providers) {
    const any = p as {
      lastPageWalkStats?: {
        pagesOk?: number;
        peakConcurrency?: number;
        throttles?: number;
        wallMs?: number;
      };
      lastPullMeta?: { pagesFetched?: number };
    };
    const s = any.lastPageWalkStats;
    const meta = any.lastPullMeta;
    stats[p.id] = {
      active: r.byProvider[p.id] ?? 0,
      pages: meta?.pagesFetched ?? s?.pagesOk,
      peakConc: s?.peakConcurrency ?? 1,
      throttles: s?.throttles ?? 0,
      walkMs: s?.wallMs,
    };
  }
  return {
    label,
    wallMs,
    totalActive: r.totalActive,
    byProvider: r.byProvider,
    stats,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const concurrentFirst = args.includes("--order")
    ? args[args.indexOf("--order") + 1] === "concurrent-first"
    : false;

  const seq: Conc = { start: 1, min: 1, max: 1 };
  const conc: Conc = { start: 8, min: 2, max: 16 };

  const runs = concurrentFirst
    ? [
        () => run("concurrent", conc),
        () => run("sequential", seq),
      ]
    : [
        () => run("sequential", seq),
        () => run("concurrent", conc),
      ];

  const results = [];
  for (const fn of runs) {
    const row = await fn();
    results.push(row);
    console.error(
      `[bench] ${row.label} wallMs=${row.wallMs} totalActive=${row.totalActive}`,
    );
  }

  const sequential = results.find((r) => r.label === "sequential")!;
  const concurrent = results.find((r) => r.label === "concurrent")!;
  const speedup =
    sequential.wallMs > 0
      ? Math.round((sequential.wallMs / concurrent.wallMs) * 100) / 100
      : null;
  const savedMs = sequential.wallMs - concurrent.wallMs;
  const faster = concurrent.wallMs < sequential.wallMs;

  console.log(
    JSON.stringify(
      {
        ok: faster && concurrent.totalActive > 1000,
        order: concurrentFirst ? "concurrent-first" : "sequential-first",
        sequential,
        concurrent,
        compare: {
          sequentialWallMs: sequential.wallMs,
          concurrentWallMs: concurrent.wallMs,
          savedMs,
          speedup,
          concurrentFaster: faster,
          rowDelta: concurrent.totalActive - sequential.totalActive,
        },
        priorBaselineWallMs: 70000,
        note:
          "Same-process second run may be CDN-warm. Prefer sequential-first for conservative concurrent speedup.",
      },
      null,
      2,
    ),
  );

  if (!faster) {
    console.error(
      "[bench] FAIL: concurrent was not faster than sequential in this process",
    );
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
