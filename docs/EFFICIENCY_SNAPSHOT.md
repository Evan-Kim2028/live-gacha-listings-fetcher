# Efficiency snapshot (native multi-source path)


Primary code: `MultiSourceRadar`, `ListingStore`, `syncOnce`, `PollEngine`.

---

## 0. Lean capture + trimmed rows (ops path)

| Lever | What it does |
|-------|----------------|
| **`RunCapture` lean** | `health.jsonl` + `sold.jsonl` only; no events/books/run-snapshots dual-book in RAM. Default on `runtime-monitor --bootstrap`. |
| **`trimListing`** | On every store upsert: drop `raw` / `searchBlob`, slim `canonical`. |
| **Page concurrency** | Adaptive pull pages default **start 6 / max 12** (`DEFAULT_PAGE_CONCURRENCY`) to cap peak RAM. |
| **Durable book** | `saveBook` / `loadBook` under `data/books/` — not the fat run snapshot tree. |

Details: `docs/RUNTIME_PROOF.md` (capture modes), `docs/BOOTSTRAP_FULL_BOOK.md`.

---

## 1. Batch full-book rebuild vs incremental merge

Two store update modes serve different cadences.

### Full-book rebuild (poll / `syncOnce` ≡ `syncIncremental`)

Path: provider `pull` / `pullAll` → `syncOnce` → `ListingStore.replaceScopeSnapshot(provider, querySignature, listings)`.

`syncIncremental` is an alias of `syncOnce`. Scoped upsert + prune is the incremental multi-source snapshot; there is no separate whole-store wipe.

| Step | Behavior |
|------|----------|
| Fetch | One page (or multi-page via `pullAll` / `maxPages`) of normalized rows for a single provider |
| Scope | Keyed by `(provider, querySignature)` so pokemon vs one_piece (etc.) do not clobber each other |
| Upsert | Every id in the page is written; equality skip counts as `unchanged` |
| Prune | Ids that were in the previous scope but missing from this page are dropped from the scope (and from the global map if no other scope still holds them) |

This is a scoped full replace: correct for sold/stale inventory without wiping other providers or filter views. Soft-fail empty pages (e.g. Phygitals 5xx + `lastError`) skip replace so a bad origin does not empty a good prior snapshot. `MultiSourceRadar.syncAll` uses `Promise.allSettled` so one hard throw never clears another provider’s scope.

### Incremental merge (optional deltas)

When a stream exists, hosts can call `upsertOne` / `removeOne` without a full-scope prune. The default product path does not need that: native origins are polled and rebuilt per scope via `replaceScopeSnapshot`.

### Short-circuit on rebuild

`syncOnce` skips `replaceScopeSnapshot` when any of:

| Path | Gate | Trigger |
|------|------|---------|
| **(A)** HTTP 304 / `notModified` | Always | Provider returns `page.notModified` (ETag / `If-None-Match`) |
| **(B)** Generation match | Always | `meta.etag` or `meta.contentFingerprint` equals prior scope meta |
| **(C)** Content equality | `shortCircuitOnBuiltAt !== false` | Same query + same id-set + every row `listingsEqual` |

**Defaults**

| Caller | `shortCircuitOnBuiltAt` | Why |
|--------|-------------------------|-----|
| `syncOnce` / `syncIncremental` | **true** (default) | Live-safe: enable (C) when generation headers are absent |
| **`PollEngine`** (`tick` / `syncNow`) | **true** (forced) | Live loops: avoid rewrite churn when inventory is unchanged |
| **`MultiSourceRadar.syncAll`** | **false** (forced) | One-shot freshness: still re-apply when only (C) would hit; (A)/(B) still short-circuit on 304 / matching etag or fingerprint |
| CLI one-shot / examples | often **false** | Explicit re-apply for demos / benches |

Native adapters (`collectorcrypt`, `magiceden`, long-tail) set `builtAt` to the content fingerprint (`fp:…`) and always publish `contentFingerprint`; they plumb HTTP `etag` when the origin returns one. Soft-fail empty pages omit fingerprint so a bad origin does not generation-match a prior book.

---

## Native short-circuit

### Problem (historical)


### Design (A preferred · B always for natives · C safety net)

Three layers. Prefer transport cache when the origin supports it. Do not rely on wall-clock `builtAt`.

| Layer | Mechanism | When | Skips |
|-------|-----------|------|-------|
| **(A)** | HTTP `ETag` / `If-None-Match` → **304** | Origin returns ETag (CDN/API) | Network body + parse/normalize + store rewrite |
| **(B)** | `contentFingerprint(listings)` as generation | Native adapters on every successful 200 | Store rewrite when fingerprint matches prior meta |
| **(C)** | Id-set equal and all scope rows `listingsEqual` | When `shortCircuitOnBuiltAt` is true | Store rewrite when book content is unchanged without matching generation |

**Policy**

1. **Prefer (A)** when response headers exist: send stored `If-None-Match` on the next pull; on **304**, treat as bytes unchanged, advance ops watermarks, set `shortCircuited: true`, do not re-parse JSON and do not call `replaceScopeSnapshot`. Persist `etag` on `SnapshotMeta`.
2. **(B) always on native success pages:** `contentFingerprint` = FNV-1a of sorted `id|price|listedAt` lines (`fp:<hex>` / `fp:empty`). Published as both `meta.contentFingerprint` and `meta.builtAt` so generation short-circuit works without server `builtAt`. Soft when origin never returns ETag.
3. **(C) safety net** after a 200 body is normalized, gated by `shortCircuitOnBuiltAt`: same query + same id-set + every row `listingsEqual`, even if fingerprint was omitted.

**Non-goals / constraints**

- Do not short-circuit on id-set alone without row equality (price/listedAt can change with the same ids).
- Soft-fail empty pages (`lastError` + empty list) omit fingerprint and skip prune; (C) does not apply when scope is empty.
- `MultiSourceRadar.syncAll` keeps `shortCircuitOnBuiltAt: false` (one-shot); (A)/(B) still short-circuit. PollEngine forces `true` for live (C).
- `listingsEqual` covers id, price, currency, fmv, delta, listedAt, lastEvent, externalUrl, name; (B) hashes id+price+listedAt only.

### Flow

```
pull(origin)
  │
  ├─ (A) If-None-Match → 304 ──► shortCircuit (no parse, no replace)
  │
  ▼ 200 + body
normalize → listings[]
  │
  ├─ (B) meta.contentFingerprint = contentFingerprint(listings)
  │         etag from response if present
  │         if etag or fingerprint === previous meta → shortCircuit
  │
  ├─ (C) shortCircuitOnBuiltAt && id-set equal && listingsEqual ──► shortCircuit
  │
  └─ else replaceScopeSnapshot + setMeta
```

### Implementation

| Area | Status |
|------|--------|
| `collectorcrypt` | ETag + `If-None-Match` + 304; `contentFingerprint` / `builtAt=fp` on success |
| `magiceden` | Same pattern (ETag soft; fingerprint always on success) |
| long-tail (beezie / renaiss / dyli / phygitals) | Fingerprint on success; ETag + conditional GET on GET paths; POST (beezie) records etag if present |
| `syncOnce` | (A) always; (B) `metaGenerationMatch` always; (C) when `shortCircuitOnBuiltAt` |
| `SnapshotMeta` | `etag?`, `contentFingerprint?` beside `builtAt` / `fetchedAt` |
| PollEngine | `shortCircuitOnBuiltAt: true` (live) |
| MultiSourceRadar.syncAll | `shortCircuitOnBuiltAt: false` (one-shot) |

---



## 2. MultiSourceRadar vs single-hop aggregator

`MultiSourceRadar` fans out direct origin pulls in parallel (`Promise.allSettled` over `syncOnce` per provider):

```
CC CDN  ──┐
ME API  ──┼─► parallel normalize → shared ListingStore
Beezie… ──┘   (soft-fail per origin; one 5xx does not abort the fan-out)
```

Why that stays faster even with multi-market normalize:

1. **No middleman queue** — you pay origin RTT + local CPU, not wait for aggregator rebuild then download.
2. **Parallel wall clock** — total time ≈ slowest origin, not sum of venues.
3. **Cheap normalize** — identity (`listingId`), field mapping, and optional client `filterListings` are O(page) in-process; they are small vs network.
4. **Scoped partial pulls** — `tcg`, `limit`, Solana-only provider sets shrink pages before merge (see §4).
5. **CDN-aware poll** — CC `s-maxage≈30` means re-pulling faster than that mostly re-reads cache; PollEngine’s `minIntervalMs` avoids wasteful thrash.

Normalize runs once per row at the edge of each adapter. Merging into one store does not re-fetch or re-aggregate upstream.

---

## 3. Watermarks per provider (`builtAt` / ops stamps / `listedAt` / etag)

Freshness is tracked at page, provider-ops, and row levels.

**Scope meta** (`SnapshotMeta` via `ListingStore.getMeta`): written after each successful apply for `(provider, querySignature)`.

**Ops watermark** (`ProviderWatermark` via `ListingStore.getWatermark(provider)`): updated by `syncOnce` on every path so MultiSourceRadar can report health without coupling to a single query scope.

| Watermark | Level | Role in this library |
|-----------|--------|----------------------|
| **`contentFingerprint`** | Page generation (B) | Stable hash of normalized id/price/listedAt; matching prior meta → short-circuit without rewrite. |
| **`etag`** | Transport (A) | HTTP ETag when origin provides it; `syncOnce` injects prior value as `ifNoneMatch` for conditional GET / 304. |
| **`lastSuccessfulPullAt`** | Provider ops | ISO time of last successful apply or short-circuit; not advanced on soft/hard fail. |
| **`lastBuiltAt`** | Provider ops | Last known page `builtAt` from a successful pull. |
| **`lastRowCount`** | Provider ops | Scope row count after last successful apply. |
| **`lastError`** | Provider ops | Soft or hard error message; cleared on success. Failures do not wipe other providers. |
| **`listedAt`** (and `firstListedAt`) | Per listing | Recency / sort; in `listingsEqual` and fingerprint. |

Also recorded: `fetchedAt` (local pull time), `total` / `universe`, `querySignature`.

**Per-provider practical notes**

| Provider | Generation signal | Cadence constraint |
|----------|-------------------|--------------------|
| collectorcrypt | ETag **(A)** + fingerprint **(B)**; (C) via PollEngine | CDN `s-maxage≈30` → PollEngine default `minIntervalMs` 30s |
| magiceden | ETag soft + fingerprint **(B)** | Independent; live SOL/USD can change USD prices (and thus fingerprint) |
| long-tail | Fingerprint **(B)**; ETag on GET when present | Soft-fail empties do not prune; phygitals multi-param soft empty |

---

## 4. Partial scopes (Solana, tcg, limit / pages)

Efficiency comes from never pulling or holding the full multi-venue universe unless asked.

### Provider subsets

| Factory | Set | Excludes |
|---------|-----|----------|
| `createSolanaProviders({ includeBeezie: true })` | + beezie between ME and Phygitals | same base exclusions |

Beezie is EVM inventory (flagged `raw.chain`) and is not in the default Solana set; opt in with `includeBeezie` / `includeEvm`.

### Query scopes

`querySignature` canonicalizes decision filters (`limit`, `tcg`, `platform`, `priceMin`/`priceMax`, sort, …). Each `syncOnce` replaces only that provider+signature scope. Parallel pokemon and one_piece views coexist in one `ListingStore`.

### tcg + client filter

- Shared `MultiSourceRadar` `filter` is merged into every provider pull (best-effort server-side).
- `list({ clientFilter: true })` re-applies `filterListings` for adapters that only partially honor params (missing `listing.tcg` does not exclude).

### Limit and pages

- `limit` caps decision pulls (CLI default often 20).
- CC `pullAll` paginates with `step` ≤ 100 and optional `maxPages`; `syncOnce` prefers `pullAll` when implemented.
- ME `pullAll` paginates `collector_crypt` with `offset`/`limit` ≤ 100 until empty / `!hasMore` / `maxPages` (default ceiling 50); soft-fail empty.
- Single-page default keeps one-shot radar under one RTT per origin when `limit` ≤ page size.

Partial scope means less bandwidth, less normalize CPU, smaller prune sets, and faster short-circuit id-set compares.

---

## 5. `PollEngine`: parallel + per-provider `minInterval`

Self-serve live loop without depending on aggregator SSE.

| Option | Default | Meaning |
|--------|---------|---------|
| `minIntervalMs` | `30_000` or map | Number = same floor for all; map = per-provider floors. Defaults: **CC 30s**, **ME 20s**, **Beezie 20s** (`DEFAULT_PROVIDER_MIN_INTERVAL_MS`). Missing map keys → 30s. |
| `tickMs` | `5_000` | Scheduler wake period |
| `parallel` | `false` | `false`: round-robin one due provider per tick. `true`: all due providers pull via `Promise.all` each tick. CLI `--solana` / `--all` default **parallel=true**. |
| `shortCircuitOnBuiltAt` | **true** (forced on every poll tick / `syncNow`) | Enables (C) content-equality short-circuit; (A)/(B) always active |

**Due** = `now - lastPull[provider] >= intervalFor(provider)`. `inFlight` prevents overlapping ticks. `syncNow()` forces a full parallel pass once (still records `lastPull`).

```
parallel=true, map={CC:30s, ME:20s, Beezie:20s}, tick=5s
  t=0s   → pull all due (all)
  t=20s  → ME + Beezie due again (CC still cooling)
  t=30s  → CC due; ME/Beezie if past their floors
```

CLI `poll` logs only `onSync` rows with `upserted > 0` (noise reduction); no-op / short-circuit ticks stay quiet. Each origin keeps its own timer: a slow or soft-failed Phygitals pull does not block Collector Crypt / ME on the next due window. Metrics (`pulls` / `errors` / `latency_ms`) optional via `logMetrics`.

**One-shot vs live (`shortCircuitOnBuiltAt` defaults)**

| Mode | API | Parallelism | `shortCircuitOnBuiltAt` | Notes |
|------|-----|-------------|-------------------------|-------|
| One-shot | `MultiSourceRadar.syncAll` | All providers | **false** | One-shot freshness; (A) 304 and (B) etag/fingerprint still short-circuit |
| Live | `PollEngine` start / `syncNow` | Round-robin or all-due | **true** | Full (A)+(B)+(C); avoid rewrite churn on unchanged books |

---

## 6. Measured bench (`npm run bench-snapshot`)


| Metric | Value |
|--------|------:|
| **cold_parallel_ms** | **964** |
| **warm_ms** | **914** |
| **providers** | 4 (`collectorcrypt`, `magiceden`, `beezie`, `phygitals`) — breadth snapshot via `includeBeezie: true` |
| **totalActive** | **60** (15 per provider) |
| byProvider | CC 15 · ME 15 · Beezie 15 · Phygitals 15 |
| errors | none |
| run | `2026-08-01T18:11:53Z` · breadth set · `ok: true` |

### Warm second pull short-circuit

Unit path (deterministic; `npm test` → `tests/store-idempotency.test.ts`):

| Metric | Cold | Warm (identical payload) |
|--------|-----:|-------------------------:|
| `shortCircuited` | `false` | **`true`** |
| `replaceScopeSnapshot` calls | 1 | **still 1** (no second rewrite) |
| `upserted` / `pruned` | 2 / 0 | **0 / 0** |
| path | full apply | **(B)** generation match (`contentFingerprint`) |

Also covered: content-equality **(C)** when `shortCircuitOnBuiltAt: true` and fetch-time `builtAt` differs; 304 **(A)** in `tests/collectorcrypt.test.ts` / `magiceden.test.ts` (warm `shortCircuited: true`, `fetched: 0` on 304).

Warm short-circuit skips store rewrite only. Generation match runs after the origin pull/normalize, so live `bench-snapshot` warm wall-clock stays network-bound (~cold) unless the origin returns **304**. Bench JSON emits per-provider `shortCircuited` / `upserted` on each phase so a stable book can be grepped for rewrite skips without a duration cliff. Live `syncAll` forces `shortCircuitOnBuiltAt: false` (one-shot); **(A)/(B)** still short-circuit.



This library’s cold parallel fan-out completed in **~1.0s** wall time (warm second pull **~0.9s**) for a full Solana multi-source page set, roughly **30–60× faster** than waiting on that aggregator hop, because wall clock is **max(origin RTT)** plus local normalize rather than wait for middleman rebuild then download. Warm wall-clock matches cold when origins return 200 (pull still happens). Rewrite short-circuit is proven by `metrics.shortCircuited` / zero second `replaceScopeSnapshot`, not by a large warm duration drop.

Reproduce:

```bash
npm test
npm run bench-snapshot
# optional: --naive (clear + full re-sync), --limit N
```

---

## Mental model

```
PullQuery (tcg, limit, …) ──► querySignature ──► scope key
        │
        ▼
  provider.pullAll  ──► page.meta.builtAt + listings[].listedAt
        │
        ▼
  syncOnce ── short-circuit? ──yes──► return (no rewrite)
        │ no
        ▼
  replaceScopeSnapshot  (full-book for that scope)
        │
        └── PollEngine schedules next pull after minIntervalMs
            (parallel due set or round-robin)
```

