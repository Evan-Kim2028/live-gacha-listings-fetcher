# FMV: origin normalize vs optional plugins

**Policy:** The FMV plugin path is **optional enrichment for nulls only**. Origin-normalized `fmv` always wins. `applyFmvPlugins` never overwrites a non-null origin FMV; it only fills rows where `fmv == null` and recomputes `delta` from `price` vs the plugin FMV. No network oracle ships in core. Hosts pass their own `FmvProvider`s (or `FixtureFmvProvider` in tests). Call plugins **outside** `syncOnce` / provider `normalize*`.

```ts
import { applyFmvPlugins, type FmvProvider } from "traded-listings";

// After radar/store pull, not inside provider normalize
const enriched = await applyFmvPlugins(listings, plugins);
```

| Rule | Behavior |
|------|----------|
| Origin wins | `listing.fmv != null` → row unchanged |
| Nulls only | Plugins see only pending rows with `fmv == null` |
| Delta | On fill: `delta = round(((price - fmv) / fmv) * 100)` when fmv > 0 |
| Errors | Soft-skip plugin / row; try next plugin |
| Empty plugins | No-op passthrough (null stays null) |

## Sources that already set `fmv` without a plugin

These paths set `Listing.fmv` (and usually `delta`) in provider `normalize*` from origin fields. No plugin required.

| Source | Normalize | Origin field → `fmv` | Notes |
|--------|-----------|----------------------|--------|
| **Collector Crypt** | `normalizeCcCard` | `card.insuredValue` | Numeric when present; else `null`. Delta when fmv > 0. |
| **Magic Eden** | `normalizeMeListing` | Token attr **`insured value`** (CC-style NFTs) when present and finite | Not collection `stats.floorPrice`. Floor stays origin listing/stats price context only. Missing attr → `fmv: null`. |
| **Phygitals** | `normalizePhygitalsRow` | `row.altFmv` | Missing/empty → null; delta when fmv > 0. |
| **Beezie** | `normalizeBeezieRow` | `row.altFmv` | Missing/empty → null; delta left null. |
| **Renaiss** | `normalizeRenaissRow` | `row.fmvPriceInUSD` | `"NO-FMV"` / empty → null; delta when fmv > 0. |
| **Long-tail generic** | `normalizeLongtailRow` | `row.fmv` (fixtures / flexible shapes) | Dispatches to Phygitals/Beezie/Renaiss/DYLI when shapes match. |
| **Courtyard** | `normalizeCourtyardAlgoliaHit` | `hit.estimatedValueUsd` | Fixture path may pass `row.fmv`. |
| **DYLI** | `normalizeDyliRow` | *(none)* | Always `fmv: null` until a plugin. |

### traded.gg — reference only

`normalizeTradedRow` **passes through** `row.fmv` / `row.delta` when the aggregator already set them. traded.gg is **not** on the default native registry (`createDefaultProviders` / `createSolanaProviders`). It is an optional reference adapter for UX/field shape, not a required FMV source. Do not treat it as the production path for FMV.

## When plugins help

Use `applyFmvPlugins` only for rows origins left null (e.g. DYLI, ME listings without insured-value attr, missing `altFmv` / `insuredValue`). Host oracles (PriceCharting, TCGPlayer, internal books) implement `FmvProvider.enrich` / `enrichMany`.

**Code map**

| Concern | Path |
|---------|------|
| Plugin apply (origin wins) | `src/fmv/applyFmvPlugins.ts` |
| `FmvProvider` seam | `src/fmv/FmvProvider.ts` |
| Delta helper | `src/fmv/delta.ts` |
| Test fixture plugin | `src/fmv/FixtureFmvProvider.ts` |
| CC / ME / longtail / traded normalize | `src/providers/collectorcrypt.ts`, `magiceden.ts`, `longtail.ts`, `tradedgg.ts`, `courtyard.ts` |

See also: `docs/BOOTSTRAP_FULL_BOOK.md` § FMV / delta, `docs/TRADER_EXPERIENCE.md` § FMV policy.
