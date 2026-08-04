/** Shared listing model used by all sources after normalize. */

export type ListingEvent = "LIST" | "PRICE_UPDATE" | string;

export interface CanonicalCard {
  name?: string | null;
  number?: string | null;
  scrydex_id?: string | null;
  image?: string | null;
  [key: string]: unknown;
}

/**
 * Normalized listing for trading decisions.
 * `id` is the library's stable primary key (see identity.ts).
 */
export interface Listing {
  /** Deterministic primary key: provider:platform:nativeId */
  id: string;
  /** Source adapter id, e.g. "fixture" | "collectorcrypt" */
  provider: string;
  /** Marketplace slug inside the provider (courtyard, cc, …) */
  platform: string;
  nativeId: string;
  tokenId: string | null;
  name: string;
  price: number;
  currency: string;
  fmv: number | null;
  delta: number | null;
  market: string | null;
  seller: string | null;
  /**
   * Public origin listing page when the marketplace has one (CC mint, ME mint,
   * Phygitals slug/address, Courtyard token, or origin-provided URL on longtail).
   * Deep-link only — this library does not build marketplace transactions.
   * See `formatOpenCommand` in externalUrl.ts.
   */
  externalUrl: string | null;
  imageUrl: string | null;
  listedAt: string | null;
  firstListedAt: string | null;
  /**
   * When this row was last confirmed present (ISO).
   * Set on upsert/apply from SnapshotMeta.fetchedAt when the field is missing.
   * Optional/additive — not part of identity; ignored by listingsEqual.
   * Soft-fail pulls do not refresh this (UI may grey-out via isStale).
   */
  lastSeenAt?: string | null;
  lastEvent: ListingEvent | null;
  tcg: string | null;
  itemType: string | null;
  grader: string | null;
  grade: string | null;
  gradeNum: number | null;
  language: string | null;
  setRaw: string | null;
  cardNumber: string | null;
  year: number | null;
  confidence: number | null;
  canonical: CanonicalCard | null;
  contractAddress: string | null;
  /** Search blob from source (client filter). */
  searchBlob?: string | null;
  /** Opaque raw row for debugging / upgrade paths */
  raw?: unknown;
}

export interface SnapshotMeta {
  builtAt: string | null;
  total: number | null;
  universe: number | null;
  fetchedAt: string;
  provider: string;
  /** Canonical pull query key (limit/sort/platform/…); empty = default query */
  querySignature: string;
  /** HTTP ETag (or equivalent) for If-None-Match / transport short-circuit */
  etag?: string | null;
  /** Content fingerprint of normalized rows when origin has no stable builtAt */
  contentFingerprint?: string | null;
}

/**
 * Per-provider ops watermark on ListingStore (not scoped by query).
 * Survives soft-fails so MultiSourceRadar can report freshness without
 * wiping other providers' rows.
 */
export interface ProviderWatermark {
  provider: string;
  /** ISO time of last apply that wrote or short-circuited successfully */
  lastSuccessfulPullAt: string | null;
  /** Last known page generation (builtAt) from a successful pull */
  lastBuiltAt: string | null;
  /** Row count written on last successful apply (scope size after pull) */
  lastRowCount: number;
  /** Last hard/soft error message; null after a clean success */
  lastError: string | null;
}

export interface SyncResult {
  provider: string;
  shortCircuited: boolean;
  builtAt: string | null;
  previousBuiltAt: string | null;
  querySignature: string;
  fetched: number;
  upserted: number;
  unchanged: number;
  /** Rows removed because they left this query's snapshot */
  pruned: number;
  /**
   * Listing ids deleted on this apply (from replaceScopeSnapshot).
   * Empty on soft-fail / incomplete-page / short-circuit (no prune).
   * Callers use this for delist lifecycle without re-diffing the store.
   */
  prunedIds: string[];
  activeCount: number;
  durationMs: number;
  listings: Listing[];
}
