/**
 * Efficiency snapshot bench — cold / warm / optional naive clear+resync.
 *
 * Times wall-clock of MultiSourceRadar.syncAll over createSolanaProviders()
 * (CC Solana + ME collector_crypt + Phygitals soft-fail; Beezie EVM excluded by default).
 *
 *   npx tsx examples/bench-snapshot.ts
 *   npx tsx examples/bench-snapshot.ts --naive   # also run (C) clear + full re-sync
 *   npx tsx examples/bench-snapshot.ts --limit 10
 */
import {
  MultiSourceRadar,
  createSolanaProviders,
} from "../src/index.js";

function flagNum(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

interface PhaseResult {
  label: string;
  wallMs: number;
  totalActive: number;
  byProvider: Record<string, number>;
  errors: Record<string, string>;
  durationMs: number;
  shortCircuited: number;
  applied: number;
  results: { provider: string; shortCircuited: boolean; durationMs: number; upserted: number }[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const doNaive = args.includes("--naive");
  const limit = flagNum(args, "--limit") ?? 15;

  const providers = createSolanaProviders();
  const sources = providers.map((p) => p.id);

  const filter = { tcg: "pokemon" as const, limit, sort: "new" as const };
  const radar = new MultiSourceRadar({ providers, filter });

  async function phase(label: string): Promise<PhaseResult> {
    const t0 = performance.now();
    const result = await radar.syncAll();
    const wallMs = Math.round(performance.now() - t0);
    const results = result.results.map((r) => ({
      provider: r.provider,
      shortCircuited: r.shortCircuited,
      durationMs: r.durationMs,
      upserted: r.upserted,
    }));
    return {
      label,
      wallMs,
      totalActive: result.totalActive,
      byProvider: result.byProvider,
      errors: result.errors,
      durationMs: result.durationMs,
      shortCircuited: results.filter((r) => r.shortCircuited).length,
      applied: results.filter((r) => !r.shortCircuited).length,
      results,
    };
  }

  // (A) cold parallel page pull — empty store, first fan-out
  const cold = await phase("A_cold_parallel");

  // (B) warm second pull — store already populated; still full syncAll (no short-circuit)
  const warm = await phase("B_warm_second");

  // (C) optional naive: clear store then full re-sync (worst-case rebuild cost)
  let naive: PhaseResult | undefined;
  if (doNaive) {
    radar.store.clear();
    naive = await phase("C_naive_clear_resync");
  }

  const phases = [cold, warm, ...(naive ? [naive] : [])];
  const multiSource = sources.length >= 2;
  const ok = multiSource && cold.totalActive > 0;

  console.log(
    JSON.stringify(
      {
        ok,
        sources,
        filter,
        multiSource,
        phases: phases.map((p) => ({
          label: p.label,
          wallMs: p.wallMs,
          totalActive: p.totalActive,
          byProvider: p.byProvider,
          errors: p.errors,
          shortCircuited: p.shortCircuited,
          applied: p.applied,
          results: p.results,
        })),
        // Flat wallMs for quick grepping / CI
        wallMs: {
          A_cold_parallel: cold.wallMs,
          B_warm_second: warm.wallMs,
          ...(naive ? { C_naive_clear_resync: naive.wallMs } : {}),
        },
        note:
          "A=cold parallel Solana set; B=warm second pull; C=optional store.clear + full re-sync",
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
