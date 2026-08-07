import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore } from "../src/history/HistoryStore.js";
import { ListingStore } from "../src/store.js";
import { syncOnce } from "../src/sync.js";
import { createFixtureProvider } from "../src/providers/fixture.js";
import type { Listing } from "../src/types.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hist-"));
  dbPath = join(dir, "h.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function listing(id: string, price: number, tokenId = `t-${id}`): Listing {
  return {
    id, provider: "x", platform: "x", nativeId: id, tokenId,
    name: `Card ${id}`, price, currency: "USDC", fmv: null, delta: null,
    market: "X", seller: null, externalUrl: null, imageUrl: null,
    listedAt: null, firstListedAt: null, lastEvent: "LIST", tcg: "pokemon",
    itemType: "card", grader: null, grade: null, gradeNum: null,
    language: null, setRaw: null, cardNumber: null, year: null,
    confidence: null, canonical: null, contractAddress: null, searchBlob: "x",
  };
}

describe("HistoryStore", () => {
  it("records new/reprice events and skips unchanged", () => {
    const h = new HistoryStore(dbPath);
    const result = {
      provider: "x", shortCircuited: false, builtAt: null, previousBuiltAt: null,
      querySignature: "", fetched: 2, upserted: 2, unchanged: 0, pruned: 0,
      prunedIds: [], activeCount: 2, durationMs: 1, listings: [
        listing("a", 10), listing("b", 20),
      ],
    };
    expect(h.recordSyncResult(result, "2026-08-01T00:00:00Z")).toBe(2); // both new
    // same prices again → nothing
    expect(h.recordSyncResult(result, "2026-08-02T00:00:00Z")).toBe(0);
    // reprice a
    expect(
      h.recordSyncResult(
        { ...result, listings: [listing("a", 12), listing("b", 20)] },
        "2026-08-03T00:00:00Z",
      ),
    ).toBe(1);
    expect(h.size()).toBe(3);
    const hist = h.priceHistory("t-a");
    expect(hist.map((p) => [p.event, p.price])).toEqual([
      ["reprice", 12],
      ["new", 10],
    ]);
    h.close();
  });

  it("cardLifetime summarizes and delists close the card", () => {
    const h = new HistoryStore(dbPath);
    h.recordSyncResult(
      { provider: "x", shortCircuited: false, builtAt: null, previousBuiltAt: null, querySignature: "", fetched: 1, upserted: 1, unchanged: 0, pruned: 0, prunedIds: [], activeCount: 1, durationMs: 1, listings: [listing("a", 10)] },
      "2026-08-01T00:00:00Z",
    );
    h.recordSyncResult(
      { provider: "x", shortCircuited: false, builtAt: null, previousBuiltAt: null, querySignature: "", fetched: 1, upserted: 1, unchanged: 0, pruned: 0, prunedIds: [], activeCount: 1, durationMs: 1, listings: [listing("a", 15)] },
      "2026-08-05T00:00:00Z",
    );
    h.recordDelists(
      [{ ts: "2026-08-06T00:00:00Z", provider: "x", listingId: "a", lastBestAsk: 15, lastBestBid: null, reason: "delisted_or_sold", source: "poll-diff" }],
      "2026-08-06T00:00:00Z",
    );
    const life = h.cardLifetime("t-a")!;
    expect(life.firstSeenAt).toBe("2026-08-01T00:00:00Z");
    expect(life.firstPrice).toBe(10);
    expect(life.lastPrice).toBe(15);
    expect(life.minPrice).toBe(10);
    expect(life.maxPrice).toBe(15);
    expect(life.repriceCount).toBe(1);
    expect(life.delistedAt).toBe("2026-08-06T00:00:00Z");
    expect(life.isActive).toBe(false);
    h.close();
  });

  it("records through PollEngine history option end to end", async () => {
    const { PollEngine } = await import("../src/aggregate/PollEngine.js");
    const store = new ListingStore();
    const provider = createFixtureProvider({ path: "fixtures/radar-sample.json", providerId: "fixture" });
    const h = new HistoryStore(dbPath);
    const poll = new PollEngine({
      store,
      providers: [provider],
      filter: { limit: 5 },
      minIntervalMs: 50,
      tickMs: 25,
      history: h,
    });
    poll.start();
    await new Promise((r) => setTimeout(r, 120));
    poll.stop();
    expect(h.size()).toBeGreaterThan(0);
    const recent = h.recentEvents(10);
    expect(recent.length).toBeGreaterThan(0);
    expect(recent[0]!.listingId).toBeTruthy();
    h.close();
  });
});
