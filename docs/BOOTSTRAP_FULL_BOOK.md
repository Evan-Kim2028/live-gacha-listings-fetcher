# Bootstrap: cold full book → warm PollEngine

Build a **large, query-scoped listing book** once, persist it on disk, and keep it fresh with warm polls. Soft-fail empties must not wipe inventory. FMV comes only from origin APIs.

Primary code: `syncOnce` / `syncIncremental` (`src/sync.ts`), `ListingStore` (`src/store.ts`), `querySignature` / `scopeKey` (`src/querySignature.ts`), `MultiSourceRadar` (`src/aggregate/MultiSourceRadar.ts`), `PollEngine` (`src/aggregate/PollEngine.ts`), provider `pull` / `pullAll` (`src/providers/*`).

## Operator get-started (copy-paste)

```bash
# Full seed + warm updates + lean run capture (recommended)
# Lean (default with --bootstrap): health.jsonl + sold.jsonl only; durable book under --book-out
npx tsx examples/runtime-monitor.ts \
  --bootstrap \
  --seconds 21600 \
  --interval-ms 20000 \
  --max-pages 50 \
  --limit 10000 \
  --bids-every 3 \
  --book-out data/books/full-solana-pokemon \
  --out data/runs/live-full

# Resume warm only if book snapshot still fresh
npx tsx examples/runtime-monitor.ts --bootstrap --resume --seconds 3600

# Rich capture (events + books + run snapshots — high disk/RAM)
npx tsx examples/runtime-monitor.ts --bootstrap --full-capture --seconds 3600
```

Also documented in root `README.md` (Quick start: full book seed).

**Sold / delisted:** when a listing leaves a provider page, the store prunes it (`closed`); `MultiSourceRadar` / `PollEngine` call `applyDelistsFromSync` when `pruned > 0` so the orderbook clears asks **and** residual bids and `sold.jsonl` records `lastBestAsk` / `lastBestBid` (last known TOB, not a proven on-chain fill). Full product model: [`docs/SOLD_TAKEDOWN.md`](SOLD_TAKEDOWN.md).

## Goal

| Phase | Purpose | Store effect |
|-------|---------|--------------|
| **Cold** | Paginate each provider until `!hasMore` or `maxPages` | Full scoped replace into `ListingStore` |
| **Warm** | `PollEngine` re-pulls the **same** filter / `querySignature` | Scoped upsert+prune; short-circuit when unchanged |
| **Resume** | Skip cold if on-disk snapshot is fresh enough | Hydrate store → go straight to warm |
| **Bids over time** | `OrderbookFeed.refreshBids` on a tick cadence | Updates current bid side without full re-seed |
| **Sold** | Listing pruned → clear instrument book | No leftover bids/asks; `sold.jsonl` last TOB |

One book = one **decision filter** (e.g. `tcg=pokemon&limit=500&sort=new`). Cold and warm **must share that filter** so scopes never drift.

## Scope key (do not drift)

```
scopeKey = provider + "::" + querySignature(filter)
```

`querySignature` is order-independent and includes decision fields: `limit`, `offset`, `sort`, `tcg`, `q`, `platform`, `itemType`, grader/grade/language/activity/canonical, price/year bounds, `maxDelta`, `requireFmv`, fixture/offline flags (`src/querySignature.ts`).

- `ListingStore` scopes every snapshot by `(provider, querySignature)`.
- Other providers and other filters are never pruned by a pull.
- **Cold and warm must use the identical `PullQuery` / filter object** (same signature). Changing `limit` or `tcg` between cold and warm creates a **new** scope and leaves the cold book untouched (or empty if you only list the warm scope).

Name the disk directory from the same idea: a hash or sanitized form of `provider::querySignature`, or a multi-provider book id that records the shared filter and provider set.

## Cold: full pull

### Concurrent pages (speed)

Multi-page cold pulls run page 1 first, then remaining pages concurrently:

1. **Page 1 sequential** discovers `totalPages` / `hasMore` / totals
2. **Remaining pages concurrent** with adaptive concurrency (default start **6**, min **2**, max **12**)
3. **Throttle** on 429/5xx: cut concurrency in half, exponential backoff, retry page
4. **Success streak** slowly ramps concurrency back up

Implementation: `src/http/pageConcurrency.ts` (`paginateConcurrent` / `mapLimitAdaptive`), wired into CC / ME / Phygitals `pullPages`. Defaults are capped to bound peak RAM during multi-page cold pulls.

Tune per provider: `pageConcurrency: { start, min, max }` on provider options. Force sequential: `{ start: 1, max: 1 }`.

**Measured live (Solana pokemon full cold, ~21k rows; earlier concurrent defaults 8→16):**

| Mode | Wall | Notes |
|------|-----:|-------|
| Sequential (`pageConcurrency` 1) | **~74s** | peakConc 1 all origins |
| Concurrent (then-default 8→16) | **~32s** | same process after seq (CDN may help) |
| Concurrent alone (fresh process) | **~28s** | earlier bench |

Speedup **~2.3×**, same row counts (Δ0). CC walk **~74s → ~6s** at peak 16. Current library default max is **12** (slightly lower peak RAM).

```bash
npx tsx examples/bench-cold-compare.ts    # seq then concurrent
npx tsx examples/bench-cold-concurrent.ts # concurrent only
```

### Path

```
provider.pullAll?.(query) ?? provider.pull(query)
  → syncOnce(store, provider, { ...query, shortCircuitOnBuiltAt: false })
  → ListingStore.replaceScopeSnapshot(provider, qsig, listings)
```

`syncOnce` prefers `pullAll` when the provider implements it (`src/sync.ts`).

### Pagination contract

Providers that support multi-page cold fills (`syncOnce` prefers `pullAll` when present):

| Provider | Mechanism | Page size | maxPages cap | Stop when |
|----------|-----------|-----------|--------------|-----------|
| **Collector Crypt** | `pullAll` → `pullPages` (`page`/`step`) | step ≤ **100** | from `ceil(limit/step)` or explicit | `!hasMore`, empty, or `maxPages` |
| **Magic Eden** | `pullAll` → `pullPages` (`offset`/`limit`) | limit ≤ **100** | `ME_DEFAULT_MAX_PAGES` **50** | same + desired `limit` |
| **Beezie** (long-tail) | `pullAll` → `pullPages` (1-based `page`) | **~20 fixed** (`BEEZIE_PAGE_SIZE`) | **50** (`LONGTAIL_MAX_PAGES_CAP`) | same; mid soft-fail keeps prior pages |
| **Phygitals** (long-tail) | `pullAll` → `pullPages` (0-based `page`, `itemsPerPage`) | ≤ **200** | **50** | same; mid soft-fail keeps collected rows |
| **Others** | single `pull` | provider default | n/a | provider `hasMore` / limit |

**Long-tail caps (exported from `longtailCommon.ts`, re-exported via the `longtail.ts` shim):**

| Constant | Value | Role |
|----------|------:|------|
| `BEEZIE_PAGE_SIZE` | 20 | Beezie API fixed page; client `limit` slices only |
| `PHYGITALS_MAX_ITEMS_PER_PAGE` | 200 | Docs max `itemsPerPage` |
| `PHYGITALS_DEFAULT_PAGE_SIZE` | 24 | When `limit` omitted on single pull |
| `LONGTAIL_MAX_PAGES_CAP` | 50 | Hard ceiling for Beezie/Phygitals multi-page |
| `LONGTAIL_DEFAULT_MAX_PAGES` | 1 | `pullPages` default when `maxPages` omitted |

`pullAll` derives `maxPages = min(cap, ceil(limit / pageSize))` when `maxPages` is omitted; explicit `maxPages` still respects the hard cap. Warm polls with small `limit` stay single-page (`maxPages === 1`).

**Operator rule for a full book:**

1. Set a high enough `limit` (desired book size) and/or explicit `maxPages`.
2. Prefer `pullAll` / multi-page helpers so one `syncOnce` lands the whole page set.
3. Stop pagination when **`!hasMore`** or **`maxPages`** is hit (never unbounded).
4. For multi-source: `MultiSourceRadar.syncAll({ ...filter })` fans out with `Promise.allSettled` and `shortCircuitOnBuiltAt: false` (one-shot apply).

CC `pullAll` derives `maxPages` from `ceil(limit / step)` when `maxPages` is omitted; empty page or `!hasMore` breaks early.

ME `pullAll` same shape (`ceil(limit / pageLimit)`, pageLimit ≤ 100, default safety ceiling `ME_DEFAULT_MAX_PAGES` = 50). `bootstrap: true` raises the cap to `ME_BOOTSTRAP_MAX_PAGES` (100) and uses page size 100. Response is a **bare JSON array** (no total): `hasMore` is inferred when the page is full. Soft-fail empty on origin errors; mid-pagination soft-fail keeps partial rows. Full-universe dump is **not** guaranteed (rate limits, no total, churn); see `docs/NATIVE_SOURCES.md`.

### After cold success

- Scope meta: `SnapshotMeta` (`builtAt`, `fetchedAt`, `etag`, `contentFingerprint`, `querySignature`, …) via `store.setMeta`.
- Provider watermark: `lastSuccessfulPullAt`, `lastBuiltAt`, `lastRowCount`, `lastError: null`.
- Persist to disk (below) before entering warm so crash/restart can skip cold.

## Warm: PollEngine on the same scope

```ts
const filter = { tcg: "pokemon", limit: 500, sort: "new" }; // SAME as cold

const radar = new MultiSourceRadar({ providers, filter });
await radar.syncAll(); // cold fan-out (or hydrate from disk first)

const poll = new PollEngine({
  store: radar.store,       // SAME store
  providers,                // SAME set
  filter,                   // SAME querySignature
  parallel: true,
  minIntervalMs: 20_000,    // 15–30s; CC CDN s-maxage≈30
  shortCircuit implicit: true on every tick / syncNow
});
poll.start();
```

| Setting | Cold (`syncAll`) | Warm (`PollEngine`) |
|---------|------------------|---------------------|
| Filter / signature | decision query | **identical** |
| `shortCircuitOnBuiltAt` | forced `false` | forced `true` |
| Soft-fail | per origin, no sibling wipe | same |
| Interval | n/a | per-provider `minIntervalMs` (CC 30s default map entry) |

Warm ticks call `syncOnce` with the engine filter. Unchanged inventory short-circuits on:

| Path | Gate |
|------|------|
| **(A)** `page.notModified` (304 / If-None-Match) | always |
| **(B)** etag or `contentFingerprint` match | always |
| **(C)** same id-set + `listingsEqual` | when short-circuit enabled (PollEngine) |

`syncNow()` is one parallel force-tick (`allSettled`); failed origins omit from the result array and surface via `onError` / watermarks.

## Soft-fail empty must never wipe a large book

**Invariant:** a bad origin response with **zero listings + `provider.lastError`** must **not** call `replaceScopeSnapshot`. Prior scope rows, meta generation, and success watermark stamps stay.

Enforced in `syncOnce` (`src/sync.ts`):

```ts
const softErr = provider.lastError ?? null;
if (softErr && page.listings.length === 0) {
  store.markProviderError(provider.id, softErr);
  // shortCircuited: true, pruned: 0, listings = prior scope
  return result;
}
```

Also:

| Path | Behavior |
|------|----------|
| HTTP **304** / `notModified` | Never replace scope (empty body must not wipe) |
| Hard throw | `markProviderError` then rethrow; scope untouched |
| Mid multi-page soft-fail (Beezie/Phygitals) | Keep rows already collected; set `lastError` with partial note; apply non-empty partial (does not wipe prior full scope via empty replace) |
| Total multi-page soft-empty | `lastError` + empty → syncOnce preserves prior full scope |
| `MultiSourceRadar.syncAll` / `PollEngine.syncNow` | `Promise.allSettled`: one origin 5xx does not abort siblings |

`markProviderError` keeps prior `lastSuccessfulPullAt` / `lastBuiltAt` / `lastRowCount` and only sets `lastError`.

After a large cold book, warm soft-fails leave **thousands of rows** in memory and on disk until a **successful non-empty** pull proves the book shrank. Do not treat soft-fail empty as “market went to zero.”

Related capture: `RunCapture` lean mode writes **health + sold only**; full mode emits listing diffs (`new` / `reprice` / `closed` / `soft_fail`). Soft-fail always skips store prune. Store rows are `trimListing`-ed (no `raw` / `searchBlob`). See `docs/RUNTIME_PROOF.md`.

## Disk layout

Persist after successful cold or successful warm apply:

```
data/books/<scope>/
  snapshot.json    # normalized Listing[] for this book (all providers in scope, or one file per provider)
  meta.json        # book-level + per-provider SnapshotMeta / watermarks / filter / freshness
```

Suggested `meta.json` fields:

| Field | Meaning |
|-------|---------|
| `filter` | Exact `PullQuery` used for cold + warm |
| `querySignature` | `querySignature(filter)` |
| `providers` | Adapter ids in the book |
| `savedAt` | ISO write time |
| `byProvider.<id>.snapshotMeta` | Last good `SnapshotMeta` (etag, fingerprint, builtAt, row counts) |
| `byProvider.<id>.watermark` | `ProviderWatermark` |
| `rowCount` | Total rows in `snapshot.json` |
| `freshUntil` or `maxAgeMs` policy input | Used by resume |

Write `snapshot.json` only on the **last good** full apply. Never overwrite a large snapshot with a soft-fail empty (mirror store rules).

`<scope>` example: sanitized `tcg=pokemon&limit=500&sort=new` or a short hash of that string plus provider set id.

In-memory truth is `ListingStore`. Disk is resume cache and audit trail; it does not prune scopes.

## Resume: skip cold when snapshot is fresh enough

```
1. Resolve scope dir from filter (+ providers).
2. If snapshot.json + meta.json exist:
   a. Load listings into ListingStore (replaceScopeSnapshot or bulk upsert per provider scope).
   b. Restore setMeta + setWatermark from meta.
   c. If now - savedAt (or lastSuccessfulPullAt) < maxAgeMs → skip cold; start PollEngine.
3. Else run cold full pull → write snapshot + meta → start PollEngine.
```

**Fresh enough** is host policy (e.g. `maxAgeMs` 5–15 minutes for active books, longer for offline analysis). Fingerprint/etag in meta still let the first warm tick short-circuit without a full rewrite.

Do **not** skip cold if:

- meta filter ≠ current filter (signature mismatch),
- snapshot rowCount is 0 but you expect a large book,
- meta marks a soft-fail-only state with no prior good pull,
- operators pass `--force-cold`.

## FMV / delta (origin only; no external oracles)

This library **passes through and derives delta from origin-provided fair values only**. Do **not** attach PriceCharting, TCGPlayer, or other external FMV oracles in core bootstrap; put those in a **separate plugin**.

| Source | Origin field | Listing fields |
|--------|--------------|----------------|
| **Collector Crypt** | `insuredValue` | `fmv`, `delta = round((price - fmv) / fmv * 100)` when fmv > 0 |
| **Magic Eden** | Token attributes (e.g. insured value when present on CC collection NFTs); price/floor elsewhere stay origin stats | `fmv` / `delta` when numeric FMV exists; else `null` |
| **Long-tail** | Beezie / Phygitals `altFmv`, Renaiss `fmvPriceInUSD`, Courtyard estimates when API sends them | same pattern; missing / `NO-FMV` → `null` |

Rules:

1. If the API does not send FMV → `fmv: null`, `delta: null` (still keep the ask).
2. `requireFmv` / `maxDelta` are **client filters** on already-normalized rows (`filter.ts`), not oracle fetches.
3. `listingsEqual` includes `fmv` and `delta` so origin reprice-vs-FMV changes invalidate short-circuit.
4. External FMV enrichment is an optional post-plugin that may write derived fields elsewhere, **not** in `syncOnce` / providers’ normalize for this book path.

## End-to-end sequence

```
                    ┌─────────────────────────┐
  resume? ──yes───► │ hydrate ListingStore    │
     │              │ from data/books/<scope> │
     │ no           └───────────┬─────────────┘
     ▼                          │
  cold: for each provider       │
    pullAll until !hasMore      │
      or maxPages               │
    syncOnce (no soft wipe)     │
    write snapshot.json + meta  │
     └──────────────────────────┤
                                ▼
                    PollEngine(filter = same)
                      tick / syncNow
                      soft-fail → keep book
                      success → replaceScopeSnapshot
                      optionally re-save disk
```

### Minimal code sketch

```ts
import {
  MultiSourceRadar,
  createSolanaProviders,
  PollEngine,
  querySignature,
} from "traded-listings";

const filter = { tcg: "pokemon" as const, limit: 500, sort: "new" as const };
const providers = createSolanaProviders();
const qsig = querySignature(filter); // shared scope identity

const radar = new MultiSourceRadar({ providers, filter });
// TODO host: if data/books/<scope> fresh → hydrate radar.store; else:
await radar.syncAll(); // cold parallel; soft-fail per origin
// TODO host: persist store.list() + meta under data/books/<scope>/

const poll = new PollEngine({
  store: radar.store,
  providers,
  filter, // SAME querySignature as cold
  parallel: true,
  minIntervalMs: { collectorcrypt: 30_000, magiceden: 20_000 },
});
poll.start();
```

## Checklist

- [ ] Cold uses `pullAll` / multi-page until `!hasMore` or `maxPages` (CC, ME, Beezie, Phygitals)
- [ ] Long-tail caps respected (`LONGTAIL_MAX_PAGES_CAP` 50; Beezie page 20; Phygitals ≤200)
- [ ] Warm `PollEngine.filter` === cold filter (`querySignature` identical)
- [ ] Soft-fail empty + `lastError` never prunes a prior large scope
- [ ] Mid multi-page soft-fail keeps collected rows (does not empty-replace the book)
- [ ] Disk: `data/books/<scope>/snapshot.json` + `meta` only updated on good applies
- [ ] Resume skips cold when snapshot age ≤ policy and signature matches
- [ ] FMV/delta only from origin fields; no external oracle in this path

## See also

- [`EFFICIENCY_SNAPSHOT.md`](./EFFICIENCY_SNAPSHOT.md): short-circuit layers A/B/C, scoped replace
- [`NATIVE_SOURCES.md`](./NATIVE_SOURCES.md): providers, Solana set, poll cadence
- `tests/watermarks.test.ts`: soft-fail empty does not prune prior scope
- `tests/courtyard-longtail.test.ts`: Beezie/Phygitals pullAll multi-page + soft-fail scope
- `tests/store-idempotency.test.ts`: cold/warm syncOnce + scope coexistence
