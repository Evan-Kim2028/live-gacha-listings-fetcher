import type { Listing } from "../types.js";

/**
 * Optional post-normalize FMV enrichment seam.
 * Core sync / provider normalize stay origin-passthrough only.
 * Call {@link applyFmvPlugins} outside `syncOnce` when you want plugins.
 *
 * No default network oracle ships in this library — use {@link FixtureFmvProvider}
 * in tests, or supply your own adapter (PriceCharting, TCGPlayer, etc.) in the host.
 */
export interface FmvProvider {
  readonly id: string;
  /**
   * Enrich a single listing. Implementations may set `fmv` (and optionally `delta`);
   * {@link applyFmvPlugins} recomputes `delta` from `price` when `fmv` is filled.
   */
  enrich(listing: Listing): Promise<Listing> | Listing;
  /**
   * Optional batch path. When present, {@link applyFmvPlugins} prefers this for
   * the subset of listings that still have `fmv == null`.
   * Return order should match input order (same length).
   */
  enrichMany?(listings: Listing[]): Promise<Listing[]> | Listing[];
}
