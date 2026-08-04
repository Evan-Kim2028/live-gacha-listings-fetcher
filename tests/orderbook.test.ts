import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { ListingStore } from "../src/store.js";
import { listingId } from "../src/identity.js";
import {
  OrderbookStore,
  listingToAsk,
  FixtureBidsProvider,
  OrderbookFeed,
} from "../src/orderbook/index.js";
import type { Listing } from "../src/types.js";
import { createFixtureProvider } from "../src/providers/fixture.js";
import { syncOnce } from "../src/sync.js";
import { listingMatchesFilter } from "../src/filter.js";

function listing(
  p: Partial<Listing> & { platform: string; nativeId: string; price: number },
): Listing {
  const provider = p.provider ?? "fixture";
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

  it("client filter keeps only matching tcg asks", () => {
    const store = new ListingStore();
    const filter = { tcg: "pokemon" as const };
    store.upsertOne(
      listing({
        platform: "courtyard",
        nativeId: "p1",
        price: 12,
        tcg: "pokemon",
      }),
    );
    store.upsertOne(
      listing({
        platform: "courtyard",
        nativeId: "o1",
        price: 20,
        tcg: "one_piece",
      }),
    );
    const matched = store.list().filter((l) => listingMatchesFilter(l, filter));
    expect(matched).toHaveLength(1);

    const book = new OrderbookStore();
    for (const l of matched) book.upsertAsk(listingToAsk(l));
    expect(book.allAsks()).toHaveLength(1);
  });

  it("OrderbookFeed seeds asks from store + fixture bids", async () => {
    const listingStore = new ListingStore();
    const fixturePath = join(__dirname, "..", "fixtures", "radar-sample.json");
    const bidPath = join(__dirname, "..", "fixtures", "bids-sample.json");
    await syncOnce(
      listingStore,
      createFixtureProvider({ path: fixturePath, providerId: "fixture" }),
      { tcg: "pokemon", shortCircuitOnBuiltAt: false },
    );
    const events: string[] = [];
    const feed = new OrderbookFeed({
      listingStore,
      listingFilter: { tcg: "pokemon" },
      offline: true,
      bidsProvider: new FixtureBidsProvider(bidPath),
      onEvent: (e) => events.push(e.kind),
    });
    await feed.start();
    expect(feed.getOrderbookStore().allAsks().length).toBeGreaterThan(0);
    expect(feed.getOrderbookStore().allBids().length).toBeGreaterThan(0);
    expect(events.some((k) => k === "book" || k === "bid_upsert")).toBe(true);
    expect(feed.getOrderbookStore().instrumentKeys().length).toBeGreaterThan(0);
    feed.stop();
  });

  it("OrderbookFeed filters asks by priceMin", async () => {
    const listingStore = new ListingStore();
    listingStore.upsertOne(
      listing({
        platform: "cc",
        nativeId: "n1",
        price: 100,
        tcg: "pokemon",
        provider: "collectorcrypt",
      }),
    );
    listingStore.upsertOne(
      listing({
        platform: "me",
        nativeId: "n2",
        price: 50,
        tcg: "pokemon",
        provider: "magiceden",
      }),
    );
    const bidPath = join(__dirname, "..", "fixtures", "bids-sample.json");
    const feed = new OrderbookFeed({
      listingStore,
      listingFilter: { tcg: "pokemon", priceMin: 40 },
      bidsProvider: new FixtureBidsProvider(bidPath),
    });
    await feed.start();
    const asks = feed.getOrderbookStore().allAsks();
    expect(asks.length).toBe(2);
    expect(asks.every((a) => a.price >= 40)).toBe(true);
    feed.stop();
  });
});
