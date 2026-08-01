import { describe, expect, it } from "vitest";
import { listingId } from "../src/identity.js";
import { ListingStore } from "../src/store.js";
import { applyTradedDelta, STREAM_SCOPE } from "../src/stream/applyDelta.js";
import { SseParser } from "../src/stream/parseSse.js";
import { ListingsFeed } from "../src/stream/ListingsFeed.js";
import type { TradedRadarRow } from "../src/providers/tradedgg.js";

function row(partial: Partial<TradedRadarRow> & Pick<TradedRadarRow, "instance_id" | "platform">): TradedRadarRow {
  return {
    name: "Test Card",
    price: 10,
    currency: "USDC",
    fmv: 12,
    listed_at: "2026-08-01T08:00:00+00:00",
    last_event: "LIST",
    ...partial,
  };
}

describe("SseParser", () => {
  it("parses data lines and ignores pings/comments", () => {
    const p = new SseParser();
    const msgs = p.push(
      `: connected\n\ndata: {"type":"closed","instance_id":"x","platform":"cc","reason":"SALE"}\n\n: ping\n\n`,
    );
    expect(msgs).toHaveLength(1);
    expect(JSON.parse(msgs[0]!.data).type).toBe("closed");
  });

  it("joins multi-line data", () => {
    const p = new SseParser();
    const msgs = p.push(`data: {"type":"new",\ndata: "x":1}\n\n`);
    expect(msgs[0]!.data).toContain("type");
  });
});

describe("applyTradedDelta streaming accuracy", () => {
  it("new + reprice upsert stable id; closed hard-removes", () => {
    const store = new ListingStore();
    const r = row({
      instance_id: "aaa",
      platform: "courtyard",
      price: 10,
    });
    const e1 = applyTradedDelta(store, { type: "new", row: r as unknown as Record<string, unknown> });
    expect(e1?.kind).toBe("upsert");
    const id = listingId({
      provider: "tradedgg",
      platform: "courtyard",
      nativeId: "aaa",
    });
    expect(store.get(id)?.price).toBe(10);
    expect(store.scopeSize("tradedgg", STREAM_SCOPE)).toBe(1);

    const e2 = applyTradedDelta(store, {
      type: "reprice",
      row: { ...r, price: 9, last_event: "PRICE_UPDATE" } as unknown as Record<string, unknown>,
    });
    expect(e2?.kind).toBe("upsert");
    expect(store.get(id)?.price).toBe(9);
    expect(store.size()).toBe(1);

    const e3 = applyTradedDelta(store, {
      type: "closed",
      instance_id: "aaa",
      platform: "courtyard",
      reason: "SALE",
    });
    expect(e3?.kind).toBe("close");
    expect(store.get(id)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it("closed is idempotent when already absent", () => {
    const store = new ListingStore();
    const e = applyTradedDelta(store, {
      type: "closed",
      instance_id: "missing",
      platform: "cc",
      reason: "SALE",
    });
    expect(e?.kind).toBe("close");
    if (e?.kind === "close") expect(e.removed).toBe(false);
  });
});

describe("ListingsFeed offline inject path", () => {
  it("start offline + inject deltas updates store for decisions", async () => {
    const store = new ListingStore();
    const feed = new ListingsFeed({
      store,
      offline: true,
      snapshotQuery: {
        fixturePath: new URL("../fixtures/radar-sample.json", import.meta.url)
          .pathname,
        limit: 5,
      },
    });
    await feed.start();
    expect(store.size()).toBeGreaterThan(0);
    const before = store.size();

    feed.injectDelta({
      type: "new",
      row: row({
        instance_id: "stream-only-1",
        platform: "beezie",
        price: 3.5,
        name: "Stream only",
      }) as unknown as Record<string, unknown>,
    });
    expect(store.size()).toBe(before + 1);
    const id = listingId({
      provider: "tradedgg",
      platform: "beezie",
      nativeId: "stream-only-1",
    });
    expect(store.get(id)?.price).toBe(3.5);

    feed.injectDelta({
      type: "closed",
      instance_id: "stream-only-1",
      platform: "beezie",
      reason: "SALE",
    });
    expect(store.get(id)).toBeUndefined();
    feed.stop();
  });
});
