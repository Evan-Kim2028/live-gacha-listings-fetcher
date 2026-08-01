import { readFile } from "node:fs/promises";
import type { BidsProvider, BidsPullQuery } from "./BidsProvider.js";
import type { BidOrder, BidStreamWire } from "./types.js";

/**
 * Fixture / synthetic bids for orderbook tests and modular extension proof.
 * JSON: BidOrder[] or { orders: BidOrder[] }
 */
export class FixtureBidsProvider implements BidsProvider {
  readonly id = "fixture_bids";

  constructor(private readonly defaultPath: string) {}

  async pull(query: BidsPullQuery = {}): Promise<BidOrder[]> {
    const path = query.fixturePath ?? this.defaultPath;
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as BidOrder[] | { orders?: BidOrder[] };
    let orders = Array.isArray(parsed) ? parsed : (parsed.orders ?? []);
    if (query.instrumentKey) {
      orders = orders.filter((o) => o.instrumentKey === query.instrumentKey);
    }
    if (query.limit != null) orders = orders.slice(0, query.limit);
    return orders.map((o) => ({ ...o, side: "bid" as const }));
  }

  async openStream(handlers: {
    onEvent: (wire: BidStreamWire) => void;
    onStatus?: (status: string) => void;
    onError?: (err: Error) => void;
    signal?: AbortSignal;
  }): Promise<{ stop: () => void }> {
    handlers.onStatus?.("polling");
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const orders = await this.pull();
        handlers.onEvent({ type: "bid_snapshot", orders });
        handlers.onStatus?.("live");
      } catch (e) {
        handlers.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    };
    await tick();
    const timer = setInterval(() => void tick(), 5_000);
    handlers.signal?.addEventListener("abort", () => {
      stopped = true;
      clearInterval(timer);
      handlers.onStatus?.("stopped");
    });
    return {
      stop: () => {
        stopped = true;
        clearInterval(timer);
        handlers.onStatus?.("stopped");
      },
    };
  }
}
