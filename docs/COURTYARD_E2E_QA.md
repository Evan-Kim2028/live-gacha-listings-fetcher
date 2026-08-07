# Courtyard end-to-end QA (2026-08-07)

Run: `examples/courtyard-e2e-qa.ts` — bootstrap full Pokémon book → quality checks → curation → warm poll with delist cleanup. Emits `data/runs/courtyard-e2e-<iso>/report.json` and persists `data/books/courtyard-pokemon/` (both gitignored under `data/`).

```bash
npx tsx examples/courtyard-e2e-qa.ts --seconds 60
npx tsx examples/courtyard-e2e-qa.ts --watch 'charizard,umbreon,eevee'
```

## Measured (two full runs, 2026-08-07)

| Metric | Run 1 | Run 2 |
|--------|-------|-------|
| Bootstrap duration | 5.7s | 7.1s |
| Rows fetched (pokemon, full walk) | 3,076 | 1,844 |
| Duplicate ids | 0 | 0 |
| Errors / soft-fails | 0 | 0 |
| Price coverage | 100% | 100% |
| Grader/grade coverage | 79% (2,420 graded slabs) | 84% |
| Year coverage | 99% | ~99% |
| FMV coverage | 100% | 100% |
| Listed today | 1,417 (46%) | 1,188 (64%) |
| Listed last 7d | 2,590 (84%) | 1,694 (92%) |
| Stale (no listedAt in 7d) | 0 | 0 |
| Warm 45–60s: upserts / prunes | 8 / 1 | 19 / 6 |

## Findings

### 1. Retrievable book ≈ 1.2k–5k rows and the window moves
Algolia `nbHits` for the pokemon facet is ~232k, but pagination returns empty
pages beyond a **5,000-hit ceiling** (verified at 20/48/100 hits-per-page:
page×size ≥ 5,000 is always empty; the site's 105-page pager × 48 = ~5,040 is
the same ceiling). The deep range is additionally unstable: the retrievable
window observed on 2026-08-07 ranged **1,203 → 5,000** rows (index churn + DSN
edge caching can briefly serve deep pages, then go empty). `pullAll` treats the
first empty page as the end of the retrievable set (`hasMore=false`, honest
total), so the store's scope matches what the API will give us. The sync
`suspiciouslySmall`/`massDrop` guards (≥50% shrink / >10% missing) keep a
shrunken window from mass-pruning a prior larger book — verified: a 1,203-row
walk against a 2,700-row book pruned only real churn, not the difference.

### 2. Field quality is high
Name / price / currency / externalUrl / imageUrl / listedAt / tcg / setRaw at
100%. `year` 99%. Grader+grade 79–84% (the rest are ungraded, sealed packs,
etc.). No dupes, stable ids (page-0 re-pull returns identical id sets).

### 3. ~1.6–3.4% of the book is price-vs-FMV anomalies (cleanup candidates)
Rows priced > 10× their own `estimatedValueUsd`. Re-examined 2026-08-07: the
class is **systematic, not random fat-fingers** — sampled 20 anomalies, 14 were
sealed booster packs at 700–1,300× FMV (e.g. Battle Partner boosters at
$3,200–$6,100 vs FMV ~$4.40, same product at multiple prices), 6 graded cards,
0 chase/anchor cards. Pattern fits deliberate placeholder/hold prices from
Courtyard's own data pipeline (probably bulk-imported sealed SKUs). They
distort price stats (mean $218 vs median $45) and delta (mean +736% vs median
+4%). Recommendation: when curating, filter `delta` (or price>10×FMV) out of
trade signals — the fetcher still captures them faithfully; curation decides
what's tradable.

### 4. Delist cleanup works end-to-end
Warm poll pruned 1–6 rows per tick that left the retrievable set, captured as
`delistEvents` in the report; book net change tracked correctly; zero errors.

## Ops notes
- Courtyard is Polygon; Algolia browse is public, ~4–7s for a full walk, no
  auth, WAF-sensitive to bare-curl UA on the orderbook REST routes only.
- `syncOnce`-driven flows now use `pullAll` (added in this change) so
  bootstrap/warm get the full book instead of one 100-row page.
- Keep Courtyard opt-in (`--solana --courtyard`) — cross-chain breadth, not
  part of the default Solana purity set.
