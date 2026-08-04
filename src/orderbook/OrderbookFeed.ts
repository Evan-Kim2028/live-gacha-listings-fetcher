import { listingMatchesFilter } from "../filter.js";
import type { PullQuery } from "../providers/types.js";
import type { ListingStore } from "../store.js";
import {
  isWatchlistEmpty,
  mergeWatchlists,
  type Watchlist,
} from "../watchlist.js";
import type { BidsProvider } from "./BidsProvider.js";
import { listingsToAsks } from "./fromListings.js";
import { OrderbookStore } from "./OrderbookStore.js";
import type { BidOrder, InstrumentSoldEvent, OrderbookEvent } from "./types.js";

export interface OrderbookFeedOptions {
  listingStore: ListingStore;
  orderbookStore?: OrderbookStore;
  /** Listing subset (e.g. tcg=pokemon, platform, priceMin/Max) for asks. */
  listingFilter?: PullQuery;
  /**
   * Client watchlist (name substrings, instrument keys, mint or card ids).
   * Merged into listingFilter.watchlist for ask seeding and bid target sampling.
   */
  watchlist?: Watchlist;
  /** Bids provider(s): CC / ME / Courtyard / fixture. */
  bidsProvider?: BidsProvider | BidsProvider[];
  onEvent?: (ev: OrderbookEvent) => void;
  /** When true, skip network bid streams (tests / offline fixtures). */
  offline?: boolean;
}

/**
 * Dual-sided book feed (native only).
 * Asks: filtered listings from MultiSourceRadar / PollEngine store.
 * Bids: BidsProvider(s) (CC / ME / Courtyard / fixture).
 */
export class OrderbookFeed {
  private readonly listingStore: ListingStore;
  private readonly book: OrderbookStore;
  private readonly listingFilter: PullQuery;
  private readonly bidsProviders: BidsProvider[];
  private readonly onEvent?: (ev: OrderbookEvent) => void;
  private bidStops: Array<() => void> = [];
  private abort: AbortController | null = null;

  constructor(opts: OrderbookFeedOptions) {
    this.listingStore = opts.listingStore;
    this.book = opts.orderbookStore ?? new OrderbookStore();
    const baseFilter = opts.listingFilter ?? {};
    const watchlist = mergeWatchlists(baseFilter.watchlist, opts.watchlist);
    this.listingFilter = isWatchlistEmpty(watchlist)
      ? { ...baseFilter }
      : { ...baseFilter, watchlist };
    this.bidsProviders = normalizeBids(opts.bidsProvider);
    this.onEvent = opts.onEvent;
  }

  getOrderbookStore(): OrderbookStore {
    return this.book;
  }

  getListingStore(): ListingStore {
    return this.listingStore;
  }

  async start(): Promise<void> {
    this.abort = new AbortController();
    // Seed asks from current listing store
    this.syncAsksFromListings();
    this.seedBidsTargetsFromStore();
    if (this.bidsProviders.length > 0) {
      for (const bidsProvider of this.bidsProviders) {
        try {
          const stoppable = await bidsProvider.openStream?.({
            signal: this.abort.signal,
            onStatus: (status) =>
              this.emit({
                kind: "status",
                status: `bids:${status}`,
                at: new Date().toISOString(),
              }),
            onError: (err) =>
              this.emit({
                kind: "error",
                error: err.message,
                at: new Date().toISOString(),
              }),
            onEvent: (wire) => this.onBidWire(wire),
          });
          if (stoppable) this.bidStops.push(stoppable.stop);
          else {
            const orders = await bidsProvider.pull({
              ...this.listingFilter,
            });
            this.applyBidSnapshot(orders);
          }
        } catch (e) {
          // Bids are optional: 403/5xx/rate-limit must not kill the listings monitor.
          const msg = e instanceof Error ? e.message : String(e);
          this.emit({
            kind: "error",
            error: `bids:${bidsProvider.id}: ${msg}`,
            at: new Date().toISOString(),
          });
          this.emit({
            kind: "status",
            status: `bids:${bidsProvider.id}:soft_fail`,
            at: new Date().toISOString(),
          });
        }
      }
    } else {
      this.emit({
        kind: "status",
        status: "bids:unavailable",
        at: new Date().toISOString(),
      });
    }
  }

  /**
   * Push listing tokenIds into bids providers so offer fetches
   * reuse MultiSourceRadar data (ME mints, Courtyard proofOfIntegrity).
   */
  private seedBidsTargetsFromStore(): void {
    const filtered = this.listingStore
      .list()
      .filter((l) => listingMatchesFilter(l, this.listingFilter));
    const mints = filtered
      .filter(
        (l) =>
          (l.provider === "magiceden" || l.platform === "me") && !!l.tokenId,
      )
      .map((l) => l.tokenId as string);
    const cyAssets = filtered
      .filter(
        (l) =>
          (l.provider === "courtyard" || l.platform === "courtyard") &&
          !!(l.tokenId ?? l.nativeId),
      )
      .map((l) => (l.tokenId ?? l.nativeId) as string);
    for (const p of this.bidsProviders) {
      if (
        mints.length > 0 &&
        p.id === "magiceden_bids" &&
        typeof (p as unknown as { setMints?: (m: string[]) => void }).setMints ===
          "function"
      ) {
        (p as unknown as { setMints: (m: string[]) => void }).setMints(mints);
      }
      if (
        cyAssets.length > 0 &&
        p.id === "courtyard_bids" &&
        typeof (p as unknown as { setAssetIds?: (m: string[]) => void })
          .setAssetIds === "function"
      ) {
        (p as unknown as { setAssetIds: (m: string[]) => void }).setAssetIds(
          cyAssets,
        );
      }
    }
  }

  /**
   * Re-sync asks from ListingStore (after MultiSourceRadar.syncAll / PollEngine tick).
   * Listings that left the store prune their asks; instruments with no remaining
   * asks clear bids and emit `sold` (last best bid/ask captured).
   */
  refreshAsks(): InstrumentSoldEvent[] {
    return this.syncAsksFromListings();
  }

  /** Re-pull all bids providers once. */
  async refreshBids(extra: PullQuery = {}): Promise<void> {
    this.seedBidsTargetsFromStore();
    for (const p of this.bidsProviders) {
      try {
        const orders = await p.pull({ ...this.listingFilter, ...extra });
        this.applyBidSnapshot(orders);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.emit({
          kind: "error",
          error: `bids:${p.id}: ${msg}`,
          at: new Date().toISOString(),
        });
      }
    }
  }

  stop(): void {
    for (const s of this.bidStops) s();
    this.bidStops = [];
    this.abort?.abort();
    this.abort = null;
  }

  /** Inject bid for tests. */
  injectBid(order: BidOrder): void {
    this.book.upsertBid(order);
    this.emit({
      kind: "bid_upsert",
      order,
      at: new Date().toISOString(),
    });
  }

  /**
   * Rebuild asks from active listings. If an instrument has zero asks left after
   * prune, clear residual bids and emit `sold` with last top-of-book (poll cannot
   * always prove on-chain sale; last ask is the listing price when it left).
   */
  private syncAsksFromListings(): InstrumentSoldEvent[] {
    const at = new Date().toISOString();
    const sold: InstrumentSoldEvent[] = [];
    const listings = this.listingStore
      .list()
      .filter((l) => listingMatchesFilter(l, this.listingFilter));
    const byProvider = new Map<string, typeof listings>();
    for (const l of listings) {
      const arr = byProvider.get(l.provider) ?? [];
      arr.push(l);
      byProvider.set(l.provider, arr);
    }

    // Snapshot TOB + ask listing ids BEFORE replace (pruned asks lose bestAsk otherwise)
    const instrumentsWithAskBefore = new Set(
      this.book.allAsks().map((a) => a.instrumentKey),
    );
    const tobBefore = new Map<
      string,
      { bestBid: number | null; bestAsk: number | null; currency?: string }
    >();
    const askByInstrumentBefore = new Map<string, string[]>();
    for (const key of instrumentsWithAskBefore) {
      const b = this.book.book(key, at);
      tobBefore.set(key, {
        bestBid: b.bestBid,
        bestAsk: b.bestAsk,
        currency: b.asks[0]?.currency ?? b.bids[0]?.currency,
      });
    }
    for (const a of this.book.allAsks()) {
      const ids = askByInstrumentBefore.get(a.instrumentKey) ?? [];
      if (a.listingId) ids.push(a.listingId);
      askByInstrumentBefore.set(a.instrumentKey, ids);
    }

    if (byProvider.size === 0 && instrumentsWithAskBefore.size === 0) {
      return sold;
    }

    // Known providers from current listings + any ask still in book
    const providers = new Set<string>([
      ...byProvider.keys(),
      ...this.book.allAsks().map((a) => a.provider),
    ]);
    for (const provider of providers) {
      const ls = byProvider.get(provider) ?? [];
      this.book.replaceAsksForProvider(provider, listingsToAsks(ls));
    }

    const instrumentsWithAskAfter = new Set(
      this.book.allAsks().map((a) => a.instrumentKey),
    );

    for (const key of instrumentsWithAskBefore) {
      if (instrumentsWithAskAfter.has(key)) continue;
      // No asks left → sold/delisted; clear residual bids; use pre-replace TOB
      const prior = tobBefore.get(key);
      this.book.clearInstrument(key, at);
      const ev: InstrumentSoldEvent = {
        kind: "sold",
        instrumentKey: key,
        at,
        lastBestBid: prior?.bestBid ?? null,
        lastBestAsk: prior?.bestAsk ?? null,
        currency: prior?.currency,
        listingIds: askByInstrumentBefore.get(key),
        reason: "delisted_or_sold",
      };
      sold.push(ev);
      this.emit(ev);
      this.emit({
        kind: "book",
        book: this.book.book(key, at),
        at,
      });
    }

    for (const key of this.book.instrumentKeys()) {
      this.emit({ kind: "book", book: this.book.book(key, at), at });
    }
    return sold;
  }

  private onBidWire(wire: {
    type: string;
    order?: BidOrder;
    orders?: BidOrder[];
    id?: string;
  }): void {
    const at = new Date().toISOString();
    if (wire.type === "bid_snapshot" && wire.orders) {
      this.applyBidSnapshot(wire.orders);
      return;
    }
    if (wire.type === "bid_upsert" && wire.order) {
      this.book.upsertBid(wire.order);
      this.emit({ kind: "bid_upsert", order: wire.order, at });
      this.emit({
        kind: "book",
        book: this.book.book(wire.order.instrumentKey, at),
        at,
      });
    }
    if (wire.type === "bid_remove" && wire.id) {
      const prev = this.book.getBid(wire.id);
      this.book.removeBid(wire.id);
      this.emit({ kind: "bid_remove", id: wire.id, at });
      if (prev) {
        this.emit({
          kind: "book",
          book: this.book.book(prev.instrumentKey, at),
          at,
        });
      }
    }
  }

  private applyBidSnapshot(orders: BidOrder[]): void {
    const ids = new Set(orders.map((o) => o.id));
    // Only prune bids from same provider ids present in this snapshot set
    const providers = new Set(orders.map((o) => o.provider));
    for (const b of this.book.allBids()) {
      if (providers.has(b.provider) && !ids.has(b.id)) this.book.removeBid(b.id);
    }
    const at = new Date().toISOString();
    for (const o of orders) {
      this.book.upsertBid(o);
      this.emit({ kind: "bid_upsert", order: o, at });
    }
  }

  private emit(ev: OrderbookEvent): void {
    this.onEvent?.(ev);
  }
}

function normalizeBids(
  p?: BidsProvider | BidsProvider[],
): BidsProvider[] {
  if (!p) return [];
  return Array.isArray(p) ? p : [p];
}
