# traded-listings

TypeScript library for multi-venue TCG listings from origin marketplaces. Pulls, normalizes, and keeps a query-scoped book warm. Default Solana set: Collector Crypt, Magic Eden (`collector_crypt`), Phygitals.

**Spine:** `MultiSourceRadar` → `ListingStore` → `listingId({ provider, platform, nativeId })`

Cold full Solana pokemon book (~21k rows): ~28s concurrent vs ~74s sequential. See [`docs/BOOTSTRAP_FULL_BOOK.md`](docs/BOOTSTRAP_FULL_BOOK.md).

License: **0BSD**. Node `>=18`.

## Quick start

```bash
npm install
npm test

# Full seed + warm poll (lean capture: health + sold only)
npx tsx examples/runtime-monitor.ts \
  --bootstrap \
  --resume \
  --seconds 21600 \
  --interval-ms 20000 \
  --max-pages 500 \
  --book-out data/books/full-solana-pokemon \
  --out data/runs/live-full

# One-shot Solana page
npm run solana-radar

# CLI bootstrap + short warm poll
npx tsx src/cli.ts bootstrap --solana --resume --poll --seconds 60
```

| Path / flag | What it does |
|-------------|--------------|
| `--bootstrap` | Paginate until `!hasMore` (default max 500 pages/origin) |
| `--resume` | Load `data/books/` if still fresh |
| Lean capture (default on bootstrap) | `data/runs/…/{health,sold}.jsonl` + durable book |
| `--full-capture` | Also write events, books, run snapshots (heavy) |

More: [`docs/BOOTSTRAP_FULL_BOOK.md`](docs/BOOTSTRAP_FULL_BOOK.md) · [`docs/SOLD_TAKEDOWN.md`](docs/SOLD_TAKEDOWN.md) · [`docs/RUNTIME_PROOF.md`](docs/RUNTIME_PROOF.md) · [`docs/NATIVE_SOURCES.md`](docs/NATIVE_SOURCES.md)

## Library usage

```ts
import {
  MultiSourceRadar,
  createSolanaProviders,
  PollEngine,
  saveBook,
} from "traded-listings";

const providers = createSolanaProviders();
const filter = { tcg: "pokemon" as const, sort: "new" as const };
const radar = new MultiSourceRadar({ providers, filter });

await radar.bootstrapAll({ maxPages: 50 });
saveBook({
  store: radar.store,
  filter,
  providers: providers.map((p) => p.id),
  outDir: "data/books/my-book",
});

// Warm: keep the same filter (changing limit/tcg opens a new scope)
const poll = new PollEngine({
  store: radar.store,
  providers,
  filter,
  minIntervalMs: 20_000,
  parallel: true,
});
poll.start();
```

## Providers

| Id | Default Solana | Notes |
|----|----------------|--------|
| `collectorcrypt` | yes | Official marketplace API |
| `magiceden` | yes | CC collection listings + sampled offers |
| `phygitals` | yes | Soft-fail on outage (no book wipe) |
| `courtyard` | opt-in | Polygon; `includeCourtyard` via `--courtyard` (works with `--solana`) |
| `beezie` | opt-in EVM | `includeBeezie` / `includeEvm` |
| `beezie-solana` | opt-in | Solana-native (solana.beezie.com); `includeBeezieSolana` |
| `renaiss` / `dyli` | no | Origin APIs; see NATIVE_SOURCES |
| `fixture` | tests | Offline |

```ts
import { getProvider, syncOnce, ListingStore } from "traded-listings";

const store = new ListingStore();
await syncOnce(store, getProvider("collectorcrypt"), {
  tcg: "pokemon",
  limit: 20,
  sort: "new",
});
```

## Sold / delist

When a listing leaves a complete full-scope page, the store prunes it. `PollEngine` / `MultiSourceRadar` call `applyDelistsFromSync` when `pruned > 0`: clear orderbook asks (and residual bids when the instrument is empty), append `sold.jsonl` with last bid/ask.

Soft-fail and incomplete pages never prune. Last TOB is not a proven on-chain fill. Details: [`docs/SOLD_TAKEDOWN.md`](docs/SOLD_TAKEDOWN.md).

## Core pieces

| Piece | Role |
|-------|------|
| `listingId` | Primary key: `provider:platform:nativeId` |
| `ListingStore` | Scoped upsert + prune; trims `raw` / `searchBlob` in memory |
| `MultiSourceRadar` | Parallel pull; soft-fail per origin |
| `PollEngine` | Warm re-poll (parallel, 15–30s min interval; CC CDN ~30s) |
| `OrderbookFeed` | Asks from listings; bids from CC/ME/Courtyard providers |
| `RunCapture` | Lean: health + sold. Full: events + books + snapshots |

Identity: `id` is never array index. Optional `lastSeenAt` stamps successful applies; soft-fail does not refresh it (`isStale`).

## Develop

```bash
npm run build
npm test                 # offline fixtures/mocks
npm run native-radar
npm run consumer
LIVE=1 npm test          # or RUN_LIVE=1 — live origin suites
```

## License

0BSD. See [LICENSE](LICENSE).
