# Runtime proof report

> Dated run artifact (not primary product docs).

**Generated:** 2026-08-01  
**Primary live run:** [`data/runs/proof-20260801T192239Z`](../data/runs/proof-20260801T192239Z/)  
**Harness:** `examples/runtime-monitor.ts` → `PollEngine` + `ListingStore` + `OrderbookFeed` (native) + `RunCapture`  
**Tests:** `npm test` — 15 files, **128 passed**, 16 skipped (green)

---

## Verdict

Live multi-origin session completed cleanly: **27/27 pulls succeeded** across collectorcrypt / magiceden / phygitals, **0 soft-fails**, **77.8% short-circuit**, listing/book artifacts are delta-only, and disk is **~16%** of a naive full-dump-every-pull baseline. Isolation under origin failure is evidenced by companion offline runs (softfail provider), not by a live 5xx in this window.

---

## Run identity

| Field | Value |
|-------|--------|
| `run_dir` | `data/runs/proof-20260801T192239Z` |
| `startedAt` | `2026-08-01T19:22:39.975Z` |
| `endedAt` | `2026-08-01T19:25:46.886Z` |
| **Uptime** | **186.9 s (~3.1 min)** |
| Providers | `collectorcrypt`, `magiceden`, `phygitals` |
| Filter | `tcg=pokemon`, `limit=15`, `sort=new` |
| `tickMs` / `minIntervalMs` | 5000 / 20000 |
| `parallel` | true |
| `orderbook` | true |
| `offline` | false |
| `checkpointMs` | 300000 |

Evidence: [`meta.json`](../data/runs/proof-20260801T192239Z/meta.json)

---

## Uptime & continuity

| Metric | Value |
|--------|--------|
| Wall clock | start → end set on meta; process exited cleanly |
| Health lines | 27 (one per completed pull) |
| First health | `2026-08-01T19:22:41.531Z` |
| Last health | `2026-08-01T19:25:40.568Z` |
| Max inter-pull gap (any provider) | **~24.8 s** (consistent with `minIntervalMs=20000` + RTT) |
| Gaps &gt; 60 s | **0** |
| Process death / stall | not observed |

Each provider recorded **9** pulls on ~20–25 s cadence after warm-up. No missing-provider hole in the series.

Evidence: [`health.jsonl`](../data/runs/proof-20260801T192239Z/health.jsonl)

---

## Pulls — success / fail / short-circuit per provider

All pulls completed without `softFail` or hard error (`lastError` always null).

| Provider | Pulls | Success | Soft-fail | Hard error | Short-circuited | Short-circuit rate | Avg `durationMs` | Final `activeCount` |
|----------|------:|--------:|----------:|-----------:|----------------:|-------------------:|-----------------:|--------------------:|
| collectorcrypt | 9 | 9 | 0 | 0 | 5 | **55.6%** | 467 | 15 |
| magiceden | 9 | 9 | 0 | 0 | 8 | **88.9%** | 599 | 16 |
| phygitals | 9 | 9 | 0 | 0 | 8 | **88.9%** | 1098 | 15 |
| **Total** | **27** | **27** | **0** | **0** | **21** | **77.8%** | — | 46 combined |

### Apply vs short-circuit (material store writes)

| Provider | Non-short (apply path) | Notes |
|----------|----------------------:|-------|
| collectorcrypt | 4 | Initial load + 3 inventory moves (`upserted`/`pruned` &gt; 0) |
| magiceden | 1 | Initial load only; rest fingerprint/equality short-circuit |
| phygitals | 1 | Initial load only; rest short-circuit |

Watermarks advanced on success including short-circuit: every final health line has non-null `lastSuccessfulPullAt` and stable `lastRowCount` matching `activeCount`.

---

## Listing change events

File: [`events.jsonl`](../data/runs/proof-20260801T192239Z/events.jsonl) — **60 lines**, kinds only on material change.

| Kind | Count |
|------|------:|
| `new` | 53 |
| `closed` | 7 |
| `reprice` | 0 |
| `soft_fail` | 0 |

| Provider | `new` | `closed` |
|----------|------:|---------:|
| collectorcrypt | 22 | 7 |
| magiceden | 16 | 0 |
| phygitals | 15 | 0 |

**Change vs pull rate:** 60 event lines vs 27 pulls; after cold start (~46 `new` at first apply), subsequent events are sparse and only on collectorcrypt inventory churn — short-circuit ticks produce **zero** listing events (as specified in `docs/RUNTIME_PROOF.md`).

---

## Book updates

File: [`books.jsonl`](../data/runs/proof-20260801T192239Z/books.jsonl)

| Metric | Value |
|--------|------:|
| Lines | 52 |
| Unique `instrumentKey` | 52 |
| Consecutive duplicate fps | **0** |
| Currency | USDC (top-of-book; many lines bid-only in this window) |

Fp gate holds: no consecutive same-fp lines per instrument. Books are not rewritten every tick.

---

## Snapshots (sparse)

Directory: [`snapshots/`](../data/runs/proof-20260801T192239Z/snapshots/)

| File | Listings | Bytes |
|------|--------:|------:|
| `collectorcrypt__727eec06__2026-08-01T19-22-41-531Z.json` | 15 | 54 445 |
| `magiceden__727eec06__2026-08-01T19-22-41-532Z.json` | 16 | 46 524 |
| `phygitals__727eec06__2026-08-01T19-22-41-533Z.json` | 15 | 96 129 |
| `collectorcrypt__727eec06__2026-08-01T19-25-46-885Z.json` | 15 | 53 315 |

First-success snapshot per scope at t≈start; final collectorcrypt snapshot at stop. **Not** one dump per pull (would have been 27 full scopes).

---

## Soft-fail isolation / cross-origin poisoning

### Live run (`proof-20260801T192239Z`)

- **No origin soft-fail occurred** (all three live APIs healthy for the window).
- Negative proof of poisoning: while collectorcrypt applied inventory changes (`upserted`/`pruned` mid-run), magiceden and phygitals kept stable `activeCount` (16 / 15) and continued short-circuiting — no global store wipe.

### Offline isolation companions (same harness)

| Run | Providers | Soft-fail pulls | Peer active during soft-fail |
|-----|-----------|----------------:|------------------------------|
| `data/runs/2026-08-01T19-21-04Z` | fixture, fixture_b, softfail | softfail 10/10 | fixture & fixture_b stay **activeCount=5**, `lastError=null` |
| `data/runs/2026-08-01T19-21-48Z` | same | softfail 9/9 | peers stay 5 / healthy |
| `data/runs/2026-08-01T19-22-21Z` | same | softfail 3/3 | peers stay 5 / healthy |

**Conclusion:** one origin failure does **not** poison siblings — softfail-only errors leave fixture scopes intact (health concurrent lines + watermarks). Live path did not need to absorb a 5xx in this sample.

---

## Storage vs naive full-dump estimate

| Component | Bytes |
|-----------|------:|
| `meta.json` | 470 |
| `health.jsonl` | 9 230 |
| `events.jsonl` | 16 327 |
| `books.jsonl` | 11 045 |
| `snapshots/*` (4 files) | 250 413 |
| **Actual total** | **287 485 (~281 KiB)** |

**Naive baseline:** write a full per-provider scope dump on **every** health pull, sized from observed snapshot bytes:

- collectorcrypt ≈ 54 445 × 9 pulls  
- magiceden ≈ 46 524 × 9  
- phygitals ≈ 96 129 × 9  

→ **naive ≈ 1 773 882 bytes (~1.73 MiB)**

| | |
|--|--:|
| Actual / naive | **0.162 (~16%)** |
| Savings | **~84%** |

Even this understates long-run efficiency: after warm-up most ticks only append compact health lines (and rare events/books), while naive keeps rewriting ~50–96 KiB scopes every ~20 s per origin.

---

## Claim checklist (from `docs/RUNTIME_PROOF.md` §6)

| Claim | Result |
|-------|--------|
| Uptime | Pass — continuous health, max gap ~25 s, clean `endedAt` |
| Soft-fail isolation | Pass offline; live window had no soft-fail (peers stable under CC churn) |
| Change detection | Pass — 77.8% short-circuit; events only on material new/closed |
| No full-dump thrash | Pass — 4 snapshots vs 27 pulls; actual ~16% of naive |
| Book fidelity | Pass — 52 fp-gated updates, 0 consecutive dup fps |
| Freshness | Pass — `lastSuccessfulPullAt` advances on short-circuit success |

---

## Evidence paths

```
data/runs/proof-20260801T192239Z/meta.json
data/runs/proof-20260801T192239Z/health.jsonl
data/runs/proof-20260801T192239Z/events.jsonl
data/runs/proof-20260801T192239Z/books.jsonl
data/runs/proof-20260801T192239Z/snapshots/
data/runs/2026-08-01T19-21-04Z/   # offline soft-fail isolation
data/runs/2026-08-01T19-21-48Z/
data/runs/2026-08-01T19-22-21Z/
docs/RUNTIME_PROOF.md             # layout + claim definitions
examples/runtime-monitor.ts       # harness
```

## Tests

```
npm test  # vitest run — 15 files, 128 passed, 16 skipped
```
