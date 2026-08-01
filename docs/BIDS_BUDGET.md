# Bids budget (O(N) offer harvest)

Multi-venue **buy-offer (bid)** harvest under origin APIs with **no bulk bid index**. Every priced bid path is **per-instrument HTTP**. Without a hard budget, a full listings book is **O(N) origin calls** per poll tick.

Primary code: `CollectorCryptBidsProvider`, `MagicEdenBidsProvider`, `CourtyardBidsProvider`, `OrderbookFeed` (`src/orderbook/`).

Companion: [NATIVE_SOURCES.md](./NATIVE_SOURCES.md) (endpoints + status), [EFFICIENCY_SNAPSHOT.md](./EFFICIENCY_SNAPSHOT.md) (listings short-circuit).

---

## Problem

| Venue | Listings discovery | Priced bids | Shape |
|-------|--------------------|-------------|--------|
| **Collector Crypt** | `GET /marketplace` (batch) | `POST /` `getCardOffers` **per mint** | Browse often id-only; prices need detail RPC |
| **Magic Eden** | `GET …/collections/{symbol}/listings` | `GET …/tokens/{mint}/offers_received` **per mint** | Collection offers list unusable (400) |
| **Courtyard** | Algolia recently-listed | `GET /orderbook/assets/{id}` **per asset** | No bulk `/orderbook/bids` |

Naive policy (every listing mint/asset each tick):

```
HTTP_calls ≈ 1_browse + N_detail
```

At radar scale (hundreds of listings × 3 venues × poll every 15–30s) that blows rate limits, latency, and cost. Soft-empty per mint (ME/CC) avoids throws but **does not** cap spend.

`OrderbookFeed` seeds ME mints / Courtyard asset ids from the merged `ListingStore`. Without sampling that is still **N** potential detail hops.

---

## Policy knobs

Shared control surface for all native bids providers. Names below are the **budget contract**; constructor opts map as shown.

| Budget key | Role | CC today | ME today | Courtyard today | Suggested default |
|------------|------|----------|----------|-----------------|-------------------|
| **`sampleSize`** | Max instruments that get a detail/offer HTTP hop per pull | `sampleCards` (default **24**) | `sampleMints` / `query.limit` (default **8**) | `query.limit` (default **20**) | **8–24** by venue; never “all listings” |
| **`maxConcurrent`** | In-flight detail requests (pool / batch width) | `concurrency` (default **4**) | `concurrency` (default **4**) | `concurrency` (default **4**) | **4** |
| **`ttlMs`** | Per-instrument (or sample-set) cache TTL; skip re-fetch while fresh | **wired** (`ttlMs`, default **30_000**; per-mint getCardOffers) | **wired** (`ttlMs`, default **30_000**; per-mint `offers_received`) | **wired** (`ttlMs`, default **30_000**; per-asset orderbook) | **30_000–60_000** (align with CC CDN / PollEngine) |
| **Prefer rank** | Which instruments win the sample slot | `offerCount` / offer **refs > 0** first, then rest | Top of listings order (ME sort) | First `limit` asset ids from Algolia / store | See ranking rules |

### Ranking (who gets the sample)

Apply **before** slicing to `sampleSize`:

1. **`offerCount > 0`** (or venue equivalent: CC browse offer id refs, ME prior non-empty offers if known). Prefer instruments that already advertise demand.
2. **Top price / top of listings**. Fill remaining slots from highest ask relevance or current list order (ME collection listings order; store seed order for native feed).
3. Dedupe by mint / asset id; preserve rank order.
4. Optional: prefer instruments already in the filtered radar scope (`listingFilter` / `tcg` / price band).

CC implements (1)+slice today (`withRefs` then `rest`). ME/Courtyard implement top-N slice. Prefer-rank should share this policy across venues.

### Hard rules

- **Never** default to unbounded per-mint fan-out on a live poll tick.
- Detail failures are **soft-empty** (no throw); the budget still counts the attempt as an HTTP call.
- `fetchOffers: false` (ME) / `enrichOffers: false` (CC) → **zero** detail hops.
- Fixture / `offline` → no live detail HTTP unless a test `fetchImpl` is injected.
- `ttlMs` hit → cache hit; do not increment detail HTTP for that instrument; return last good bids for the key (or omit until refresh).

### Cost model (per provider pull)

```
detail_budget = min(sampleSize, eligible_instruments)
http_detail   ≤ detail_budget          # with full cache miss
http_detail   ≤ detail_budget - cacheHits
wall_time     ≈ ceil(http_detail / maxConcurrent) × p95_latency
```

Browse / Algolia / listings pull for mint discovery sits **outside** the detail budget and should stay **O(1)–O(pages)** (already true for the listings path).

---

## Metrics to expose

Emit on each bids `pull` (and aggregate on `OrderbookFeed` / PollEngine when wired). Counters are **process-local** unless an operator exports them.

| Metric | Type | Meaning |
|--------|------|---------|
| **`bidsHttpCalls`** | counter | Origin HTTP for **bid detail** (getCardOffers, offers_received, orderbook/assets). Exclude pure listings/browse used only for mint discovery, or label separately as `bidsDiscoveryHttpCalls` if both are needed. |
| **`cacheHits`** | counter | Detail fetches skipped because the instrument (or sample fingerprint) was still within **`ttlMs`**. |
| **`sampleUsed`** | gauge / last-value | Instruments actually selected for detail this pull (`min(sampleSize, candidates)`). Aligns with `mintsAttempted` / targets length in provider meta today. |

### Related diagnostics (already on providers)

Keep; do not replace the three budget metrics:

| Field | Provider | Notes |
|-------|----------|--------|
| `lastBidsMeta.mintsAttempted`, `detailOffersRaw`, `attempts[]` | CC | Per-mint status + offer counts |
| `lastPullMeta.mintsAttempted`, `offersRaw`, `attempts[]` | ME | Endpoint + `offerCount` per mint |
| `lastAssets`, `lastError` | Courtyard | Soft-fail last error string |

Suggested rollup shape (operator export):

```ts
type BidsBudgetMetrics = {
  bidsHttpCalls: number;
  cacheHits: number;
  sampleUsed: number;
  sampleSize: number;
  maxConcurrent: number;
  ttlMs: number;
  provider: string; // collectorcrypt_bids | magiceden_bids | courtyard_bids
};
```

---

## Mapping to current constructors

```ts
// Collector Crypt — sampleCards + concurrency + TTL; prefer offer refs
new CollectorCryptBidsProvider({
  sampleCards: 24,   // → sampleSize (alias maxSample)
  concurrency: 4,    // → maxConcurrent
  ttlMs: 30_000,     // per-mint getCardOffers cache
  enrichOffers: true,
});
// lastBidsMeta: httpCalls, cacheHits, sampleUsed, maxConcurrent, ttlMs

// Magic Eden — sampleMints + maxConcurrent + per-mint TTL; top listings
// Defaults: sampleMints=8 (DEFAULT_SAMPLE_MINTS), maxConcurrent=4, ttlMs=30_000
new MagicEdenBidsProvider({
  sampleMints: 8,      // → sampleSize (also pull({ limit }))
  maxConcurrent: 4,    // → maxConcurrent (concurrency alias still accepted)
  ttlMs: 30_000,       // per-mint offers_received cache
  fetchOffers: true,
});
// Budget via mapWithBidBudget; lastPullMeta includes bidsHttpCalls / cacheHits / sampleUsed

// Courtyard — query.limit as sample; concurrency
new CourtyardBidsProvider({
  concurrency: 4,    // → maxConcurrent
});
// pull({ limit: 20 }) → sampleSize
```

**Status:** Magic Eden and Collector Crypt wire `mapWithBidBudget` (sample cap + TTL + concurrency). ME exposes budget fields on `lastPullMeta`; CC on `lastBidsMeta` (`httpCalls` / `cacheHits` / `sampleUsed` / `maxConcurrent` / `ttlMs`). Courtyard still needs the shared helper + counters.

---

## Operator defaults (recommended)

| Context | sampleSize | maxConcurrent | ttlMs |
|---------|------------|---------------|-------|
| CLI / examples one-shot | ME 8, CC 24, CY 20 | 4 | n/a (single pull) |
| Live PollEngine 15–30s | ME 8, CC 16–24, CY 12–20 | 4 | 30_000–60_000 |
| Stress / full book research | raise sampleSize deliberately | ≤ 8 | lower or 0 |

Under rate pressure, raise **`ttlMs`** and ranking quality before raising `sampleSize`.
