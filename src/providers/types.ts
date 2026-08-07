import type { Listing, SnapshotMeta } from "../types.js";
import type { Watchlist } from "../watchlist.js";

/**
 * extra fields support client-side subset filtering (SSE is unfiltered).
 */
export interface PullQuery {
  limit?: number;
  offset?: number;
  /** new | deal | price (server) */
  sort?: string;
  /** pokemon | one_piece (server) */
  tcg?: string;
  q?: string;
  /** courtyard | cc | beezie | renaiss | dyli (server) */
  platform?: string;
  /** card | sealed (server: itemType) */
  itemType?: string;
  grader?: string;
  grade?: string;
  language?: string;
  /** e.g. drop | new | reprice (server activity facet) */
  activity?: string;
  /** yes | no */
  canonical?: string;
  priceMin?: number;
  priceMax?: number;
  yearMin?: number;
  yearMax?: number;
  maxDelta?: number;
  /** Client-only: require fmv present. */
  requireFmv?: boolean;
  /**
   * Client-only watchlist: name substrings, instrument keys, mint or card ids.
   * Applied by {@link listingMatchesFilter}, radar list, OrderbookFeed asks.
   */
  watchlist?: Watchlist;
  /** When set, adapters may load from this local fixture instead of network. */
  fixturePath?: string;
  /** Force network off (tests). */
  offline?: boolean;
  /**
   * Prior scope HTTP ETag for conditional GET (If-None-Match).
   * Injected by syncOnce from SnapshotMeta.etag when present.
   */
  ifNoneMatch?: string | null;
  /**
   * Cold full-book mode: paginating providers (e.g. Collector Crypt pullAll)
   * use a high maxPages default and walk until `!hasMore` (or maxPages).
   * Not part of querySignature. Cold and warm must share the same decision filter.
   */
  bootstrap?: boolean;
  /**
   * Cap multi-page pulls (provider-specific). With bootstrap, overrides the
   * high default page cap. Not part of querySignature.
   */
  maxPages?: number;
}

export interface PullPage {
  listings: Listing[];
  meta: SnapshotMeta;
  /** True if more pages may exist (provider-specific). */
  hasMore: boolean;
  /**
   * HTTP 304 / bytes unchanged: sync must not replace scope (no wipe).
   * Advance ops watermarks only; listings may be empty.
   */
  notModified?: boolean;
}

/**
 * Marketplace adapter. Implement and register; core sync/store stay unchanged.
 *
 * Soft-fail: on origin outage return empty page and set lastError instead of
 * throwing. syncOnce / MultiSourceRadar keep prior scope + watermarks and
 * surface the message on ops paths.
 */
export interface ListingsProvider {
  /** Stable adapter id, e.g. "collectorcrypt". */
  readonly id: string;

  /**
   * Soft-fail message after the last pull (e.g. Phygitals 500, ME soft path).
   * Null/undefined after a clean success. Consumers read this; do not duck-type.
   */
  lastError?: string | null;

  /** Last listing URL attempted (debug / operators); optional. */
  lastUrl?: string | null;

  /** Fetch one page of normalized listings. */
  pull(query?: PullQuery): Promise<PullPage>;

  /**
   * Optional point lookup of a single token/mint: current listing (or null
   * when the token is unknown / not listed / 404). Implemented by venues
   * with a public per-token endpoint (Beezie getByTokenId, Courtyard
   * Algolia object fetch). Used by `traded-listings card <tokenId>`.
   */
  getByTokenId?(tokenId: string): Promise<Listing | null>;

  /**
   * Optional multi-page pull. syncOnce prefers this when present;
   * otherwise uses pull(offset).
   */
  pullAll?(query?: PullQuery): Promise<PullPage>;
}
