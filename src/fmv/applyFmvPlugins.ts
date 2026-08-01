import type { Listing } from "../types.js";
import type { FmvProvider } from "./FmvProvider.js";
import { deltaFromPriceAndFmv } from "./delta.js";

/**
 * Apply FMV plugins to a listing snapshot.
 *
 * - Origin wins: if `listing.fmv != null`, the row is left unchanged.
 * - Only null `fmv` (and resulting `delta`) are filled by plugins.
 * - When a plugin sets `fmv`, `delta` is recomputed from `price` vs that FMV.
 * - Plugin errors soft-skip (try next plugin / keep row as-is).
 *
 * Does not call network oracles by itself — only the provided plugins run.
 */
export async function applyFmvPlugins(
  listings: readonly Listing[],
  plugins: readonly FmvProvider[],
): Promise<Listing[]> {
  if (listings.length === 0) return [];
  if (plugins.length === 0) return listings.map((l) => l);

  const out: Listing[] = listings.map((l) => l);
  // Indices still needing FMV (origin fmv was null).
  let pending = out
    .map((l, i) => (l.fmv == null ? i : -1))
    .filter((i) => i >= 0);

  for (const plugin of plugins) {
    if (pending.length === 0) break;

    let enriched: Listing[] | null = null;
    try {
      const batch = pending.map((i) => out[i]!);
      if (plugin.enrichMany) {
        const rows = await plugin.enrichMany(batch);
        if (Array.isArray(rows) && rows.length === batch.length) {
          enriched = rows;
        } else if (Array.isArray(rows) && rows.length > 0) {
          // Partial / mismatched: fall back to per-row enrich
          enriched = null;
        }
      }
      if (enriched == null) {
        enriched = await Promise.all(
          batch.map(async (l) => {
            try {
              return await plugin.enrich(l);
            } catch {
              return l; // soft-skip per row
            }
          }),
        );
      }
    } catch {
      continue; // soft-skip whole plugin
    }

    const stillPending: number[] = [];
    for (let k = 0; k < pending.length; k++) {
      const idx = pending[k]!;
      const next = enriched[k] ?? out[idx]!;
      if (next.fmv != null && Number.isFinite(next.fmv)) {
        out[idx] = {
          ...next,
          fmv: next.fmv,
          delta: deltaFromPriceAndFmv(next.price, next.fmv),
        };
      } else {
        // Keep plugin's other field tweaks if any, still need FMV
        out[idx] = next.fmv == null ? next : out[idx]!;
        stillPending.push(idx);
      }
    }
    pending = stillPending;
  }

  return out;
}
