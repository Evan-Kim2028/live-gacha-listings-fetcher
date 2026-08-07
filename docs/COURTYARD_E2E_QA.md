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

### 1. Retrievable book ≈ 1.8k–3.1k rows and the boundary moves
Algolia `nbHits` for the pokemon facet is ~219k, but deep pagination returns
empty pages after ~1.8k–3.1k hits and the cutoff shifts between runs (and the
index churns ~1–2k rows/day). `pullAll` treats the empty-page stop as a
complete walk (`hasMore=false`, `total` = rows actually retrieved), so the
store's scope matches what the API will ever give us. The sync
`suspiciouslySmall`/`massDrop` guards (≥50% shrink / >10% missing) keep a
shrunken walk from mass-pruning a prior larger book — verified: run 2 (1,844
rows) against run 1's 3,076-row book pruned only 6 rows (real churn), not 1,200.

### 2. Field quality is high
Name / price / currency / externalUrl / imageUrl / listedAt / tcg / setRaw at
100%. `year` 99%. Grader+grade 79–84% (the rest are ungraded, sealed packs,
etc.). No dupes, stable ids (page-0 re-pull returns identical id sets).

### 3. ~2.4% of the book is price-vs-FMV anomalies (cleanup candidates)
45 rows (of 1,844) priced > 10× their own `estimatedValueUsd` — e.g.:
- 1999 Team Rocket Dark Dragonite CGC 8.5: $56,850 vs FMV $61.10
- 2023 Temporal Forces Torterra ex CGC 9: $13,900 vs FMV $14.30
- Booster packs listed at $3,000–$6,000 vs FMV ~$4–5

These are almost certainly fat-finger / hold-price listings, not real asks.
They distort price stats (mean $218 vs median $45) and delta (mean +736% vs
median +4%). Recommendation: when curating, filter `delta` (or price>10×FMV)
out of trade signals — the fetcher still captures them faithfully; curation
decides what's tradable.

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
