# Architecture (first principles)

Goal: **self-serve multi-source radar** — fetch origin marketplace listings fast and correctly for trading decisions. No order placement.

## Product spine

| Piece | Role |
|-------|------|
| **identity** | `listingId(provider, platform, nativeId)` — never array index |
| **ListingStore** | Idempotent upsert; query-scoped prune; multi-provider coexistence |
| **MultiSourceRadar** | Parallel native pulls → one store; filters `tcg` / `platform` / `priceMin`/`priceMax` |
| **PollEngine / PollScheduler** | Staggered or parallel re-poll (respect CC CDN ~30–60s) without vendor SSE lock-in |
| **OrderbookFeed** | Asks from merged listings; bids from native `BidsProvider`s (`native: true`) |

traded.gg SSE/`ListingsFeed` is **optional reference** only — not the default path.

**Latency:** direct multi-source pulls usually beat a single aggregator hop that re-indexes the same origins.

## Layers (native path)

| Layer | Role | Cadence |
|-------|------|---------|
| **Native pull** | CC `/marketplace`, ME listings, Courtyard Algolia + `/orderbook/assets/{id}` bids, long-tail | Poll / `syncAll` |
| **Identity store** | Stable keys, idempotent upsert | Per page / event |
| **Query scopes** | Filters without wiping other views | Per `syncOnce` |

## Layers (legacy traded.gg reference)

| Layer | Role | Cadence |
|-------|------|---------|
| **Snapshot** `GET /api/radar` | Reference baseline | On start; every **60s** while live |
| **SSE deltas** `GET /api/radar/stream` | Reference low-latency path | Sub-second when markets move |

## Event model (traded.gg wire)

```json
{"type":"new","row":{...radar row...}}
{"type":"reprice","row":{...}}
{"type":"closed","instance_id":"...","platform":"courtyard","reason":"SALE|TRANSFER|BURN"}
```

Map to store:

- `new` / `reprice` → `normalizeTradedRow` → `upsertOne` (identity `tradedgg:platform:instance_id`)
- `closed` → `removeOne` (hard tombstone — competitive edge vs soft-stale radar pages)

## Efficiency rules

1. **Identity is the join key** — never array index; double-apply is free.
2. **Short-circuit snapshots** only when `builtAt` **and** query signature **and** id-set match.
3. **SSE first**, poll second — same policy as traded.gg's own UI (3 open fails → 20s poll).
4. **Reconcile** with periodic snapshot so missed events self-heal.
5. **Respect CDN** (`max-age=15`) — coalesce identical radar URLs; use `builtAt` for generation changes.
6. **Closed beats radar lag** — radar can still show sold rows until hide; stream `closed` removes immediately.

## Subset filters

| Where | Mechanism |
|-------|-----------|
| Snapshot | Server query params on `/api/radar` + client filters (`maxDelta`, fixture re-filter) |
| SSE | Client `listingMatchesFilter(snapshotQuery)` — source stream is global |
| Scope key | `querySignature` includes filter fields so pokemon vs one_piece don't clobber |

## Orderbook first principles

| Side | Source today |
|------|----------------|
| **Asks** | Listings (radar + SSE `new`/`reprice`/`closed`) grouped by instrument key |
| **Bids** | **Not** on public traded.gg listing API — use `BidsProvider` (fixture / external / future) |

Competitive book updates for trading decisions:

1. Filtered listing stream → ask upsert/remove  
2. Optional bids provider stream/poll → bid upsert/remove  
3. `OrderbookStore.book(instrumentKey)` → best bid/ask/spread  

## Competitive quality

| Property | How we match/exceed traded.gg UI |
|----------|-----------------------------------|
| Field fidelity | Same row schema via `normalizeTradedRow` |
| Freshness | SSE path; closed hard-remove |
| Subset efficiency | Server filters + client SSE filter |
| Idempotency | Stable ids + upsert equality |
| Multi-source ready | `ListingsProvider` + `BidsProvider` seams |
| Decision API | `list()`, orderbook levels, async feed events |
| Listing age | Optional `lastSeenAt` on upsert (from `fetchedAt`); `isStale(listing, maxAgeMs)` for grey-out after soft-fail |

## Usage

```ts
const store = new ListingStore();
const feed = new ListingsFeed({
  store,
  snapshotQuery: { limit: 300, sort: "new", tcg: "pokemon" },
});
await feed.start();
for await (const ev of feed) {
  if (ev.kind === "upsert" && ev.listing.delta != null && ev.listing.delta < -15) {
    // decision: new under-FMV listing
  }
}
```
