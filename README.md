# traded-listings

TypeScript library that pulls TCG listings from origin marketplaces (Collector Crypt, Magic Eden, and others), normalizes them into an identity-stable `ListingStore`, and keeps the book warm with `PollEngine`. Default path is native origin APIs. **traded.gg is not required.**

Spine: `MultiSourceRadar` → `ListingStore` → `listingId({ provider, platform, nativeId })`.

Parallel origin hops (CC CDN cache ~30s + ME public) typically finish a cold full book faster than a single aggregator hop. Measured Solana pokemon full cold (~21k rows): **~28s concurrent** vs **~74s sequential** (`docs/BOOTSTRAP_FULL_BOOK.md`).

License: **0BSD**. Node `>=18`.

## Get started: full bootstrap + warm monitor

Recommended operator path: cold full seed, persist the book, then warm re-poll the same filter.

```bash
npm install
npm test

# Full seed (paginate until !hasMore, max 500 pages/origin) + warm 6h
# No --limit = take everything the API returns (safety: --max-pages)
# Writes: data/books/… + data/runs/live-…/{events,books,sold,health,snapshots}
npx tsx examples/runtime-monitor.ts \
  --bootstrap \
  --seconds 21600 \
  --interval-ms 20000 \
  --max-pages 500 \
  --bids-every 3 \
  --checkpoint-ms 300000 \
  --book-out data/books/full-solana-pokemon \
  --out data/runs/live-full

# Resume warm if the book snapshot is still fresh (--max-age-ms, default 15m)
npx tsx examples/runtime-monitor.ts --bootstrap --resume --seconds 3600 --out data/runs/live-full-2

# CLI-only cold book (no capture loop)
npx tsx src/cli.ts bootstrap --solana --tcg pokemon --max-pages 50 --limit 10000
npx tsx src/cli.ts bootstrap --solana --resume --poll --seconds 60
```

| Flag / path | Behavior |
|-------------|----------|
| `--bootstrap` / `--full` | Full seed: no limit by default, `maxPages` default **500**, walks until `!hasMore` |
| Without `--bootstrap` | Window radar (`limit` default 15). Smoke only, not the full book |
| `data/books/` | Resume cache of the current full listing book |
| `data/runs/<id>/` | Live deltas: `events.jsonl`, `books.jsonl`, `sold.jsonl`, `health.jsonl`, `snapshots/` |

Docs: [`docs/BOOTSTRAP_FULL_BOOK.md`](docs/BOOTSTRAP_FULL_BOOK.md) · [`docs/RUNTIME_PROOF.md`](docs/RUNTIME_PROOF.md) · [`docs/NATIVE_SOURCES.md`](docs/NATIVE_SOURCES.md) · [`docs/DEEP_LINKS.md`](docs/DEEP_LINKS.md)

### Sold / delisted

On each warm pull, if an id leaves a provider’s page set, the store prunes it (`closed`). The orderbook then:

- removes that ask
- if the instrument has no asks left, clears all bids on that instrument
- appends `sold.jsonl` with `lastBestAsk` / `lastBestBid` (last known top-of-book)

Poll cannot always prove on-chain fill price. `lastBestAsk` is the listed price when the row vanished. True fill price needs marketplace trade history or chain events.

### Smoke commands

```bash
npm run native-radar          # CC + ME one-shot page
npm run solana-radar          # Solana set; add -- --poll
npx tsx src/cli.ts radar --tcg pokemon --limit 20
npx tsx src/cli.ts poll --solana --seconds 60
```

### Library usage

```ts
import {
  MultiSourceRadar,
  createSolanaProviders,
  OrderbookFeed,
  CollectorCryptBidsProvider,
  PollEngine,
  saveBook,
} from "traded-listings";

const providers = createSolanaProviders();
const filter = { tcg: "pokemon" as const, limit: 10_000, sort: "new" as const };
const radar = new MultiSourceRadar({ providers, filter });

// Cold full seed
await radar.bootstrapAll({ maxPages: 50 });
saveBook({
  store: radar.store,
  filter,
  providers: providers.map((p) => p.id),
  outDir: "data/books/my-book",
});

// Warm: keep the same filter (limit/tcg changes open a new scope)
const poll = new PollEngine({
  store: radar.store,
  providers,
  filter,
  minIntervalMs: 20_000,
  parallel: true,
});
poll.start();
```

## Core pieces

| Piece | Role |
|-------|------|
| `listingId({provider, platform, nativeId})` | Primary key; never array index |
| `ListingStore` | Idempotent upsert, query-scoped prune, multi-provider coexistence |
| `MultiSourceRadar` | Parallel pull into shared store; filters tcg/platform/price. Default providers = CC + ME via `createDefaultProviders()` |
| `PollEngine` / `PollScheduler` | Staggered or parallel re-poll (CC CDN `s-maxage≈30`). No SSE vendor lock-in |
| `OrderbookFeed` | Asks from merged listings; bids from CC/ME/Courtyard providers |

## Solana refresh

There is no single SSE for all origins. Use `PollEngine` with **parallel** origin refresh and `minIntervalMs` **15–30s** per source (default **20s**; CC CDN ~30s).

| Mode | How |
|------|-----|
| One-shot | `MultiSourceRadar` + `createSolanaProviders()` — parallel pull, soft-fail per origin |
| Live loop | `PollEngine({ parallel: true, minIntervalMs: 15_000–30_000 })` — each source due independently |
| Default sources | CC (Solana) + ME `collector_crypt` + Phygitals. Beezie EVM opt-in: `includeBeezie` / `includeEvm` |

```bash
npx tsx src/cli.ts poll --solana --seconds 60 --tcg pokemon
npx tsx examples/solana-radar.ts              # timed one-shot
npx tsx examples/solana-radar.ts --poll       # + 30s parallel poll
```

```ts
import { MultiSourceRadar, createSolanaProviders, PollEngine } from "traded-listings";

const providers = createSolanaProviders();
const radar = new MultiSourceRadar({
  providers,
  filter: { tcg: "pokemon", limit: 20 },
});
await radar.syncAll();

const poll = new PollEngine({
  store: radar.store,
  providers,
  filter: { tcg: "pokemon" },
  minIntervalMs: 20_000,
  parallel: true,
});
poll.start();
```

## Providers

| Id | Status | Notes |
|----|--------|--------|
| `collectorcrypt` | default | Official `GET /marketplace` |
| `magiceden` | default | CC collection listings + token offers |
| `courtyard` | live | Algolia `marketplace_prod_recently_listed` |
| `beezie` / `renaiss` / `dyli` / `phygitals` | live scaffolds | Origin APIs; see `docs/NATIVE_SOURCES.md` |
| `tradedgg` | optional reference | Opt-in only; not on the default registry path |
| `fixture` | offline tests | |

```ts
import { getProvider, syncOnce, ListingStore } from "traded-listings";

const store = new ListingStore();
await syncOnce(store, getProvider("collectorcrypt"), {
  tcg: "pokemon",
  limit: 20,
  sort: "new",
});
```

## Identity

| Field | Meaning |
|--------|---------|
| `id` | e.g. `collectorcrypt:cc:<cardId>`, `magiceden:me:<mint>` |
| `provider` | Adapter id |
| `platform` | Market slug (`cc`, `me`, `courtyard`, …) |
| `nativeId` | Origin listing/token id |

## Listing age

Optional field `lastSeenAt` (ISO). Not part of identity; ignored by content equality.

| When | Behavior |
|------|----------|
| Successful apply / upsert | Stamp `lastSeenAt` from snapshot `fetchedAt` (or now) if missing; refresh on re-observe |
| Short-circuit success (304 / same content) | `touchLastSeenAt` — rows stay fresh |
| Soft-fail empty | Does **not** refresh `lastSeenAt` — prior book kept, ages out |

```ts
import { isStale, listingAgeMs } from "traded-listings";

// Grey-out after soft-fail / missed polls (e.g. 2–3× minIntervalMs)
for (const l of radar.list()) {
  if (isStale(l, 90_000)) {
    // muted / "stale" badge — not confirmed live inventory
  }
}
```

## Orderbook

- **Asks** from native listings via `listingToAsk`
- **Bids** from `CollectorCryptBidsProvider` / `MagicEdenBidsProvider` / `CourtyardBidsProvider` / fixtures

## Optional legacy adapters

`TradedGgProvider` + `ListingsFeed` (SSE) remain as reference adapters for product research. They are not used by `native-radar`, `createDefaultProviders()`, or CLI `radar`.

## Develop

```bash
npm run build
npm test
npm run native-radar
npm run consumer   # fixture decision path
```

`npm test` is offline by default (fixtures + mocks; no origin network).

Live network suites (Collector Crypt, Magic Eden, Courtyard, Beezie, Phygitals, Dyli) skip unless you opt in:

```bash
LIVE=1 npm test          # or RUN_LIVE=1
```

Either `LIVE=1` or `RUN_LIVE=1` enables live `it.skipIf` / `describe.skipIf` suites.

## License

0BSD. See [LICENSE](LICENSE).
