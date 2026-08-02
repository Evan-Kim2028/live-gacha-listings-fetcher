# Sold / takedown product model (native Solana radar)

How listings leave the live book on the **Solana-native** path: poll-diff is primary; soft-fail and incomplete pages never wipe inventory; orderbook sold events capture last top-of-book, not proven on-chain fills.

**Scope:** `createSolanaProviders()` defaults — `collectorcrypt`, `magiceden` (`collector_crypt`), `phygitals`. Beezie is **opt-in EVM** (`includeBeezie` / `includeEvm`), not Solana-native. traded.gg SSE is **not** on this path; it remains the only source of explicit `closed` wire events.

**Primary code:** `src/sync.ts` (`syncOnce`), `src/store.ts` (`replaceScopeSnapshot`, soft-fail paths), `src/lifecycle/delist.ts` (`applyDelistsFromSync`), `src/aggregate/MultiSourceRadar.ts` + `PollEngine` (call apply after each `SyncResult` with `pruned > 0`), `src/orderbook/OrderbookFeed.ts` (`refreshAsks` / `syncAsksFromListings`, sold `reason: delisted_or_sold`), `src/capture/types.ts` + `RunCapture.onSold`, `examples/runtime-monitor.ts`.

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
| Incomplete page: prior scope non-empty **and** `hasMore === true` | Upsert only; keep prior meta stamps where needed | **No** (`incomplete_page_no_prune`) |
| Thrown pull | Error watermark; prior scope intact | **No** |
| HTTP 304 / generation / content short-circuit | Confirm presence; refresh age | **No** |
| Complete full-scope apply (`hasMore === false`) | `replaceScopeSnapshot` | **Yes** — ids missing from page (even if the page is smaller than prior scope) |

Rationale: origin 5xx, partial pagination (`hasMore`), or warm “first page only” must never look like a mass sale. A **smaller complete** page (`hasMore === false`) is a full reconcile and **may prune** absences (sold/delisted). Host UIs grey-out via `isStale(listing, maxAgeMs)` when soft-fail freezes `lastSeenAt`.

**Phygitals** is on the same poll-diff delist path as CC/ME:

- **5xx soft-empty** → empty page + `lastError`; never throws; **never prunes** prior scope (`soft_fail_no_prune`).
- **Successful full `listedStatus=listed` page** with `hasMore === false` → may prune ids absent from the page (`missing_from_full_snapshot`); hosts can run `applyDelistsFromSync(result, orderbook, capture)` (or `OrderbookFeed.refreshAsks()`).

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
| **Collector Crypt** | **Absence** from `GET /marketplace?marketplaceStatus=Buy now` after a **complete** multi-page `pullAll` (bootstrap/warm until `!hasMore`) | Provider always sets `marketplaceStatus=Buy now`. No bulk sold SSE/endpoint — do not invent one. Card `status` (e.g. `Transferred`) is catalog ownership, not listing sold; remaining rows keep `lastEvent: LIST`. CDN `s-maxage≈30`. Fixture: `tests/collectorcrypt.test.ts` (delist / prunedIds). |
| **Magic Eden** (`collector_crypt`) | Drop from collection `listings` array (`/v2/collections/{symbol}/listings`) | **Poll-diff only** (see §6.1). Multi-page `pullAll` required for correct prune. No bulk sold SSE in this lib. |
| **Phygitals** | Drop while `listedStatus=listed` (docs browse params) | Participates in poll-diff delist. Soft-empty 5xx + `lastError` — **never** prunes. Successful complete listed page (`hasMore === false`) **may prune** absences. Multi-page `pullAll` for bootstrap. No native sold SSE. |

**All three:** no marketplace-native SSE for list/delist on the Solana radar path today. Freshness = `PollEngine` parallel poll (typical `minIntervalMs` 15–30s; CC floor driven by CDN ~30s).

**Not default Solana:** Beezie (EVM opt-in), Courtyard (Polygon), traded.gg (reference / legacy SSE only).

### 6.1 Magic Eden `collector_crypt` — poll-diff only (no bulk sold SSE)

This library does **not** wire a Magic Eden bulk sold / activity SSE or websocket. ME leave-book is **poll-diff only**:

1. **Full multi-page pull** — `syncOnce` prefers `MagicEdenProvider.pullAll` → `pullPages` over `GET /v2/collections/collector_crypt/listings` with `offset`/`limit` (page ≤ 100) until short page / `!hasMore` or `maxPages` (`bootstrap: true` raises the cap).
2. **Missing mint/listing → prune** — after a **complete** full-scope snapshot, `ListingStore.replaceScopeSnapshot` deletes ids that were in the prior scope but absent from the new page set (`SyncResult.prunedIds`). Reason `missing_from_full_snapshot`, source `poll_diff` via `applyDelistsFromSync`.
3. **No prune when incomplete or soft-fail** — warm single page with `hasMore: true`, mid-pagination soft-fail (partial rows + incomplete), or soft-fail empty + `lastError` never mass-deletes prior inventory.
4. **Operator rule** — warm full-book monitors must re-walk the **same** multi-page scope as cold seed (same `limit` / `maxPages` / `bootstrap`). A first-page-only warm poll against a multi-page book is incomplete and will **not** delist missing mints.

Identity: listing id is `magiceden:me:{pdaAddress|mint}`; prune key is that id (token mint on `tokenId` for deep links / bids).

There is **no** ME bulk sold feed in this lib today; optional Helius / ME activity streams (§7) may reduce detect latency but must not replace full-scope reconcile as truth for “still listed.”

---

## 7. Future optional: faster ME/CC list events

Optional upgrades (not required for correct poll-diff sold/takedown):

- **Helius** (or similar) websocket / webhook for Solana program/list events involving CC / ME mints.
- **Magic Eden** websocket or activity feed for collection list/delist, if product-grade and auth-stable.

These would reduce detect latency vs poll interval; they must still respect soft-fail / incomplete rules and must not replace full-scope reconcile as the source of truth for “still listed.” ME remains poll-diff-only in this library until such a feed is explicitly wired.

---

## End-to-end (runtime monitor)

```
PollEngine tick (createSolanaProviders — no Beezie unless includeBeezie)
  → syncOnce per origin (scoped upsert+prune or soft/incomplete no-prune)
  → if pruned > 0: applyDelistsFromSync(result, orderbook, capture)
      → DelistEvent(reason=missing_from_full_snapshot, source=poll_diff)
      → clear ask / residual bids; RunCapture.onSold(reason=delisted_or_sold|ask_removed)
      → onDelist log lines
  → RunCapture listing diffs (full mode only: new / reprice / closed / soft_fail)
  → OrderbookFeed.refreshAsks() (reconcile residual sold)
  → RunCapture.onSold → sold.jsonl (always; events.jsonl mirror only in full mode)
```

Same delist apply runs on `MultiSourceRadar.syncAll` / `bootstrapAll` when `pruned > 0`.

Lean capture (`--bootstrap` default on `runtime-monitor`, or `RunCapture.open(dir, { lean: true })`) keeps **sold.jsonl + health.jsonl** only — sufficient for sold audit without fat events/run-snapshots.

See `examples/runtime-monitor.ts` (`--bootstrap` warm full re-walk so prune/sold is correct), `docs/BOOTSTRAP_FULL_BOOK.md`, `docs/TRADER_EXPERIENCE.md`, `docs/RUNTIME_PROOF.md`, `docs/NATIVE_SOURCES.md`.
