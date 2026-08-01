# Trader experience

Read-only surfaces for host UIs and operators: alerts, watchlist, health, listing age, deep-links, and origin-only FMV. Core never buys, lists, offers, or signs transactions.

**Sold / delisted (leave-book):** poll-diff prune → `applyDelistsFromSync` → orderbook clear + `sold.jsonl` (`delisted_or_sold`). Soft-fail never wipes inventory. See [`docs/SOLD_TAKEDOWN.md`](SOLD_TAKEDOWN.md).

## Alerts (`src/trader/alerts.ts`)

`AlertEngine` diffs scope listings into trader events:

| Kind | When |
|------|------|
| `new_listing` | id not seen in this scope |
| `reprice` | known id, `price` changed |
| `closed` | id left the scope snapshot |
| `soft_fail` | empty soft-fail / `lastError` (ops surface; no listing required) |
| `under_fmv` | origin already set `fmv` + `delta`, and `delta < 0` |

- `onSyncResult`: short-circuit → no listing alerts; soft-fail → `soft_fail` only; else `onListingsDiff`.
- `under_fmv` uses `hasOriginUnderFmv` / `underFmvAlertIfAny` only. Core never invents FMV.
- `alertMatches` / `filterAlerts` apply `PullQuery` (`maxDelta`, `requireFmv`, tcg, platform, price bands) via `listingMatchesFilter`. Soft-fail always passes.

## Watchlist (`src/watchlist.ts`)

Client-side OR filter. Empty watchlist matches everything.

- **Axes:** `names` (substring on name / setRaw / searchBlob), `instrumentKeys` (exact), `ids` (mint / nativeId / id / cardNumber / scrydex / contract).
- **Helpers:** `listingMatchesWatchlist`, `mergeWatchlists`, `parseWatchlistString` (prefixes `name:`, `key:`, `id:` / `mint:` / `card:`; bare long base58/hex → id), `loadWatchlistFile` (JSON object/array or CSV/lines), `watchlistSignature` for query scope.

## Health (`src/trader/health.ts`)

`traderHealthSummary({ store, poll?, metrics?, pollStats? })` merges:

- `ListingStore` watermarks (`lastSuccessfulPullAt`, `lastError`, `lastRowCount`, `lastBuiltAt`)
- HTTP metrics (`pulls`, `errors`, `latency_ms`)
- `PollEngine` stats (`syncs`, `shortCircuits`, `shortCircuitRate`)

`formatHealthHud` prints a terminal multi-line table (see `examples/trader-hud.ts`). Soft-fail on one origin does not clear sibling watermarks.

## Listing age (`src/listingAge.ts`)

- `withLastSeenAt(listing, fetchedAt)` stamps `lastSeenAt` if missing (prefer page `fetchedAt`).
- `listingAgeMs` returns ms since `lastSeenAt`, or `null` if unknown.
- `isStale(listing, maxAgeMs)` is true when age exceeds policy or `lastSeenAt` is unusable. Host UIs grey out after soft-fail windows (e.g. 2–3× poll interval).

## Links (`src/externalUrl.ts` + `src/trader/deepLinks.ts`)

Deep-link helpers open marketplace pages only. No transaction, private key, or place-order APIs.

| Helper | Target |
|--------|--------|
| `listingOpenUrl(listing)` | prefer `externalUrl`; else rebuild per platform (cc/me/courtyard/phygitals/renaiss/dyli) |
| `formatOpenHint(listing)` | CLI shell open string from `listingOpenUrl` (e.g. `open 'https://…'`) |
| `ccListingUrl(mint)` | collectorcrypt.com/cards/{mint} |
| `meListingUrl(mint)` | magiceden.io/item-details/{mint} |
| `phygitalsListingUrl(slugOrAddress)` | phygitals.com/card/… |
| `courtyardListingUrl(tokenId)` | courtyard.io/asset/… |
| `renaissListingUrl(tokenId)` | renaiss.xyz/card/{tokenId} |
| `dyliListingUrl(id)` | dyli.io/p/{id} |
| `originProvidedUrl(row)` | first of `external_url` / `externalUrl` / `url` / `href` if http(s) |
| `formatOpenCommand(url)` | `open` / `xdg-open` / `cmd start` shell string |

CLI: `radar --urls` → `id\topenUrl` lines (see `docs/DEEP_LINKS.md`).

## FMV policy (origin fields only)

**Invariants:**

1. Normalize passes through origin-provided fair value only; derive `delta` from ask vs that FMV when both are numeric and FMV > 0.
2. If the API omits FMV → `fmv: null`, `delta: null` (keep the ask).
3. `requireFmv` / `maxDelta` are **client filters** on already-normalized rows, not oracle fetches.
4. `under_fmv` alerts fire only when origin already set both fields and `delta < 0`.
5. **Do not** embed PriceCharting, TCGPlayer, or other external FMV oracles in core sync / provider normalize.

**Optional future plugin (not implemented in this library):** an `FmvProvider` (or similar post-plugin) may enrich derived fields **outside** `syncOnce` / provider normalize. Core remains origin-passthrough only.

| Source | Typical origin field | Listing |
|--------|----------------------|---------|
| Collector Crypt | `insuredValue` | `fmv`, `delta` % when fmv > 0 |
| Magic Eden | token attributes (e.g. insured value on CC NFTs) | `fmv`/`delta` or null |
| Long-tail | Beezie/Phygitals `altFmv`, Renaiss `fmvPriceInUSD`, Courtyard estimates | missing / `NO-FMV` → null |

See also `docs/BOOTSTRAP_FULL_BOOK.md` § FMV / delta.

## Module map

| Concern | Path |
|---------|------|
| Alerts + types | `src/trader/alerts.ts`, `src/trader/types.ts` |
| Health HUD | `src/trader/health.ts` |
| Package re-exports | `src/trader/index.ts`, `src/index.ts` |
| Watchlist | `src/watchlist.ts` |
| Age | `src/listingAge.ts` |
| Links | `src/externalUrl.ts`, `src/trader/deepLinks.ts` |
| Demo HUD | `examples/trader-hud.ts` |
| Tests | `tests/trader-alerts.test.ts`, `tests/trader-health.test.ts`, `tests/listing-age.test.ts`, `tests/trader-deep-links.test.ts` |
