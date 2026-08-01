import { mkdtempSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listingId } from "../src/identity.js";
import {
  ListingChangeLog,
  RunCapture,
} from "../src/capture/index.js";
import type { Listing, SyncResult } from "../src/types.js";

function makeListing(
  nativeId: string,
  price: number,
  opts: {
    provider?: string;
    platform?: string;
    seller?: string | null;
    listedAt?: string | null;
  } = {},
): Listing {
  const provider = opts.provider ?? "fixture";
  const platform = opts.platform ?? "cy";
  return {
    id: listingId({ provider, platform, nativeId }),
    provider,
    platform,
    nativeId,
    tokenId: null,
    name: `card-${nativeId}`,
    price,
    currency: "USDC",
    fmv: null,
    delta: null,
    market: null,
    seller: opts.seller ?? "seller-a",
    externalUrl: null,
    imageUrl: null,
    listedAt: opts.listedAt ?? "2026-08-01T00:00:00.000Z",
    firstListedAt: null,
    lastEvent: "LIST",
    tcg: "pokemon",
    itemType: "card",
    grader: null,
    grade: null,
    gradeNum: null,
    language: null,
    setRaw: null,
    cardNumber: null,
    year: null,
    confidence: null,
    canonical: null,
    contractAddress: null,
  };
}

function syncResult(
  listings: Listing[],
  partial: Partial<SyncResult> = {},
): SyncResult {
  const provider = partial.provider ?? listings[0]?.provider ?? "fixture";
  return {
    provider,
    shortCircuited: false,
    builtAt: "fp:test",
    previousBuiltAt: null,
    querySignature: partial.querySignature ?? "limit=10&tcg=pokemon",
    fetched: listings.length,
    upserted: listings.length,
    unchanged: 0,
    pruned: 0,
    activeCount: listings.length,
    durationMs: 12,
    listings,
    ...partial,
  };
}

describe("ListingChangeLog (pure delta)", () => {
  it("emits new / reprice / closed on price|listedAt|seller only", () => {
    const log = new ListingChangeLog();
    const a = makeListing("1", 10, { seller: "s1", listedAt: "2026-01-01T00:00:00.000Z" });
    const b = makeListing("2", 20);

    const e1 = log.onListingsDiff([a, b], { provider: "fixture", querySignature: "q" });
    expect(e1.map((e) => e.kind)).toEqual(["new", "new"]);

    // unchanged price/listedAt/seller → no event
    const e2 = log.onListingsDiff(
      [a, b],
      { provider: "fixture", querySignature: "q" },
    );
    expect(e2).toEqual([]);

    // price change
    const a2 = makeListing("1", 11, { seller: "s1", listedAt: "2026-01-01T00:00:00.000Z" });
    const e3 = log.onListingsDiff(
      [a2, b],
      { provider: "fixture", querySignature: "q" },
    );
    expect(e3).toHaveLength(1);
    expect(e3[0]).toMatchObject({ kind: "reprice", prevPrice: 10, price: 11 });

    // seller change counts as reprice
    const a3 = makeListing("1", 11, { seller: "s2", listedAt: "2026-01-01T00:00:00.000Z" });
    const e4 = log.onListingsDiff(
      [a3, b],
      { provider: "fixture", querySignature: "q" },
    );
    expect(e4[0]).toMatchObject({ kind: "reprice", prevSeller: "s1", seller: "s2" });

    // listedAt change
    const a4 = makeListing("1", 11, { seller: "s2", listedAt: "2026-02-01T00:00:00.000Z" });
    const e5 = log.onListingsDiff(
      [a4, b],
      { provider: "fixture", querySignature: "q" },
    );
    expect(e5[0]?.kind).toBe("reprice");

    // closed when id leaves page
    const e6 = log.onListingsDiff([b], { provider: "fixture", querySignature: "q" });
    expect(e6).toHaveLength(1);
    expect(e6[0]).toMatchObject({ kind: "closed", id: a.id });
  });

  it("shortCircuited SyncResult yields no events", () => {
    const log = new ListingChangeLog();
    const r = syncResult([makeListing("1", 1)], { shortCircuited: true, upserted: 0 });
    expect(log.onSyncResult(r)).toEqual([]);
  });
});

describe("RunCapture", () => {
  it("open / onSyncResult / onBookChange / onHealth / close — deltas only", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-capture-"));
    let t = Date.parse("2026-08-01T14:30:00.000Z");
    const cap = RunCapture.open(dir, {
      checkpointMs: 0,
      meta: { providers: ["fixture"] },
      now: () => new Date(t),
    });

    expect(existsSync(join(dir, "meta.json"))).toBe(true);
    expect(existsSync(join(dir, "events.jsonl"))).toBe(true);

    const l1 = makeListing("a", 5);
    const l2 = makeListing("b", 8);
    const r1 = syncResult([l1, l2]);
    const events1 = cap.onSyncResult(r1);
    expect(events1.map((e) => e.kind)).toEqual(["new", "new"]);

    // short-circuit: health only, no listing events
    t += 1000;
    cap.onSyncResult(
      syncResult([l1, l2], {
        shortCircuited: true,
        upserted: 0,
        unchanged: 2,
        pruned: 0,
        durationMs: 3,
      }),
    );

    // reprice + close
    t += 1000;
    const l1b = makeListing("a", 6);
    cap.onSyncResult(syncResult([l1b], { pruned: 1, upserted: 1, unchanged: 0 }));

    // book fp gate
    t += 1000;
    const b1 = cap.onBookChange({
      instrumentKey: "poke:1",
      bestBid: 1,
      bestAsk: 2,
      currency: "USDC",
    });
    expect(b1?.fp).toBeTruthy();
    const b2 = cap.onBookChange({
      instrumentKey: "poke:1",
      bestBid: 1,
      bestAsk: 2,
      currency: "USDC",
    });
    expect(b2).toBeNull();
    const b3 = cap.onBookChange({
      instrumentKey: "poke:1",
      bestBid: 1.5,
      bestAsk: 2,
      currency: "USDC",
    });
    expect(b3).not.toBeNull();

    cap.onHealth({
      ts: new Date(t).toISOString(),
      provider: "fixture",
      softFail: true,
      lastError: "soft-fail HTTP 500",
      lastSuccessfulPullAt: "2026-08-01T14:00:00.000Z",
      lastRowCount: 2,
    });

    cap.close();

    const events = cap.readEvents();
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["new", "new", "reprice", "closed"]);
    expect(events.filter((e) => e.kind === "reprice")[0]).toMatchObject({
      price: 6,
      prevPrice: 5,
    });

    const health = cap.readHealth();
    expect(health.length).toBeGreaterThanOrEqual(3);
    expect(health.some((h) => h.shortCircuited === true)).toBe(true);
    expect(health.some((h) => h.softFail === true)).toBe(true);

    const books = cap.readBooks();
    expect(books).toHaveLength(2);

    const snaps = readdirSync(join(dir, "snapshots"));
    expect(snaps.length).toBeGreaterThanOrEqual(1);
    const snapBody = JSON.parse(
      readFileSync(join(dir, "snapshots", snaps[0]!), "utf8"),
    ) as { listings: Listing[] };
    expect(Array.isArray(snapBody.listings)).toBe(true);

    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as {
      endedAt?: string;
      providers?: string[];
    };
    expect(meta.endedAt).toBeTruthy();
    expect(meta.providers).toEqual(["fixture"]);
  });

  it("does not snapshot again without change; snapshots on dirty after interval", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-capture-cp-"));
    let t = Date.parse("2026-08-01T14:30:00.000Z");
    const cap = RunCapture.open(dir, {
      checkpointMs: 60_000,
      now: () => new Date(t),
    });

    const listings = [makeListing("x", 1), makeListing("y", 2)];
    cap.onSyncResult(syncResult(listings));
    const n1 = readdirSync(join(dir, "snapshots")).length;
    expect(n1).toBe(1);

    // same listings soon after — no new snapshot
    t += 1000;
    cap.onSyncResult(syncResult(listings, { upserted: 0, unchanged: 2 }));
    expect(readdirSync(join(dir, "snapshots")).length).toBe(1);

    // reprice but still inside checkpoint window
    t += 1000;
    const re = [makeListing("x", 9), makeListing("y", 2)];
    cap.onSyncResult(syncResult(re, { upserted: 1, unchanged: 1 }));
    expect(readdirSync(join(dir, "snapshots")).length).toBe(1);
    expect(cap.readEvents().some((e) => e.kind === "reprice")).toBe(true);

    // past checkpointMs + dirty → snapshot
    t += 60_000;
    cap.maybeCheckpoint("fixture", "limit=10&tcg=pokemon");
    expect(readdirSync(join(dir, "snapshots")).length).toBe(2);

    cap.close();
  });

  it("soft_fail writes event and skips listing replace", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-capture-sf-"));
    const cap = RunCapture.open(dir, { checkpointMs: 0 });
    const listings = [makeListing("z", 3)];
    cap.onSyncResult(syncResult(listings));
    const nKnown = cap.log.size();

    cap.onSyncResult(syncResult([], { fetched: 0, upserted: 0, activeCount: 0 }), {
      softFail: true,
      lastError: "soft-fail HTTP 500",
      watermark: {
        provider: "fixture",
        lastSuccessfulPullAt: "2026-08-01T10:00:00.000Z",
        lastBuiltAt: "fp:old",
        lastRowCount: 1,
        lastError: "soft-fail HTTP 500",
      },
    });

    expect(cap.log.size()).toBe(nKnown);
    const events = cap.readEvents();
    expect(events.some((e) => e.kind === "soft_fail")).toBe(true);
    expect(events.filter((e) => e.kind === "closed")).toHaveLength(0);
    cap.close();
  });

  it("exports RunCapture + ListingChangeLog from package index", async () => {
    const mod = await import("../src/index.js");
    expect(typeof mod.RunCapture.open).toBe("function");
    expect(typeof mod.ListingChangeLog).toBe("function");
  });
});
