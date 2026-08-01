import type { Listing, ProviderWatermark, SyncResult } from "../types.js";
import type { InstrumentBook } from "../orderbook/types.js";

/** Fields used for delta equality (id is the key). */
export interface ListingDeltaFields {
  price: number;
  listedAt: string | null;
  seller: string | null;
}

export type ListingChangeKind = "new" | "reprice" | "closed" | "soft_fail";

export interface ListingChangeEventBase {
  ts: string;
  kind: ListingChangeKind;
  provider: string;
  qsig?: string;
}

export interface ListingNewEvent extends ListingChangeEventBase {
  kind: "new";
  id: string;
  price: number;
  currency?: string;
  listedAt?: string | null;
  seller?: string | null;
}

export interface ListingRepriceEvent extends ListingChangeEventBase {
  kind: "reprice";
  id: string;
  price: number;
  prevPrice: number;
  listedAt?: string | null;
  prevListedAt?: string | null;
  seller?: string | null;
  prevSeller?: string | null;
  currency?: string;
}

export interface ListingClosedEvent extends ListingChangeEventBase {
  kind: "closed";
  id: string;
}

export interface SoftFailEvent extends ListingChangeEventBase {
  kind: "soft_fail";
  error: string;
  lastSuccessfulPullAt?: string | null;
  lastRowCount?: number;
}

export type ListingChangeEvent =
  | ListingNewEvent
  | ListingRepriceEvent
  | ListingClosedEvent
  | SoftFailEvent;

export interface ScopeRef {
  provider: string;
  querySignature?: string;
}

export interface HealthRecord {
  ts: string;
  provider: string;
  durationMs?: number;
  shortCircuited?: boolean;
  fetched?: number;
  upserted?: number;
  unchanged?: number;
  pruned?: number;
  activeCount?: number;
  builtAt?: string | null;
  querySignature?: string;
  softFail?: boolean;
  lastError?: string | null;
  lastSuccessfulPullAt?: string | null;
  lastRowCount?: number;
  [key: string]: unknown;
}

export interface BookChangeRecord {
  ts: string;
  instrumentKey: string;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  mid: number | null;
  currency?: string;
  fp: string;
}

/**
 * Instrument left the live book (listing pruned). Last bid/ask are pre-clear
 * top-of-book — not always proven on-chain sale price.
 */
export interface SoldRecord {
  ts: string;
  kind: "sold";
  instrumentKey: string;
  lastBestBid: number | null;
  lastBestAsk: number | null;
  currency?: string;
  listingIds?: string[];
  reason: "delisted_or_sold" | "ask_removed";
}

export interface OnSyncExtra {
  /** When set, emit soft_fail and skip listing diff. */
  softFail?: boolean;
  lastError?: string | null;
  watermark?: ProviderWatermark | null;
  /** Force wall-clock for tests. */
  ts?: string;
}

export interface RunCaptureOptions {
  /** Wall-clock ms between sparse scope snapshots (default 300_000). */
  checkpointMs?: number;
  /** Written once to meta.json at open. */
  meta?: Record<string, unknown>;
  /** Clock injection for tests. */
  now?: () => Date;
  /**
   * When true (default), onSyncResult short-circuit ticks write health only.
   * Listing diffs still require an explicit onListingsDiff or non-short-circuit result.
   */
  healthOnShortCircuit?: boolean;
}

export interface SnapshotFileBody {
  ts: string;
  provider: string;
  querySignature: string;
  listings: Listing[];
}

export type BookChangeInput =
  | InstrumentBook
  | {
      instrumentKey: string;
      bestBid: number | null;
      bestAsk: number | null;
      spread?: number | null;
      mid?: number | null;
      currency?: string;
      updatedAt?: string;
    };

export type { SyncResult, Listing, ProviderWatermark, InstrumentBook };
