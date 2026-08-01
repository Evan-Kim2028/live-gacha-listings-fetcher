import type {
  AskOrder,
  BidOrder,
  BookOrder,
  InstrumentBook,
  OrderLevel,
} from "./types.js";

/**
 * In-memory bid+ask book. Idempotent upsert by order id.
 */
export class OrderbookStore {
  private readonly bids = new Map<string, BidOrder>();
  private readonly asks = new Map<string, AskOrder>();

  clear(): void {
    this.bids.clear();
    this.asks.clear();
  }

  upsertBid(order: BidOrder): void {
    this.bids.set(order.id, order);
  }

  upsertAsk(order: AskOrder): void {
    this.asks.set(order.id, order);
  }

  removeBid(id: string): boolean {
    return this.bids.delete(id);
  }

  removeAsk(id: string): boolean {
    return this.asks.delete(id);
  }

  /**
   * Remove all bids and asks for an instrument (sold / delisted).
   * Returns the last book top-of-book **before** clear, or null if empty.
   */
  clearInstrument(
    instrumentKey: string,
    at = new Date().toISOString(),
  ): InstrumentBook | null {
    const before = this.book(instrumentKey, at);
    const had =
      before.bids.length > 0 ||
      before.asks.length > 0 ||
      before.bestBid != null ||
      before.bestAsk != null;
    if (!had) return null;
    for (const [id, b] of this.bids) {
      if (b.instrumentKey === instrumentKey) this.bids.delete(id);
    }
    for (const [id, a] of this.asks) {
      if (a.instrumentKey === instrumentKey) this.asks.delete(id);
    }
    return before;
  }

  getBid(id: string): BidOrder | undefined {
    return this.bids.get(id);
  }

  getAsk(id: string): AskOrder | undefined {
    return this.asks.get(id);
  }

  allBids(): BidOrder[] {
    return [...this.bids.values()];
  }

  allAsks(): AskOrder[] {
    return [...this.asks.values()];
  }

  /** Replace all asks for a provider (from filtered listing snapshot). */
  replaceAsksForProvider(provider: string, asks: AskOrder[]): {
    upserted: number;
    pruned: number;
  } {
    let pruned = 0;
    for (const [id, a] of this.asks) {
      if (a.provider === provider && !asks.some((x) => x.id === id)) {
        this.asks.delete(id);
        pruned += 1;
      }
    }
    for (const a of asks) this.asks.set(a.id, a);
    return { upserted: asks.length, pruned };
  }

  book(instrumentKey: string, at = new Date().toISOString()): InstrumentBook {
    const bidOrders = this.allBids().filter(
      (b) => b.instrumentKey === instrumentKey,
    );
    const askOrders = this.allAsks().filter(
      (a) => a.instrumentKey === instrumentKey,
    );
    const bids = aggregateLevels(bidOrders, "desc");
    const asks = aggregateLevels(askOrders, "asc");
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    const mid =
      bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
    const spread =
      bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
    return {
      instrumentKey,
      bids,
      asks,
      bestBid,
      bestAsk,
      mid,
      spread,
      updatedAt: at,
    };
  }

  instrumentKeys(): string[] {
    const s = new Set<string>();
    for (const b of this.bids.values()) s.add(b.instrumentKey);
    for (const a of this.asks.values()) s.add(a.instrumentKey);
    return [...s].sort();
  }
}

function aggregateLevels(
  orders: BookOrder[],
  sort: "asc" | "desc",
): OrderLevel[] {
  const map = new Map<string, OrderLevel>();
  for (const o of orders) {
    const key = `${o.price}|${o.currency}`;
    const cur = map.get(key);
    if (cur) {
      cur.size += o.size;
      cur.orderCount += 1;
    } else {
      map.set(key, {
        price: o.price,
        size: o.size,
        orderCount: 1,
        currency: o.currency,
      });
    }
  }
  const levels = [...map.values()];
  levels.sort((a, b) =>
    sort === "asc" ? a.price - b.price : b.price - a.price,
  );
  return levels;
}
