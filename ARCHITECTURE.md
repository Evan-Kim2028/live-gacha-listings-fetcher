# Architecture (first principles)

Goal: **self-serve multi-source radar** — fetch origin marketplace listings fast and correctly for trading decisions, and keep a queryable history + identity layer for programmatic use. No order placement; the library is read-only.

## Product spine

| Piece | Role |
|-------|------|
| **Venue-scoped identity** | `listingId(provider, platform, nativeId)` — stable primary key, collision-free |
| **Cross-venue card identity** | `cardIdentity.ts` — tcg+set+number+name+year+language+variant (grader/grade excluded by design); structured attrs first, title parser with set dictionary |
| **ListingStore** | Idempotent upsert; query-scoped prune; multi-provider coexistence; `firstSeenAt`/`lastSeenAt` |
| **MultiSourceRadar** | Parallel native pulls → one store; filters `tcg` / `platform` / `priceMin`/`priceMax` |
| **PollEngine / PollScheduler** | Staggered or parallel re-poll (respect CC CDN ~30–60s); optional HistoryStore + orderbook + capture hooks |
| **OrderbookFeed / OrderbookStore** | Asks from merged listings (full depth levels); bids from native `BidsProvider`s; `book()` → best bid/ask/spread + levels |
| **HistoryStore** | SQLite (node:sqlite, zero deps): append-only new/reprice/closed events + token→identity mapping |
| **Provider catalog** | `providers/catalog.ts` — the single add-point for a new marketplace |

## Module map

```
src/
  providers/
    catalog.ts            declarative catalog: id, label, chains, capabilities, factory
    pageWalk.ts           shared sequential page-walk (tri-state: firstPageEmpty/partial/stoppedAtCap)
    types.ts              ListingsProvider / PullQuery seams (+ optional getByTokenId)
    collectorcrypt.ts     CC venue (browse + getCardOffers bids + getByTokenId via ?search=mint)
    magiceden.ts          ME venue (collection listings + sampled offers + getByTokenId via /v2/tokens/{mint}/listings)
    courtyard.ts          Courtyard venue (Algolia listings + per-asset orderbook bids + getByTokenId)
    longtailCommon.ts     LongtailProvider base (transport, fixture, page-walk planner) + normalizers
    beezieProvider.ts     Beezie Base L2 + Solana (byCategory walks, all-categories walker, getByTokenId)
    phygitalsProvider.ts  Phygitals (concurrent multi-page walk — deliberate)
    renaissDyli.ts        single-page venues
    longtail.ts           re-export shim (public API unchanged)
    registry.ts           set builders driven by the catalog
  orderbook/              OrderbookStore (depth levels), OrderbookFeed, instrument keys, BidsProvider seam
  history/HistoryStore.ts SQLite events + card_identities
  cardIdentity.ts         CardIdentity model + parser + set dictionary
  canonical.ts            sameCardListings (identity-key first, name-cluster fallback)
  aggregate/              MultiSourceRadar, PollEngine (history/orderbook/capture hooks)
  capture/                RunCapture, ListingChangeLog (file-based run capture)
  trader/                 alerts, watchlist, health (host-UI surfaces)
  http/                   fetchWithRetry, pageConcurrency (adaptive), metrics
  sync.ts                 syncOnce / syncIncremental (prune-safety guards: suspiciouslySmall / massDrop)
```

## Layers (native path)

| Layer | Role | Cadence |
|-------|------|---------|
| **Native pull** | catalog → venue providers → `pull` / `pullAll` / `getByTokenId` | Poll / `syncAll` / on demand |
| **Shared walk** | `pageWalk.walkSequentialPages` (Algolia, Beezie); Phygitals concurrent | per page |
| **Identity store** | stable keys, idempotent upsert, first/last seen | per page / event |
| **Query scopes** | filters without wiping other views | per `syncOnce` |
| **History** | PollEngine `history` option → SQLite events + identities | per tick |
| **Point lookup** | `card <tokenId>` CLI: live listing + bids + lifetime + identity + siblings | on demand |

## Prune safety (sync)

- Soft-fail empty (provider `lastError` + 0 rows) → prune deferred; a transient 200-empty keeps the scope intact.
- `hasMore === true` / suspiciouslySmall (≥50% shrink) / massDrop (>10% missing) → upsert-only, no prune.
- Complete walk (`hasMore=false`) → replace scope → prunes ids that left the retrievable set (delist path → orderbook clear + history `closed`).

## Orderbook first principles

| Side | Source today |
|------|----------------|
| **Asks** | Listings grouped by instrument key (`name|grader|grade` fallback — cross-venue merge) |
| **Bids** | CC `getCardOffers`, ME sampled offers, Courtyard per-asset orderbook (budgeted, TOB-level) |
| **Depth** | `OrderbookStore.book(instrumentKey)` → full levels (price, size, orderCount) |

## Identity first principles

1. **Venue-scoped identity is exact** — `listingId(provider:platform:nativeId)`.
2. **Cross-venue identity is inferred** — structured attributes when the origin provides them (Beezie/Courtyard); set-dictionary title parsing for CC/ME.
3. **Grade/grader are instrument attributes, not card identity** — a PSA 9 and a CGC 9 of the same card are one card, two instruments.
4. **Persisted** — `card_identities` in the HistoryStore; `siblingsByToken` answers "where else is this card listed".

## Adding a marketplace

1. Write the provider class (subclass `LongtailProvider` for browse APIs, or implement `ListingsProvider`).
2. Add one entry to `providers/catalog.ts` (id, label, chains, capabilities, factory).
3. Add the id to the relevant set order array in `registry.ts`.

CLI `card` picks up venues with `supportsGetByTokenId` automatically; PollEngine/radar/history need no changes.

## Usage

```ts
import {
  ListingStore, MultiSourceRadar, createSolanaProviders,
  OrderbookFeed, HistoryStore, sameCardListings,
} from "traded-listings";

const providers = createSolanaProviders({
  includeBeezie: true, includeBeezieSolana: true, courtyard: true,
  beezieAllCategories: true,
});
const store = new ListingStore();
const radar = new MultiSourceRadar({ providers, store, filter: { sort: "new" } });

await radar.syncAll({ bootstrap: true, maxPages: 60 });
store.lookupByTokenId("<mint>");               // every venue, any scope
sameCardListings("<mint>", store.list());      // same physical card across venues

const history = new HistoryStore("data/history.db");
history.cardLifetime("<mint>");                // first/last price, delist, venues
history.priceHistory("<mint>", 100);           // event stream
history.siblingsByToken("<mint>");             // other venues' tokens for this card
```
