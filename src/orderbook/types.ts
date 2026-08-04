/**
 * Orderbook / bid models.
 *
 * There is no public unauthenticated NFT bid orderbook SSE.
 * Bids are modeled for:
 *  - modular providers (fixture / future marketplace APIs)
 *  - loan offers (separate product surface, auth/rate-limited)
 *  - local synthesis of ask-side books from listing streams
 */

import type { SoldReason } from "../lifecycle/delist.js";

export type OrderSide = "bid" | "ask";

export interface OrderLevel {
  price: number;
  size: number;
  orderCount: number;
  currency: string;
}

export interface BidOrder {
  /** Stable id: provider:instrumentKey:nativeId */
  id: string;
  provider: string;
  /** Instrument key (scrydex id, listing id, or name+grade) */
  instrumentKey: string;
  nativeId: string;
  side: "bid";
  price: number;
  size: number;
  currency: string;
  bidder?: string | null;
  platform?: string | null;
  updatedAt: string;
  raw?: unknown;
}

export interface AskOrder {
  id: string;
  provider: string;
  instrumentKey: string;
  nativeId: string;
  side: "ask";
  price: number;
  size: number;
  currency: string;
  seller?: string | null;
  platform?: string | null;
  listingId?: string | null;
  updatedAt: string;
  raw?: unknown;
}

export type BookOrder = BidOrder | AskOrder;

export interface InstrumentBook {
  instrumentKey: string;
  bids: OrderLevel[]; // high → low
  asks: OrderLevel[]; // low → high
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  updatedAt: string;
}

export type BidStreamWire =
  | { type: "bid_upsert"; order: BidOrder }
  | { type: "bid_remove"; id: string; instrumentKey?: string }
  | { type: "bid_snapshot"; orders: BidOrder[] }
  | { type: string; [key: string]: unknown };

/**
 * Emitted when an instrument leaves the live book (listing pruned / sold /
 * delisted). `lastBestBid` / `lastBestAsk` are the top-of-book **before**
 * clear — poll path cannot always prove on-chain sale price; last ask is
 * the best proxy for "listed at when it disappeared."
 *
 * `reason` aligns with {@link SoldReason} / {@link DelistReason}:
 * instrument zero asks after prune → `delisted_or_sold`.
 */
export interface InstrumentSoldEvent {
  kind: "sold";
  instrumentKey: string;
  at: string;
  /** Best bid immediately before clear (may be null if no bids sampled). */
  lastBestBid: number | null;
  /** Best ask (listing) immediately before clear. */
  lastBestAsk: number | null;
  currency?: string;
  /** Listing ids that left the ask side this tick (if known). */
  listingIds?: string[];
  /** Same codes as lifecycle {@link SoldReason} (`delisted_or_sold` | `ask_removed`). */
  reason: SoldReason;
}

export type OrderbookEvent =
  | { kind: "ask_upsert"; order: AskOrder; at: string }
  | { kind: "ask_remove"; id: string; at: string }
  | { kind: "bid_upsert"; order: BidOrder; at: string }
  | { kind: "bid_remove"; id: string; at: string }
  | { kind: "book"; book: InstrumentBook; at: string }
  | InstrumentSoldEvent
  | { kind: "status"; status: string; at: string }
  | { kind: "error"; error: string; at: string };
