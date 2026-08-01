/**
 * Trader health HUD — ListingStore watermarks + PollEngine metrics.
 *
 *   npx tsx examples/trader-hud.ts
 *   npx tsx examples/trader-hud.ts --seconds 8 --interval-ms 2000
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MultiSourceRadar,
  PollEngine,
  createFixtureProvider,
  traderHealthSummary,
  formatHealthHud,
  type ListingsProvider,
  type PullPage,
  type PullQuery,
} from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function flagNum(args: string[], name: string): number | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const n = Number(args[i + 1]);
  return Number.isFinite(n) ? n : undefined;
}

function createSoftFailProvider(id = "softfail"): ListingsProvider {
  return {
    id,
    lastError: null as string | null,
    async pull(_query: PullQuery = {}): Promise<PullPage> {
      this.lastError = `soft-fail HTTP 500 (fixture ${id})`;
      return {
        listings: [],
        hasMore: false,
        meta: {
          provider: id,
          builtAt: null,
          total: 0,
          universe: 0,
          fetchedAt: new Date().toISOString(),
          querySignature: "",
        },
      };
    },
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const seconds = flagNum(args, "--seconds") ?? 6;
  const intervalMs = flagNum(args, "--interval-ms") ?? 2_000;
  const tickMs = Math.min(1_000, intervalMs);

  const providers: ListingsProvider[] = [
    createFixtureProvider({
      path: join(root, "fixtures", "radar-sample.json"),
      providerId: "fixture",
    }),
    createFixtureProvider({
      path: join(root, "fixtures", "radar-sample.json"),
      providerId: "fixture_b",
      builtAt: "1970-01-01T00:00:01.000Z",
    }),
    createSoftFailProvider("softfail"),
  ];

  const filter: PullQuery = { tcg: "pokemon", limit: 20, sort: "new" };
  const radar = new MultiSourceRadar({ providers, filter });
  await radar.syncAll();

  const poll = new PollEngine({
    store: radar.store,
    providers,
    filter,
    minIntervalMs: intervalMs,
    tickMs,
    parallel: true,
  });

  const printHud = (): void => {
    const summary = traderHealthSummary({
      store: radar.store,
      poll,
      providerIds: providers.map((p) => p.id),
    });
    console.log(formatHealthHud(summary));
    console.log("");
  };

  printHud();
  poll.start();
  const hudTimer = setInterval(printHud, Math.max(tickMs, 2_000));
  await new Promise((r) => setTimeout(r, seconds * 1000));
  clearInterval(hudTimer);
  poll.stop();
  printHud();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
