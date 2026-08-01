import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { ListingStore } from "../src/store.js";
import { listingId } from "../src/identity.js";
import {
  OrderbookStore,
  listingToAsk,
  FixtureBidsProvider,
  OrderbookFeed,
  instrumentKeyFromListing,
  type BidOrder,
} from "../src/orderbook/index.js";
import type { Listing } from "../src/types.js";
import { applyTradedDelta } from "../src/stream/applyDelta.js";

function listing(p: Partial<Listing> & { platform: string; nativeId: string; price: number }): Listing {
  const provider = "tradedgg";
  return {
    id: listingId({ provider, platform: p.platform, nativeId: p.nativeId }),
    provider,
    platform: p.platform,
    nativeId: p.nativeId,
    tokenId: null,
    name: p.name ?? "Card",
    price: p.price,
    currency: "USDC",
    fmv: p.fmv ?? null,
    delta: null,
    market: null,
    seller: null,
    externalUrl: null,
    imageUrl: null,
    listedAt: "2026-08-01T08:00:00+00:00",
    firstListedAt: null,
    lastEvent: "LIST",
    tcg: p.tcg ?? "pokemon",
    itemType: "card",
    grader: p.grader ?? "PSA",
    grade: p.grade ?? "10",
    gradeNum: p.gradeNum ?? 10,
    language: "EN",
    setRaw: null,
    cardNumber: null,
    year: 2024,
    confidence: 0.9,
    canonical: p.canonical ?? {
      scrydex_id: "me2pt5-289",
      name: "Steven's Metagross ex",
    },
    contractAddress: null,
  };
}

describe("orderbook asks from listings + bids fixture", () => {
  it("builds instrument book with best bid/ask", async () => {
    const book = new OrderbookStore();
    const ask = listingToAsk(
      listing({
        platform: "courtyard",
        nativeId: "a1",
        price: 443,
        grader: "CGC",
        gradeNum: 10,
      }),
    );
    book.upsertAsk(ask);
    const bids = new FixtureBidsProvider(
      join(__dirname, "..", "fixtures", "bids-sample.json"),
    );
    for (const b of await bids.pull()) book.upsertBid(b);

    const key = ask.instrumentKey;
    expect(key).toContain("me2pt5-289");
    const snap = book.book(key);
    expect(snap.bestAsk).toBe(443);
    expect(snap.bestBid).toBe(400);
    expect(snap.spread).toBe(43);
    expect(snap.bids[0]?.price).toBe(400);
  });

  it("filtered stream deltas only update matching tcg asks", () => {
    const store = new ListingStore();
    const filter = { tcg: "pokemon" as const };
    const pokeRow = {
      instance_id: "p1",
      platform: "courtyard",
      name: "Pika",
      price: 12,
      currency: "USDC",
      tcg: "pokemon",
      grader: "PSA",
      grade_num: 10,
      canonical: { scrydex_id: "base1-58", name: "Pikachu" },
    };
    const opRow = {
      instance_id: "o1",
      platform: "courtyard",
      name: "Zoro",
      price: 20,
      currency: "USDC",
      tcg: "one_piece",
    };
    const e1 = applyTradedDelta(
      store,
      { type: "new", row: pokeRow },
      { filter },
    );
    const e2 = applyTradedDelta(
      store,
      { type: "new", row: opRow },
      { filter },
    );
    expect(e1?.kind).toBe("upsert");
    expect(e2).toBeNull();
    expect(store.size()).toBe(1);

    const book = new OrderbookStore();
    for (const l of store.list()) book.upsertAsk(listingToAsk(l));
    expect(book.allAsks()).toHaveLength(1);
  });

  it("OrderbookFeed offline seeds asks from snapshot filter", async () => {
    const listingStore = new ListingStore();
    const fixturePath = join(__dirname, "..", "fixtures", "radar-sample.json");
    const bidPath = join(__dirname, "..", "fixtures", "bids-sample.json");
    const events: string[] = [];
    const feed = new OrderbookFeed({
      listingStore,
      listingFilter: { tcg: "pokemon" },
      offline: true,
      listingsFeed: {
        store: listingStore,
        offline: true,
        snapshotQuery: {
          fixturePath,
          tcg: "pokemon",
          limit: 10,
        },
      },
      bidsProvider: new FixtureBidsProvider(bidPath),
      onEvent: (e) => events.push(e.kind),
    });
    await feed.start();
    expect(feed.getOrderbookStore().allAsks().length).toBeGreaterThan(0);
    expect(feed.getOrderbookStore().allBids().length).toBeGreaterThan(0);
    expect(events.some((k) => k === "book" || k === "bid_upsert")).toBe(true);
    // instrument keys exist
    expect(feed.getOrderbookStore().instrumentKeys().length).toBeGreaterThan(0);
    feed.stop();
  });

  it("OrderbookFeed native mode: asks from store + bids, no ListingsFeed", async () => {
    const listingStore = new ListingStore();
    listingStore.upsertOne(
      listing({
        platform: "cc",
        nativeId: "n1",
        price: 100,
        tcg: "pokemon",
      }),
    );
    listingStore.upsertOne(
      listing({
        platform: "me",
        nativeId: "n2",
        price: 50,
        tcg: "pokemon",
      }),
    );
    const bidPath = join(__dirname, "..", "fixtures", "bids-sample.json");
    const feed = new OrderbookFeed({
      listingStore,
      listingFilter: { tcg: "pokemon", priceMin: 40 },
      native: true,
      bidsProvider: new FixtureBidsProvider(bidPath),
    });
    await feed.start();
    const asks = feed.getOrderbookStore().allAsks();
    expect(asks.length).toBe(2);
    expect(asks.every((a) => a.price >= 40)).toBe(true);
    expect(feed.getOrderbookStore().allBids().length).toBeGreaterThan(0);
    feed.refreshAsks();
    expect(feed.getOrderbookStore().allAsks().length).toBe(2);
    feed.stop();
  });

  it("clearInstrument removes bids+asks and returns last top-of-book", () => {
    const book = new OrderbookStore();
    const key = "test-instrument";
    book.upsertAsk({
      id: "ask:1",
      provider: "cc",
      instrumentKey: key,
      nativeId: "n1",
      side: "ask",
      price: 100,
      size: 1,
      currency: "USDC",
      listingId: "cc:cc:n1",
      updatedAt: "2026-08-01T00:00:00Z",
    });
    book.upsertBid({
      id: "bid:1",
      provider: "cc",
      instrumentKey: key,
      nativeId: "b1",
      side: "bid",
      price: 90,
      size: 1,
      currency: "USDC",
      updatedAt: "2026-08-01T00:00:00Z",
    });
    const last = book.clearInstrument(key);
    expect(last?.bestAsk).toBe(100);
    expect(last?.bestBid).toBe(90);
    expect(book.allAsks()).toHaveLength(0);
    expect(book.allBids()).toHaveLength(0);
    expect(book.clearInstrument(key)).toBeNull();
  });

  it("refreshAsks emits sold and clears bids when listing leaves store", async () => {
    const listingStore = new ListingStore();
    const L = listing({
      platform: "cc",
      nativeId: "sold-1",
      price: 120,
      tcg: "pokemon",
      name: "Sold Card",
    });
    listingStore.upsertOne(L);
    const key = instrumentKeyFromListing(L);
    const sold: { kind: string; lastBestAsk: number | null }[] = [];
    const feed = new OrderbookFeed({
      listingStore,
      listingFilter: { tcg: "pokemon" },
      native: true,
      onEvent: (ev) => {
        if (ev.kind === "sold") {
          sold.push({ kind: ev.kind, lastBestAsk: ev.lastBestAsk });
        }
      },
    });
    await feed.start();
    // inject residual bid on same instrument
    feed.injectBid({
      id: "bid:residual",
      provider: "cc",
      instrumentKey: key,
      nativeId: "b",
      side: "bid",
      price: 100,
      size: 1,
      currency: "USDC",
      updatedAt: "2026-08-01T00:00:00Z",
    } satisfies BidOrder);
    expect(feed.getOrderbookStore().allAsks().length).toBe(1);
    // delist
    listingStore.removeOne(L.id);
    const events = feed.refreshAsks();
    expect(events.some((e) => e.kind === "sold")).toBe(true);
    expect(sold.some((s) => s.lastBestAsk === 120)).toBe(true);
    expect(feed.getOrderbookStore().allAsks()).toHaveLength(0);
    expect(feed.getOrderbookStore().allBids()).toHaveLength(0);
    feed.stop();
  });
});
