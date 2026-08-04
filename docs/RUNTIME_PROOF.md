# Runtime proof: efficient live capture

How to run a long-lived multi-source session and prove the native path stays up, isolates soft-fails, and only records real inventory/book changes, without dumping the full book every poll tick.

Primary code: `ListingStore`, `PollEngine`, `OrderbookFeed`, `MultiSourceRadar` (`syncOnce` / watermarks / content fingerprints).

## Goal

Capture **listings + orderbook** over hours/days with:

| Constraint | Rule |
|------------|------|
| Disk | Append-only deltas; sparse full snapshots |
| CPU / I/O | Never rewrite or log the entire active set on an unchanged tick |
| Isolation | One origin 5xx must not wipe siblings or stop the run |
| Audit | Enough artifacts to reconstruct uptime, soft-fails, and change rates |

Operators (or a small driver script) wire `PollEngine` + optional `OrderbookFeed` and write under `data/runs/<iso>/`.

## Capture modes (`RunCapture`)

| Mode | How to enable | Disk under `data/runs/<id>/` | RAM |
|------|---------------|------------------------------|-----|
| **lean** (default with `runtime-monitor --bootstrap`) | `RunCapture.open(dir, { lean: true })` or `--lean` | `meta.json`, `health.jsonl`, `sold.jsonl` only | No listing-diff map / no run-snapshot pages |
| **full** | `{ mode: "full" }` or `--full-capture` | + `events.jsonl`, `books.jsonl`, `snapshots/` | Keeps last page per scope for sparse run snapshots |

Durable inventory still lives in **`data/books/`** via `saveBook` / `loadBook` in both modes. Lean is the recommended long-soak path; full is for row-level event proof and run-local recovery dumps.

In-memory store rows are always **trimmed** (`trimListing`): no `raw` / `searchBlob`, slim `canonical` — see `src/store.ts`.

## Run directory layout

### Lean (recommended ops)

```
data/runs/<iso>/
  meta.json           # includes "mode": "lean"
  health.jsonl        # per-provider pull health
  sold.jsonl          # delist / ask-removed last TOB
```

### Full (rich audit)

```
data/runs/<iso>/
  meta.json           # run config + provider list (write once at start)
  events.jsonl        # listing change / soft-fail events only
  books.jsonl         # best bid/ask per instrument when fingerprint changes
  health.jsonl        # per-provider pull health every tick that ran a pull
  sold.jsonl          # delist / ask-removed last TOB
  snapshots/          # sparse full dumps (JSON)
    <provider>__<qsigHash>__<iso>.json
```

`<iso>` = run start time in UTC ISO-8601 safe for paths, e.g. `2026-08-01T14-30-00Z`.

### `meta.json` (once)

```json
{
  "startedAt": "2026-08-01T14:30:00.000Z",
  "mode": "lean",
  "filter": { "tcg": "pokemon", "limit": 100 },
  "providers": ["collectorcrypt", "magiceden", "phygitals"],
  "minIntervalMs": { "collectorcrypt": 30000, "magiceden": 20000 },
  "tickMs": 5000,
  "parallel": true,
  "checkpointMs": 300000,
  "orderbook": true,
  "libNote": "RunCapture lean: health + sold only"
}
```

## 1. `events.jsonl`: append-only, **only on change** (full mode)

**Lean mode does not write this file** — use `health.jsonl` + `sold.jsonl` + durable `data/books/`.

**Never** dump every active listing every tick. Emit one JSON line when something material happens.

### When to append

| Kind | Source signal | Payload gist |
|------|---------------|--------------|
| `new` | `SyncResult.upserted` rows that were not in prior scope id-set | listing id, price, provider, querySignature |
| `reprice` | same id already in scope but `listingsEqual` false (price/fields changed) | id, old/new price if known, provider |
| `closed` | `SyncResult.pruned` (left scope) or stream `removeOne` | listing id, provider |
| `soft_fail` | provider `lastError` / `MultiSourceRadar.errors` / `onError` | provider, error string, prior watermark stamps |

Optional: `short_circuit` is **not** required on every tick (that belongs in `health.jsonl`). If you want a rare audit of generation hits, sample or count in health only.

### When **not** to append

- `shortCircuited: true` with `upserted=0` and `pruned=0` (304 / fingerprint / content equality; store unchanged).
- Successful pull where `upserted=0`, `pruned=0`, and no soft error.
- Full store dump of `store.list()` after every `onSync`.

### How to derive kinds from the library

`PollEngine` forces `shortCircuitOnBuiltAt: true` and calls `syncOnce` → `ListingStore.replaceScopeSnapshot` only when content actually moves.

From each successful `onSync(providerId, result)`:

```
if result.shortCircuited → no listing events (health only)
else:
  // Diff is already summarized on SyncResult:
  // upserted + pruned; unchanged is noise for events.jsonl
  for each material change you choose to expand:
    - prefer comparing result.listings vs prior scope id-set/prices
      held in a small driver-side map, OR
    - emit coarse lines: { kind: "scope_apply", upserted, pruned, ... }
      and expand only when proving row-level accuracy
```

For row-level proof, keep a driver-side `Map<id, {price}>` (or last fingerprint per scope). On non-short-circuit apply:

1. **new**: id in page, not in map
2. **reprice**: id in map, price (or `listingsEqual` fields) differs
3. **closed**: id in map, not in page (aligns with `pruned`)
4. Update map from page

Soft-fail: `MultiSourceRadar.syncAll` / `PollEngine.syncNow` use `Promise.allSettled`; failed providers land in `errors` / `onError` and `ListingStore.markProviderError` **without** clearing other scopes or success stamps (`lastSuccessfulPullAt` / `lastRowCount` preserved).

### Example lines

```json
{"ts":"2026-08-01T14:31:02.100Z","kind":"new","provider":"magiceden","id":"magiceden:me:abc","price":12.5,"currency":"SOL","qsig":"limit=100&tcg=pokemon"}
{"ts":"2026-08-01T14:31:02.101Z","kind":"reprice","provider":"collectorcrypt","id":"collectorcrypt:cc:xyz","price":9.1,"prevPrice":9.4}
{"ts":"2026-08-01T14:32:10.000Z","kind":"closed","provider":"magiceden","id":"magiceden:me:abc"}
{"ts":"2026-08-01T14:33:00.050Z","kind":"soft_fail","provider":"phygitals","error":"soft-fail HTTP 500","lastSuccessfulPullAt":"2026-08-01T14:20:00.000Z","lastRowCount":42}
```

## 2. `snapshots/`: sparse full checkpoints (full mode only)

**Lean mode never creates `snapshots/`.** Durable recovery is `data/books/` (`saveBook`).

Full dumps are recovery and audit anchors for rich capture, not the live stream.

### When to write

| Trigger | Behavior |
|---------|----------|
| **First successful pull per scope** | After first non-soft-fail apply for `(provider, querySignature)` with `fetched > 0` or active scope size &gt; 0 |
| **Every `checkpointMs`** | Wall-clock cadence (e.g. 5–15 min). Default suggestion: `300_000` (5 min) |
| **Optional on stop** | Final snapshot when the process stops cleanly |

Do **not** snapshot on short-circuit-only ticks. Do **not** snapshot empty soft-fail pages (that would freeze a bad empty book over a good prior; same reason `syncOnce` skips replace on soft-empty).

### Contents

Prefer one file per scope:

```
snapshots/{provider}__{qsigHash}__{iso}.json
```

Body:

```json
{
  "ts": "2026-08-01T14:35:00.000Z",
  "provider": "collectorcrypt",
  "querySignature": "limit=100&tcg=pokemon",
  "meta": { "builtAt": "fp:…", "contentFingerprint": "fp:…", "etag": "…", "fetchedAt": "…" },
  "watermark": { "lastSuccessfulPullAt": "…", "lastRowCount": 87, "lastError": null },
  "listings": [ /* store.listScope(provider, qsig) */ ]
}
```

**Gzip optional:** write `.json.gz` when page size is large (CC/ME hundreds of rows). Keep the same basename so tools can accept either.

Cross-check: after a checkpoint, replaying `events.jsonl` from the previous snapshot’s `ts` should converge to the next snapshot’s id-set and prices (within soft-fail gaps).

## 3. `books.jsonl`: best bid/ask only when fingerprint changes (full mode)

**Lean mode does not write this file.**

`OrderbookFeed` (native) derives **asks** from filtered `ListingStore` (`refreshAsks` after radar/poll) and **bids** from `BidsProvider`. `OrderbookStore.book(instrumentKey)` already exposes `bestBid` / `bestAsk` / `spread` / `mid`.

### Emit rule

For each instrument (or each instrument that appeared in the last refresh):

1. Compute a compact fingerprint of top-of-book, e.g.
   `fp = contentFingerprint`-style hash of
   `` `${instrumentKey}|${bestBid ?? ''}|${bestAsk ?? ''}|${currency}` ``
   or FNV over that string (same idea as `src/contentFingerprint.ts`).
2. Compare to last written fp for that key (driver-side map).
3. **Append one line only if fp changed** (or first sighting).

Never log full depth ladders every tick unless debugging; this proof cares about **top-of-book stability**.

### Example line

```json
{"ts":"2026-08-01T14:31:05.000Z","instrumentKey":"sol:me:mint…","bestBid":10.2,"bestAsk":11.0,"spread":0.8,"mid":10.6,"currency":"SOL","fp":"a1b2c3d4"}
```

Wire-up:

```
PollEngine onSync → orderbookFeed.refreshAsks()
                 → optional refreshBids on a slower cadence
                 → for each instrumentKey: emit books.jsonl if fp changed
```

## 4. `health.jsonl`: per-provider latency, short-circuit, errors

Append **one object per provider pull attempt** that completed (success, short-circuit, soft-fail, or hard error). This is the uptime / ops series.

### Fields (minimum)

| Field | Source |
|-------|--------|
| `ts` | ISO now |
| `provider` | `SyncResult.provider` / error path id |
| `latencyMs` / `durationMs` | `SyncResult.durationMs` or `getMetrics()[id].latency_ms` |
| `shortCircuited` | `SyncResult.shortCircuited` |
| `fetched` / `upserted` / `unchanged` / `pruned` / `activeCount` | `SyncResult` |
| `builtAt` / `contentFingerprint` | result / `store.getMeta` |
| `errors` | count from `getMetrics()[id].errors` (cumulative) optional |
| `lastError` | `store.getWatermark(provider).lastError` |
| `lastSuccessfulPullAt` / `lastRowCount` | watermark (proves soft-fail did not wipe success stamps) |

### Example lines

```json
{"ts":"…","provider":"collectorcrypt","durationMs":180,"shortCircuited":true,"fetched":0,"upserted":0,"pruned":0,"activeCount":120,"lastError":null,"lastSuccessfulPullAt":"…","lastRowCount":120}
{"ts":"…","provider":"phygitals","durationMs":40,"shortCircuited":false,"softFail":true,"lastError":"soft-fail HTTP 500","lastSuccessfulPullAt":"2026-08-01T14:20:00.000Z","lastRowCount":42}
```

`PollEngine` with `logMetrics: true` already prints compact counters; `health.jsonl` is the durable form of the same idea.

## 5. Suggested driver loop

```
store = new ListingStore()
radar = new MultiSourceRadar({ store, providers, filter })  // optional one-shot seed
engine = new PollEngine({
  store, providers, filter,
  minIntervalMs: DEFAULT_PROVIDER_MIN_INTERVAL_MS,
  parallel: true,
  tickMs: 5_000,
  onSync(id, result) {
    append health.jsonl
    if (!result.shortCircuited && (result.upserted || result.pruned))
      append events.jsonl (new/reprice/closed)
    if soft lastError → events soft_fail
    maybeWriteSnapshot(id, result)  // first success per scope || checkpointMs
    orderbook?.refreshAsks()
    emitBooksIfFpChanged()
  },
  onError(id, err) {
    append health + events soft_fail
  },
})
orderbook = new OrderbookFeed({ listingStore: store, native: true, bidsProvider, … })
await orderbook.start()
engine.start()
// run until SIGINT → stop, optional final snapshots, set meta.endedAt
```

`MultiSourceRadar.syncAll` is ideal for **cold start** (one-shot, `shortCircuitOnBuiltAt: false` for explicit apply) and for documenting soft-fail isolation (`errors` map). **Steady state** should use `PollEngine` so live short-circuit (C) + min intervals avoid rewrite churn.

## 6. What the artifacts prove

| Claim | Artifact | What “good” looks like |
|-------|----------|------------------------|
| **Uptime** | `health.jsonl` continuous timestamps; `meta.json` start/end | Gaps only at configured `minIntervalMs`, not process death; process survives multi-hour wall clock |
| **Soft-fail isolation** | `events.jsonl` `soft_fail` + concurrent health lines for other providers; watermarks keep `lastSuccessfulPullAt` / `lastRowCount` | Phygitals (or any origin) 5xx → error line for that id only; CC/ME `activeCount` and scopes unchanged; no global store clear |
| **Change detection** | `events.jsonl` rate ≪ pull rate; `health.jsonl` high `shortCircuited` share when inventory quiet | Most ticks: short-circuit, **zero** listing events; real new/reprice/closed only when store would have upserted/pruned |
| **No full-dump thrash** | file sizes / line counts | `events.jsonl` and `books.jsonl` grow with **deltas**; `snapshots/` grow on `checkpointMs` order, not every `tickMs` |
| **Book fidelity** | `books.jsonl` + sparse listing snapshots | Top-of-book lines move when asks/bids move; stable books produce no extra lines (fp gate) |
| **Freshness** | watermark + meta fingerprints | `lastSuccessfulPullAt` advances on 304/short-circuit success; soft-fail does not advance success stamps |

### Quantitative checks (post-run)

1. `shortCircuited / pulls` on quiet markets should be high once warm (generation / equality path; see `docs/EFFICIENCY_SNAPSHOT.md`).
2. `count(events kind=soft_fail for P)` &gt; 0 does **not** imply drop in `activeCount` for Q ≠ P.
3. Between two snapshots for the same scope, applying ordered `new`/`reprice`/`closed` events reconstructs the later id→price map (allowing for soft-fail windows with no apply).
4. `books.jsonl` unique `(instrumentKey, fp)` sequence has no consecutive duplicate fps.

## Mapping to library primitives

| Concern | Code |
|---------|------|
| Scoped upsert + prune; no cross-provider wipe | `ListingStore.replaceScopeSnapshot` |
| Soft-fail watermark without clearing success | `ListingStore.markProviderError` / `markProviderSuccess` |
| Live poll + min intervals + parallel/RR | `PollEngine` |
| Fan-out one-shot + `errors` map | `MultiSourceRadar.syncAll` |
| 304 / fingerprint / equality skip rewrite | `syncOnce` → `SyncResult.shortCircuited` |
| Content generation id | `contentFingerprint` / `SnapshotMeta` |
| Pull latency counters | `http/metrics` (`getMetrics`) |
| Asks from listings; bids providers; best bid/ask | `OrderbookFeed` + `OrderbookStore.book` |

## Non-goals

- Replacing a production time-series DB. This layout is a local-disk proof run.
- Logging full order ladders or raw HTTP bodies every tick.
