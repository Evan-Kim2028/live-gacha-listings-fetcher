# Native marketplace sources (self-serve mirror)

Rebuild multi-venue **radar / listings / bids** from origin marketplaces as a self-serve mirror of the product surface traders care about.

- **Spine:** `MultiSourceRadar` + `ListingStore` + `listingId` identity
- **Defaults:** `collectorcrypt` + `magiceden` via `createDefaultProviders()`

## Status matrix

| Source | Listings (asks) | Buy offers (bids) | How |
|--------|-----------------|-------------------|-----|
| **Collector Crypt** | Yes `GET https://api.collectorcrypt.com/marketplace` | Yes browse offer **ids** + `POST /` `getCardOffers` (priced) | Official browse docs + webapp JSON-RPC |
| **Magic Eden** (CC collection) | Yes `GET …/v2/collections/collector_crypt/listings` | Yes sample mints → `…/v2/tokens/{mint}/offers_received` (fallback `/offers`; price SOL) | `MagicEdenBidsProvider` + native `OrderbookFeed` |
| **Courtyard** | Yes **Algolia** `marketplace_prod_recently_listed` | Yes per-asset `GET /orderbook/assets/{id}` (browser UA); no bulk bid index | `CourtyardProvider` + `CourtyardBidsProvider` |
| **Beezie** | Yes `POST api.beezie.com/dropItems/byCategory` | **EVM** Seaport / SellOrder (not Solana) | `createBeezieProvider` |
| **Beezie Solana** | Yes `POST solana-api.beezie.com/dropItems/byCategory` | **Solana** mints, USDC SellOrder; claw buyback endpoints for bid-side | `createBeezieSolanaProvider` |
| **Renaiss** | Yes tRPC `collectible.list` | `offer.*` needs auth | `createRenaissProvider` |
| **DYLI** | Yes `GET www.dyli.io/api/explore` | highest_bid / on-chain | `createDyliProvider` |
| **Phygitals** | Yes docs params (`page`/`itemsPerPage`/`listedStatus`); soft-fail + backoff on outage | claw buyback tx helpers | `createPhygitalsProvider` |

## Aggregation architecture

```
CollectorCryptProvider ──┐
MagicEdenProvider ───────┼─► MultiSourceRadar / PollEngine ─► ListingStore
CourtyardProvider ───────┤   (filters: tcg, platform, price)     │
Beezie/Renaiss/DYLI/… ───┘              │                        │
                                        ├─► BidsProviders (CC / ME offers)
                                        └─► OrderbookFeed (native asks+bids)

createSolanaProviders()  = [collectorcrypt, magiceden(collector_crypt), phygitals]
// opt-in EVM Beezie: createSolanaProviders({ includeBeezie: true }) or { includeEvm: true }
// opt-in Beezie Solana (native): createSolanaProviders({ includeBeezieSolana: true })
```

Parallel origin hops usually finish faster than waiting on one aggregator re-scrape.
CC CDN `Cache-Control: s-maxage≈30`. PollEngine `minIntervalMs` defaults to 30s.

`MultiSourceRadar.syncAll` uses **`Promise.allSettled`** (per-provider soft-fail): a throwing origin leaves other results intact. **Phygitals** never throws on 5xx; it returns an empty page + `provider.lastError`, and radar copies that into `result.errors` so the fan-out always continues.

## Solana (`createSolanaProviders`)

**Default: Solana-native only** (no EVM Beezie):

| Id | Provider | Notes |
|----|----------|--------|
| `collectorcrypt` | `CollectorCryptProvider` | Solana USDC marketplace |
| `magiceden` | `MagicEdenProvider` | Collection symbol **`collector_crypt`** (default) |
| `phygitals` | `createPhygitalsProvider` | Official browse params; micro-USDC → USD; soft empty + `lastError` on outage |


**Opt-in Beezie (old breadth):** `createSolanaProviders({ includeBeezie: true })` or `createSolanaProviders({ includeEvm: true })` inserts `beezie` between ME and Phygitals.

**Opt-in Beezie Solana (native):** `createSolanaProviders({ includeBeezieSolana: true })` appends `beezie-solana` (solana.beezie.com — Solana mints, USDC SellOrders). Live book is thin (~2–20 listings as of 2026-08); full pull is a few cheap POST pages, so it is fine to bootstrap + poll like any native source.

`createDefaultProviders({ all: true })` multi-venue path now includes `beezie-solana` next to EVM `beezie`.

### Real-time update cadence (no single SSE)

Solana does not use one SSE stream for all origins. Freshness is **PollEngine parallel** with **per-source `minIntervalMs` 15–30s** (default **20s** CLI / example; hard floor driven by CC CDN `s-maxage≈30`).

| Mode | What runs | Cadence |
|------|-----------|---------|
| One-shot | `MultiSourceRadar.syncAll` + `createSolanaProviders()` | Single parallel fan-out; soft-fail per origin |
| Live | `PollEngine({ parallel: true, minIntervalMs: 15_000–30_000 })` | Each origin re-pulled when due; independent of others |
| CLI | `traded-listings poll --solana --seconds 60 --tcg pokemon` | Defaults: parallel on, interval 20s, 60s wall clock |
| Example | `examples/solana-radar.ts` / `--poll` | Timed one-shot; optional 30s poll loop |

Origins (CC, ME, Phygitals) have different APIs, CDNs, and failure modes, so there is no single SSE. Parallel per-source poll keeps a slow/5xx origin from blocking others and avoids aggregator SSE lock-in.

### Beezie chain note (Base L2, not Solana)

Live `owner` / `creatorAddress` values are **EVM** (`0x` + 40 hex) on **Base L2** — the claw machine contract `0xfd9a2eF0D719d53E1297d30788E4f37726d852A6` is verified on basescan.org. Catalog is Seaport-style `SellOrder.amountUSDC`, not Solana SPL. Live pokemon book ≈ **777 listings** (2026-08).

- Not in default `createSolanaProviders()`. Opt in with `includeBeezie` / `includeEvm` (or CLI `--solana --beezie`, which adds both Beezie venues).
- When included, each listing is flagged:
  - `listing.market` → `"Beezie (Base)"` (or `"Beezie (Solana)"` for the solana venue, `"Beezie"` when unclassified)
  - `listing.raw.chain` → `"evm" | "solana" | "unknown"`
  - `listing.raw.chainNote` → short operator note
- Pull retries on 429/5xx/network. **`pullAll`** (used by `syncOnce`) multi-pages when `limit` needs more than one page; `pullPages({ maxPages })` for explicit walks. Caps: page ~**20** fixed, **`LONGTAIL_MAX_PAGES_CAP` = 50**. Mid-walk failure soft-keeps collected rows; total soft-empty never prunes prior store scope.
- Filter Solana-only books with `listing.raw.chain !== "evm"` (or drop `provider === "beezie"`).

### Beezie Solana (native, `beezie-solana`)

Site: `solana.beezie.com/marketplace/pokemon` · API: `solana-api.beezie.com` (Hono; no auth, no special headers; Cloudflare DYNAMIC, no cache headers → poll at repo cadence).

- **Listings:** `POST /dropItems/byCategory` body `{ categoryId: "1" (pokemon), page: "0"-based, pageSize: "100" max, filters: [], saleStatus: "forSale", sellOrderDateOrder: "DESC" }` → `{ dropItems: [...], total }`.
  - `saleStatus: "all"` returns the whole catalog including `SellOrder: null` rows (514 items, 2026-08) — use **`forSale`** to get active listings only.
  - Row: `tokenId` (mint), `owner`/`creatorAddress` (base58), `metadata.name/image/attributes[]` (`year`, `grader`, `grade`, `language`, `pokemon name`, `set name`, `card number`, `serial`, `card type`, `finish`, `edition`), `SellOrder.amountUSDC` (dollar string) + `SellOrder.createdAt` (ms), `altFmv` (Beezie FMV).
  - **Filters:** `filters: [{ filterName, value }]` (keys `grader`, `year`, `setName`, `pokemonName`, `cardNumber`, `cardRarity`, `serialNumber`, `language`, `cardType`, `finish`, `edition`; values have `'` escaped — server builds SQL-ish WHERE). Facets: `GET /marketplace/cards/filters/1`.
  - Delist signal = absence from a complete `forSale` walk (same leave-book discipline as CC). No sold endpoint.
- **Deep link:** `https://solana.beezie.com/marketplace/collectible/{kebab-name}-{tokenId}` (mint is the stable path key).
- **Bid-side (future):** claw buyback offers — `GET /claw/minimal` (claw machines, `clawTag` e.g. `beeziesol100`), `GET /claw/buyback-offers/:username?page&pageSize&categoryId` (username = operator username; needs discovery), and `POST /claw/...` actions need auth. Not wired yet.
- Not in default `createSolanaProviders()`. Opt in with `{ includeBeezieSolana: true }`.

```ts
import { MultiSourceRadar, createSolanaProviders } from "traded-listings";

const radar = new MultiSourceRadar({
  providers: createSolanaProviders(),
  filter: { tcg: "pokemon", limit: 20 },
});
const r = await radar.syncAll();
// r.results  — SyncResult[] (Phygitals may be present with fetched:0 on soft-fail)
// r.errors   — e.g. { phygitals: "phygitals soft-fail after N attempt(s): HTTP 500 …" }
// provider.lastError / lastUrl also set on the LongtailProvider instance
```

## CC — Collector Crypt (primary)

**Official docs:** https://docs.collectorcrypt.com/marketplace/api  
**Base (prod):** `https://api.collectorcrypt.com`  
**Program ID:** `CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr` · currency USDC

Live probe: unauthenticated `GET /marketplace` returns **200** with **`filterNFtCard`**. CDN `Cache-Control: public, s-maxage=30, max-age=30`.

### Read path

```bash
curl "https://api.collectorcrypt.com/marketplace?categories=Pokemon&marketplaceStatus=Buy%20now&page=1&step=50&orderBy=listedDateDesc"
```

Provider: `src/providers/collectorcrypt.ts`.

#### Query filters (`GET /marketplace`)

| Param | Notes |
|-------|--------|
| `search` | Substring / exact on nftAddress |
| `marketplaceStatus` | CSV; **`Buy now` = listed** (always set by provider). **Delist signal** = card id missing from a complete full-scope `pullAll` under this filter — not a sold endpoint. |
| `marketplaceSource` | `CC` \| `ME` |
| `listPriceMin` / `listPriceMax` | USDC |
| `categories` | `Pokemon`, `Baseball`, … |
| `blockchain` | CSV: `Solana`, `Base`, `Monad`, `ApeChain`, `Ethereum`, `XLayer`, `Robinhood` (provider default **Solana**) |
| `cardType` | `Card`, `Sealed`, … |
| `gradingCompany` / `grade` | |
| `orderBy` | `listedDateDesc`, `listedPriceAsc`, … |

#### Response

- **`listing`**: ask (`price`, `currency`, `marketplace` CC\|ME) or null
- **`offers`**: often **`{ id }` only** on browse (docs example + live). Listing `raw.offerCount` = ref count.
- Envelope: `filterNFtCard`, `findTotal`, `total`, `totalPages`

#### Offer detail (bids harvest)

Browse alone does not return prices. The CC web app loads priced offers via unauthenticated JSON-RPC:

```bash
curl -X POST "https://api.collectorcrypt.com/" \
  -H "Content-Type: application/json" \
  -d '{"method":"getCardOffers","params":{"nftAddress":"<mint>","useV2":true}}'
```

- Returns array of `{ id, price, currency, status, buyer: { wallet }, … }`
- `useV2: true` required for V2 escrow offers (`useV2: false` → `[]` in probes)
- Card page helpers: `GET /cards/publicNft/{mint}` (no offers), `GET …/market` (listing only), `GET …/offers` = sync `{synced}` not a book
- No public GET `/marketplace/offers/:id` (404). Documented offer routes are write/tx builders only.

`CollectorCryptBidsProvider`: browse → sample mints with offer refs → concurrent `getCardOffers` → `BidOrder[]`.

### Deep-links (externalUrl); read library only

Normalize always sets `Listing.externalUrl` when a public card page can be built:

| Source | Rule |
|--------|------|
| **CC** | `https://collectorcrypt.com/cards/{nftAddress\|id}` via `ccListingUrl` (mint preferred; catalog id fallback) |
| **ME** | origin `token.externalUrl` or `https://magiceden.io/item-details/{mint}` via `meListingUrl` |
| **Phygitals** | `https://www.phygitals.com/card/{slug\|address}` via `phygitalsListingUrl` |
| **Courtyard** | origin URL or `https://courtyard.io/asset/{tokenId}` via `courtyardListingUrl` |
| **Renaiss** | origin URL or `https://www.renaiss.xyz/card/{tokenId}` via `renaissListingUrl` |
| **DYLI** | origin URL or `https://www.dyli.io/p/{id}` via `dyliListingUrl` |
| **Beezie** | **only** when origin carries http(s) URL (`originProvidedUrl`); **null** otherwise (no stable public item path from dropItem ids) |

`formatOpenCommand(url)` returns a platform shell open command (`xdg-open` / `open` / `cmd start`) for operator deep-links. No buy / list / offer / broadcast: write/tx endpoints below stay out of scope.

### Write / tx endpoints (docs; out of scope for read library)

| Method | Path | Role |
|--------|------|------|
| `GET` | `/marketplace` | Browse |
| `POST` | `/marketplace/list` | List NFT |
| `POST` | `/marketplace/cancel-listing` | Cancel |
| `POST` | `/marketplace/update-listing` | Update price |
| `POST` | `/marketplace/buy` | Buy |
| `POST` | `/marketplace/make-offer` | Offer + escrow |
| `POST` | `/marketplace/cancel-offer` | Cancel offer |
| `POST` | `/marketplace/update-offer` | Update offer |
| `POST` | `/marketplace/accept-offer` | Accept |
| `POST` | `/marketplace/broadcast` | Submit signed tx |
| `POST` | `/v2` | JSON-RPC builders (make/update offer + deposit, escrow) |

## Magic Eden

```bash
curl "https://api-mainnet.magiceden.dev/v2/collections/collector_crypt/listings?offset=0&limit=20"
curl "https://api-mainnet.magiceden.dev/v2/collections/collector_crypt/stats"
curl "https://api-mainnet.magiceden.dev/v2/tokens/{mint}/offers_received"
curl "https://api-mainnet.magiceden.dev/v2/tokens/{mint}/listings"
```

- Listing `price` = SOL float; `priceInfo.solPrice.rawAmount` / stats `floorPrice` = **lamports** (decimals 9)
- Provider converts via `mePriceToSol` (prefer `priceInfo`) then **live SOL/USD** (CoinGecko, ~60s cache) → Listing.price in USD-ish USDC
- Soft empty on live HTTP/network/parse errors (`lastError`, empty listings) so multi-source radar stays up
- Collection offers list `…/collections/collector_crypt/offers` → 400 (use per-token offers_received)
- `MagicEdenBidsProvider`: **optional** offers for **top** `sampleMints` (default **8** = `DEFAULT_SAMPLE_MINTS`); `maxConcurrent` default **4**; per-mint `offers_received` **TTL** default **30_000** ms (`ttlMs`); soft-empty per mint; `fetchOffers: false` skips. Budget via `mapWithBidBudget` — see [BIDS_BUDGET.md](./BIDS_BUDGET.md).

### Listings pagination (`pull` / `pullAll`)

| Item | Detail |
|------|--------|
| Endpoint | `GET /v2/collections/{symbol}/listings?offset=&limit=` (default symbol **`collector_crypt`**) |
| Page size | `limit` clamped to **`ME_MAX_PAGE_LIMIT` = 100** |
| Response | **Bare JSON array** (no `total` / cursor field) |
| `hasMore` | Inferred: `rows.length >= limit` (full page ⇒ try next offset) |
| Cold path | `syncOnce` → `pullAll` → `pullPages` until empty / `!hasMore` / `maxPages` / desired `limit` |
| Defaults | page limit 20; when `maxPages` omitted, `ceil(desiredLimit / pageLimit)` capped by **`ME_DEFAULT_MAX_PAGES` = 50** (~5k rows at limit 100) |
| Soft-fail | HTTP/network/parse → empty page + `lastError` (never throws on live); mid-pagination error keeps partial book |

**Full-universe blockers (cannot guarantee entire ME collection book):**

1. **No total count** — stop condition is heuristic (short page); cannot assert “complete universe” without stats side-channel.
2. **`limit` ≤ 100** and **public rate limits / 429** — large scans need retries + conservative `maxPages`; unbounded offset loops are unsafe.
3. **Safety ceiling** — default `ME_DEFAULT_MAX_PAGES` (50) caps accidental full-scan; raise explicitly for research (`pullAll({ limit: 10_000, maxPages: 200 })`).
4. **Collection churn** — listings change while paging; adjacent offsets can overlap or skip under concurrent cancel/relist.
5. **No bulk dump / auth export** — public listings API only; not a marketplace data dump.
6. **Offers are not listings** — full bid book still requires N× `offers_received` (see bids budget).

## Courtyard

- Listings: Algolia app `Y8TL3M06QA`, index `marketplace_prod_recently_listed` (no bid/offer Algolia index)
- REST base `https://api.courtyard.io` — browser-like `User-Agent` + Origin/Referer; bare curl often 403 WAF
- Working unauth:
  - `GET /orderbook/config` → on-chain addresses
  - `GET /orderbook/assets/{proofOfIntegrity}` → `offer_data` (side=buy) + `orderbook_bids` / `orderbook_asks`
  - `GET /configs/providers/config.json` → RPC
- **Bids:** `CourtyardBidsProvider` harvests asset ids from Algolia listings (or `assetIds`), then per-asset orderbook REST (same pattern as ME per-mint offers)
- On-chain (Polygon): orderbook `0x5E4943373c2198625BD441Ae0629E9E7b4FB4797`, coinflow orderbook `0x7fbF08A0eD3EF12565A61935Ca6339BbeCC25F48`, graded NFT `0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD`, USDC `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`
- Blockers: no bulk `/orderbook/bids` browse; full bid book requires N asset fetches; signed on-chain bid acceptance out of scope

## Long-tail (live)

| Site | Endpoints | Notes |
|------|-----------|--------|
| **Beezie** | `POST https://api.beezie.com/dropItems/byCategory` body `{filters:[], saleStatus:"forSale", sort, page:"1", categoryId:"1"}`; `GET …/categories`; `GET …/getByTokenId/:id` | **EVM** owners (`0x…`); SellOrder.amountUSDC; page ~**20**; `pullAll` multi-page bootstrap (cap **50** pages); mid-page fail keeps partial; Cloudflare needs UA |
| **Renaiss** | `GET https://www.renaiss.xyz/api/trpc/collectible.list?input=…` | askPriceInUSDT in **wei (1e18)**; offer.* auth; single-page only |
| **DYLI** | `GET https://www.dyli.io/api/explore`, `/explore/top`, `/search/products?searchTerm=` | products[].price / lowest_price; single-page only |
| **Phygitals** | `GET …/marketplace-listings`, `GET …/filters` | **Public API** (no key): `page` (0-based), `itemsPerPage` (≤**200**), `listedStatus=listed`, `sortBy`, `metadataConditions` (JSON), `priceRange`/`fmvRange`, `searchTerm`. Docs: https://phygitals.mintlify.app/public-api/marketplace/listings. **`pullAll` multi-page** for bootstrap (`LONGTAIL_MAX_PAGES_CAP` **50**). Bare `limit`/`offset` alone often **500**. Response `listings[]` + `amount`; `price` micro-USDC (÷1e6). Soft-empty 5xx + `lastError` (never throws) → **no prune**. Successful complete `listedStatus=listed` page (`hasMore === false`) **may prune** absences (delist path). Mid multi-page soft-fail keeps collected rows. Fixture: `fixtures/phygitals-sample.json`. See `docs/SOLD_TAKEDOWN.md`. |

## Rate limits / etiquette

| API | Notes |
|-----|--------|
| CC `/marketplace` | CDN ~30s; prefer `step` ≤ 100; avoid tight page loops |
| ME | Public; listings `limit` ≤ 100 + offset; batch mint offers carefully; use `pullAll` maxPages ceiling |
| Courtyard | WAF without browser-like client; Algolia for listings |
| Beezie | UA required; Zod-validated POST body; fixed page ~20; multi-page cap 50; EVM addresses only (flagged) |
| Phygitals | `itemsPerPage` ≤ 200; multi-page cap 50; soft-fail empty never wipes store scope |

## What we will not do

- Treat loan offerbooks as NFT buy bids

## Verification (2026-08-01)


### Remaining blockers

| Area | Blocker |
|------|---------|
| **Bids depth** | No bulk bid browse anywhere (CC N× `getCardOffers`; ME per-mint `offers_received`; Courtyard N× per-asset orderbook). **O(N) mitigated** via shared bid budget: `sampleSize` + `maxConcurrent` + per-key `ttlMs` cache (`mapWithBidBudget`) — see [BIDS_BUDGET.md](./BIDS_BUDGET.md). |
| **Renaiss offers** | `offer.*` tRPC requires auth; asks only unauth |
| **Beezie chain** | Live catalog is **EVM** (flagged on `raw.chain`); excluded from default Solana set; opt-in via `includeBeezie` / `includeEvm` |
| **Phygitals** | Origin 5xx common → soft-empty + `lastError`; not a hard guarantee of rows |
| **Courtyard WAF** | Needs browser-like UA/Origin; no Algolia bid index |
| **CC write/tx** | list/buy/offer/broadcast builders documented, out of scope for this read library |
| **Freshness** | PollEngine only (15–30s); no unified native SSE |
| **Live tests** | CC pagination can flake if CDN/page churn overlaps adjacent pages mid-run |
| **ME full book** | Bare-array listings API (no total); `limit` ≤ 100; rate limits; default `maxPages` ceiling; full-universe bootstrap not guaranteed (see ME pagination blockers above) |
