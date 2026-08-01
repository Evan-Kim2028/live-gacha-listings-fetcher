# Sold / takedown product model (native Solana radar)

How listings leave the live book on the **Solana-native** path: poll-diff is primary; soft-fail and incomplete pages never wipe inventory; orderbook sold events capture last top-of-book, not proven on-chain fills.

**Scope:** `createSolanaProviders()` defaults — `collectorcrypt`, `magiceden` (`collector_crypt`), `phygitals`. Beezie is **opt-in EVM** (`includeBeezie` / `includeEvm`), not Solana-native. traded.gg SSE is **not** on this path; it remains the only source of explicit `closed` wire events.

**Primary code:** `src/sync.ts` (`syncOnce`), `src/store.ts` (`replaceScopeSnapshot`, soft-fail paths), `src/orderbook/OrderbookFeed.ts` (`refreshAsks` / `syncAsksFromListings`), `src/capture/types.ts` + `RunCapture.onSold`, `examples/runtime-monitor.ts`.

---

## 1. Poll-diff is primary

On each successful **full-scope** re-pull for `(provider, querySignature)`:

1. Provider returns the current page set (cold/warm `pullAll` / bootstrap walk until `!hasMore` or `maxPages`).
2. `ListingStore.replaceScopeSnapshot` upserts present ids and **prunes** ids that were in the prior scope but missing from the new set.
3. Pruned rows are **delisted or sold** from the radar’s point of view (`closed` in listing change logs; orderbook `sold` when the instrument has no asks left).

Warm full-book monitors must re-walk the same filter / `querySignature` as cold seed (see `docs/BOOTSTRAP_FULL_BOOK.md`). A single-page warm poll against a large book is treated as incomplete (no prune) — see §2.

```
full snapshot N          full snapshot N+1
{ A, B, C }      →       { A, C }     ⇒  B pruned (missing_from_full_snapshot)
```

Not modified (HTTP 304), generation hits (etag / contentFingerprint), and content-equality short-circuits refresh `lastSeenAt` but **do not** prune.

---

## 2. NEVER prune on soft-fail empty or incomplete page

| Condition | Store effect | Prune? |
|-----------|--------------|--------|
| Soft-fail empty: `provider.lastError` set **and** `page.listings.length === 0` | `markProviderError`; keep prior scope; **do not** touch `lastSeenAt` | **No** (`soft_fail_no_prune`) |
| Incomplete page: prior scope non-empty **and** (`hasMore === true` **or** page id-set smaller than prior scope with rows present) | Upsert only; keep prior meta stamps where needed | **No** (`incomplete_page_no_prune`) |
| Thrown pull | Error watermark; prior scope intact | **No** |
| HTTP 304 / generation / content short-circuit | Confirm presence; refresh age | **No** |
| Complete full-scope apply | `replaceScopeSnapshot` | **Yes** — ids missing from page |

Rationale: origin 5xx, partial pagination, or warm “first page only” must never look like a mass sale. Host UIs grey-out via `isStale(listing, maxAgeMs)` when soft-fail freezes `lastSeenAt`.

Phygitals is the textbook soft-empty origin (5xx → empty page + `lastError`; never throws; never prunes prior scope).

---

## 3. Orderbook: ask remove → zero asks → clear bids + TOB

After each successful listing sync tick, native monitors call `OrderbookFeed.refreshAsks()` (rebuilds asks from `ListingStore`):

1. **Remove ask** for every listing that left the store (per-provider `replaceAsksForProvider`).
2. If an **instrument** has **zero asks** left after prune:
   - Snapshot **pre-clear** top-of-book (`bestBid` / `bestAsk`).
   - `clearInstrument` — clear residual **bids** as well as asks.
   - Emit `InstrumentSoldEvent` (`kind: "sold"`, `reason: "delisted_or_sold"`).
3. Record **`lastBestBid`** / **`lastBestAsk`** (and optional `listingIds`, currency) on the event and in `sold.jsonl` via `RunCapture.onSold`.

`lastBestAsk` is the listed ask price at disappearance; `lastBestBid` is the best sampled bid immediately before clear (often null if bids were not refreshed).

---

## 4. Reason codes

### Prune / no-prune decisions (product)

| Code | Meaning |
|------|---------|
| `missing_from_full_snapshot` | Id was in prior scope; absent from a complete full-scope re-pull → store prune (`closed`) |
| `soft_fail_no_prune` | Soft-fail empty (or equivalent origin error empty page) → **no** prune |
| `incomplete_page_no_prune` | Partial / `hasMore` page vs larger prior scope → upsert only, **no** prune |
| `explicit_closed` | traded.gg SSE `type: "closed"` → `store.removeOne` (**traded.gg only**; not Solana native) |

### Orderbook / capture sold payload

`InstrumentSoldEvent.reason` / `SoldRecord.reason` (code today):

| Value | When |
|-------|------|
| `delisted_or_sold` | Instrument had asks, then zero asks after listing prune (poll path) |
| `ask_removed` | Reserved / alternate ask-side remove without full instrument clear semantics |

Listing change log kinds (`ListingChangeKind`): `new` | `reprice` | `closed` | `soft_fail` — `closed` aligns with successful prune (`missing_from_full_snapshot`); `soft_fail` aligns with `soft_fail_no_prune`.

---

## 5. Confidence (do not over-claim sale)

| Claim | Valid? |
|-------|--------|
| Listing left the provider’s full listed snapshot | Yes (poll absence after complete pull) |
| Proven on-chain sale / fill price | **No** from poll alone |
| `lastBestAsk` = fill price | **No** — it is the **listed price at disappearance** |
| `lastBestBid` = counterparty bid at fill | **No** — last sampled TOB bid, if any |

True fill price needs marketplace trade history or chain/indexer events (future). Operators should treat `sold.jsonl` as **delist / leave-book** evidence with last known TOB, not settlement truth.

---

## 6. Per-provider notes (Solana default set)

| Provider | Id leave signal | Notes |
|----------|-----------------|--------|
| **Collector Crypt** | Drop from browse with `marketplaceStatus=Buy now` | Full multi-page walk required for correct prune; CDN `s-maxage≈30`. No native sold SSE. |
| **Magic Eden** (`collector_crypt`) | Drop from collection `listings` array (`/v2/collections/{symbol}/listings`) | Offset/limit pagination; incomplete warm page must not prune. No native sold SSE. |
| **Phygitals** | Drop while `listedStatus=listed` (docs browse params) | Soft-empty + `lastError` on outage — **never** prunes. Multi-page `pullAll` for bootstrap. No native sold SSE. |

**All three:** no marketplace-native SSE for list/delist on the Solana radar path today. Freshness = `PollEngine` parallel poll (typical `minIntervalMs` 15–30s; CC floor driven by CDN ~30s).

**Not default Solana:** Beezie (EVM opt-in), Courtyard (Polygon), traded.gg (reference / legacy SSE only).

---

## 7. Future optional: faster ME/CC list events

Optional upgrades (not required for correct poll-diff sold/takedown):

- **Helius** (or similar) websocket / webhook for Solana program/list events involving CC / ME mints.
- **Magic Eden** websocket or activity feed for collection list/delist, if product-grade and auth-stable.

These would reduce detect latency vs poll interval; they must still respect soft-fail / incomplete rules and must not replace full-scope reconcile as the source of truth for “still listed.”

---

## End-to-end (runtime monitor)

```
PollEngine tick
  → syncOnce per origin (scoped upsert+prune or soft/incomplete no-prune)
  → RunCapture listing diffs (new / reprice / closed / soft_fail)
  → OrderbookFeed.refreshAsks()
      → remove asks for gone listings
      → if instrument ask count == 0: clear bids, emit sold(lastBestBid, lastBestAsk)
  → RunCapture.onSold → sold.jsonl (+ events.jsonl mirror)
```

See `examples/runtime-monitor.ts` (`--bootstrap` warm full re-walk so prune/sold is correct), `docs/BOOTSTRAP_FULL_BOOK.md`, `docs/RUNTIME_PROOF.md`, `docs/NATIVE_SOURCES.md`.
