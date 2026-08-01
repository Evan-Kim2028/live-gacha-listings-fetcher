/**
 * Time full cold bootstrap with concurrent page walks.
 *   npx tsx examples/bench-cold-concurrent.ts
 */
import {
  MultiSourceRadar,
  createSolanaProviders,
} from "../src/index.js";

async function main(): Promise<void> {
  const providers = createSolanaProviders();
  const radar = new MultiSourceRadar({
    providers,
    filter: { tcg: "pokemon", sort: "new" },
  });
  const t0 = performance.now();
  const r = await radar.bootstrapAll({ maxPages: 500 });
  const wall = Math.round(performance.now() - t0);
  const stats: Record<string, unknown> = {};
  for (const p of providers) {
    const s = (
      p as {
        lastPageWalkStats?: {
          pagesOk: number;
          peakConcurrency: number;
          throttles: number;
          wallMs: number;
        };
        lastPullMeta?: { pagesFetched?: number };
      }
    ).lastPageWalkStats;
    const meta = (
      p as { lastPullMeta?: { pagesFetched?: number } }
    ).lastPullMeta;
    stats[p.id] = {
      active: r.byProvider[p.id] ?? 0,
      pages: meta?.pagesFetched ?? s?.pagesOk,
      peakConc: s?.peakConcurrency,
      throttles: s?.throttles,
      walkMs: s?.wallMs,
    };
  }
  console.log(
    JSON.stringify(
      {
        wallMs: wall,
        totalActive: r.totalActive,
        byProvider: r.byProvider,
        stats,
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
