import type { RunCapture } from "../capture/RunCapture.js";
import type { OrderbookStore } from "../orderbook/OrderbookStore.js";
import type { SyncResult } from "../types.js";

/**
 * Why a listing left the live book (product model — docs/SOLD_TAKEDOWN.md).
 * No-prune decision codes (`soft_fail_no_prune`, `incomplete_page_no_prune`)
 * never produce a DelistEvent (store keeps the row).
 */
export type DelistReason =
  | "missing_from_full_snapshot"
  | "explicit_closed"
  | "delisted_or_sold"
  | "ask_removed";

/**
 * Orderbook / capture sold payload reasons — subset of {@link DelistReason}.
 * Poll leave-book after instrument ask count hits zero → `delisted_or_sold`.
 */
export type SoldReason = Extract<
  DelistReason,
  "delisted_or_sold" | "ask_removed"
>;

/** How the leave-book signal was observed. */
export type DelistSource = "poll_diff" | "sse_closed";

/**
 * First-class delist / leave-book event for one listing id.
 * `lastBestBid` / `lastBestAsk` are pre-clear top-of-book when an orderbook
 * was supplied — not proven on-chain fill prices.
 */
export interface DelistEvent {
  ts: string;
  provider: string;
  listingId: string;
  instrumentKey?: string;
  lastBestBid: number | null;
  lastBestAsk: number | null;
  currency?: string;
  reason: DelistReason;
  source: DelistSource;
}

/**
 * Apply poll-diff delists from a SyncResult's `prunedIds`.
 *
 * For each pruned id:
 * 1. Clear the matching ask (`ask:{listingId}` or `listingId` field).
 * 2. If the instrument has zero asks left, clear residual bids.
 * 3. Emit sold/delist to `RunCapture` (`sold.jsonl` + `events.jsonl`) when capture is set.
 *
 * Soft-fail / incomplete-page results have empty `prunedIds` and yield nothing.
 * Does not require traded.gg.
 */
export function applyDelistsFromSync(
  result: SyncResult,
  orderbook?: OrderbookStore,
  capture?: RunCapture,
): DelistEvent[] {
  const ids = result.prunedIds ?? [];
  if (ids.length === 0) return [];

  const ts = new Date().toISOString();
  const events: DelistEvent[] = [];
  /** Instruments already sold this call (avoid duplicate onSold for multi-id). */
  const soldInstruments = new Set<string>();

  for (const listingId of ids) {
    let instrumentKey: string | undefined;
    let lastBestBid: number | null = null;
    let lastBestAsk: number | null = null;
    let currency: string | undefined;
    let clearedInstrument = false;

    if (orderbook) {
      const ask =
        orderbook.getAsk(`ask:${listingId}`) ??
        orderbook.allAsks().find((a) => a.listingId === listingId);

      if (ask) {
        instrumentKey = ask.instrumentKey;
        const bookBefore = orderbook.book(instrumentKey, ts);
        lastBestBid = bookBefore.bestBid;
        lastBestAsk = ask.price;
        currency =
          ask.currency ??
          bookBefore.asks[0]?.currency ??
          bookBefore.bids[0]?.currency;

        orderbook.removeAsk(ask.id);

        const remainingAsks = orderbook
          .allAsks()
          .filter((a) => a.instrumentKey === instrumentKey);
        if (remainingAsks.length === 0) {
          // Clear residual bids; TOB already captured pre-remove
          orderbook.clearInstrument(instrumentKey, ts);
          clearedInstrument = true;
        }
      }
    }

    const ev: DelistEvent = {
      ts,
      provider: result.provider,
      listingId,
      instrumentKey,
      lastBestBid,
      lastBestAsk,
      currency,
      reason: "missing_from_full_snapshot",
      source: "poll_diff",
    };
    events.push(ev);

    if (capture) {
      const key = instrumentKey ?? listingId;
      // Emit sold when we cleared the instrument, or once per id with no book
      if (!orderbook || clearedInstrument || !instrumentKey) {
        if (!soldInstruments.has(key)) {
          soldInstruments.add(key);
          capture.onSold({
            ts,
            instrumentKey: key,
            lastBestBid,
            lastBestAsk,
            currency,
            listingIds: [listingId],
            reason: "delisted_or_sold",
          });
        }
      } else {
        // Ask removed but instrument still has other asks — still record delist line
        capture.onSold({
          ts,
          instrumentKey: key,
          lastBestBid,
          lastBestAsk,
          currency,
          listingIds: [listingId],
          reason: "ask_removed",
        });
      }
    }
  }

  return events;
}
