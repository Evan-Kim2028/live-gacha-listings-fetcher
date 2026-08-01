import { describe, expect, it } from "vitest";
import { listingId } from "../src/identity.js";
import {
  isStale,
  listingAgeMs,
  withLastSeenAt,
} from "../src/listingAge.js";
import { ListingStore } from "../src/store.js";
import { syncOnce } from "../src/sync.js";
import type { ListingsProvider, PullPage, PullQuery } from "../src/providers/types.js";
import type { Listing } from "../src/types.js";

function makeListing(
  nativeId: string,
  price: number,
  extra: Partial<Listing> = {},
): Listing {
  const provider = extra.provider ?? "mem";
  const platform = extra.platform ?? "courtyard";
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
    seller: null,
    externalUrl: null,
    imageUrl: null,
    listedAt: "2026-08-01T00:00:00.000Z",
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
    ...extra,
  };
}

class ScriptedProvider implements ListingsProvider {
  readonly id = "mem";
  lastError: string | null = null;
  private pages: {
    builtAt: string;
    listings: Listing[];
    fetchedAt?: string;
    softFail?: boolean;
  }[] = [];
  private i = 0;

  queue(page: {
    builtAt: string;
    listings: Listing[];
    fetchedAt?: string;
    softFail?: boolean;
  }): void {
    this.pages.push(page);
  }

  async pull(_query?: PullQuery): Promise<PullPage> {
    const page = this.pages[Math.min(this.i, this.pages.length - 1)]!;
    this.i += 1;
    if (page.softFail) {
      this.lastError = "soft-fail HTTP 500 (test)";
      return {
        listings: [],
        hasMore: false,
        meta: {
          provider: this.id,
          builtAt: page.builtAt,
          total: 0,
          universe: 0,
          fetchedAt: page.fetchedAt ?? new Date().toISOString(),
          querySignature: "",
        },
      };
    }
    this.lastError = null;
    return {
      listings: page.listings,
      hasMore: false,
      meta: {
        provider: this.id,
        builtAt: page.builtAt,
        total: page.listings.length,
        universe: page.listings.length,
        fetchedAt: page.fetchedAt ?? new Date().toISOString(),
        querySignature: "",
      },
    };
  }
}

describe("withLastSeenAt / isStale", () => {
  it("fills lastSeenAt only when missing", () => {
    const a = makeListing("a", 10);
    const stamped = withLastSeenAt(a, "2026-08-01T12:00:00.000Z");
    expect(stamped.lastSeenAt).toBe("2026-08-01T12:00:00.000Z");

    const keep = withLastSeenAt(
      { ...a, lastSeenAt: "2026-08-01T11:00:00.000Z" },
      "2026-08-01T12:00:00.000Z",
    );
    expect(keep.lastSeenAt).toBe("2026-08-01T11:00:00.000Z");
  });

  it("isStale uses lastSeenAt vs maxAgeMs; missing → stale", () => {
    const now = Date.parse("2026-08-01T12:00:00.000Z");
    const fresh = makeListing("a", 10, {
      lastSeenAt: "2026-08-01T11:59:00.000Z",
    });
    const old = makeListing("b", 10, {
      lastSeenAt: "2026-08-01T11:00:00.000Z",
    });
    const bare = makeListing("c", 10);

    expect(isStale(fresh, 120_000, now)).toBe(false);
    expect(isStale(old, 120_000, now)).toBe(true);
    expect(isStale(bare, 120_000, now)).toBe(true);
    expect(listingAgeMs(old, now)).toBe(3_600_000);
  });

  it("does not treat identity fields as age", () => {
    const l = makeListing("x", 5, { lastSeenAt: "2026-08-01T12:00:00.000Z" });
    expect(l.id).toBe(listingId({ provider: "mem", platform: "courtyard", nativeId: "x" }));
    expect(isStale(l, 60_000, Date.parse("2026-08-01T12:00:30.000Z"))).toBe(false);
  });
});

describe("store upsert stamps lastSeenAt from apply fetchedAt", () => {
  it("upsertOne / replaceScopeSnapshot set lastSeenAt; equality ignores it", () => {
    const store = new ListingStore();
    const a = makeListing("a", 10);
    const t1 = "2026-08-01T10:00:00.000Z";
    store.upsertOne(a, { provider: "mem", querySignature: "" }, t1);
    expect(store.get(a.id)?.lastSeenAt).toBe(t1);
    expect(store.get(a.id)?.id).toBe(a.id);

    const t2 = "2026-08-01T10:05:00.000Z";
    const stats = store.replaceScopeSnapshot("mem", "", [makeListing("a", 10)], t2);
    expect(stats.unchanged).toBe(1);
    expect(store.get(a.id)?.lastSeenAt).toBe(t2);
    expect(store.get(a.id)?.price).toBe(10);
  });

  it("touchLastSeenAt refreshes scope without changing price identity", () => {
    const store = new ListingStore();
    const a = makeListing("a", 10);
    store.replaceScopeSnapshot("mem", "", [a], "2026-08-01T10:00:00.000Z");
    const n = store.touchLastSeenAt("mem", "", "2026-08-01T10:10:00.000Z");
    expect(n).toBe(1);
    expect(store.get(a.id)?.lastSeenAt).toBe("2026-08-01T10:10:00.000Z");
    expect(store.get(a.id)?.price).toBe(10);
  });
});

describe("syncOnce lastSeenAt + soft-fail grey-out", () => {
  it("successful apply stamps from page.meta.fetchedAt", async () => {
    const store = new ListingStore();
    const provider = new ScriptedProvider();
    const a = makeListing("a", 10);
    const fetchedAt = "2026-08-01T15:00:00.000Z";
    provider.queue({
      builtAt: "gen-1",
      listings: [a],
      fetchedAt,
    });

    await syncOnce(store, provider, { shortCircuitOnBuiltAt: false });
    expect(store.get(a.id)?.lastSeenAt).toBe(fetchedAt);
    expect(isStale(store.get(a.id)!, 60_000, Date.parse(fetchedAt) + 10_000)).toBe(
      false,
    );
  });

  it("soft-fail empty does not refresh lastSeenAt (grey-out via isStale)", async () => {
    const store = new ListingStore();
    const provider = new ScriptedProvider();
    const a = makeListing("a", 10);
    const tGood = "2026-08-01T15:00:00.000Z";
    provider.queue({
      builtAt: "gen-1",
      listings: [a],
      fetchedAt: tGood,
    });
    provider.queue({
      builtAt: "gen-2",
      listings: [],
      fetchedAt: "2026-08-01T15:30:00.000Z",
      softFail: true,
    });

    await syncOnce(store, provider, { shortCircuitOnBuiltAt: false });
    expect(store.get(a.id)?.lastSeenAt).toBe(tGood);

    const soft = await syncOnce(store, provider, { shortCircuitOnBuiltAt: false });
    expect(soft.shortCircuited).toBe(true);
    expect(soft.pruned).toBe(0);
    expect(store.get(a.id)?.lastSeenAt).toBe(tGood);
    expect(store.size()).toBe(1);

    // 30+ minutes after last good see → stale for a 5 min policy
    const now = Date.parse("2026-08-01T15:30:00.000Z");
    expect(isStale(store.get(a.id)!, 5 * 60_000, now)).toBe(true);
  });

  it("content short-circuit refreshes lastSeenAt without replace", async () => {
    const store = new ListingStore();
    const provider = new ScriptedProvider();
    const a = makeListing("a", 10);
    provider.queue({
      builtAt: "gen-1",
      listings: [a],
      fetchedAt: "2026-08-01T15:00:00.000Z",
    });
    // Same content, different builtAt → content short-circuit when enabled
    provider.queue({
      builtAt: "gen-2-different-builtAt",
      listings: [makeListing("a", 10)],
      fetchedAt: "2026-08-01T15:01:00.000Z",
    });

    await syncOnce(store, provider, { shortCircuitOnBuiltAt: false });
    const r2 = await syncOnce(store, provider, { shortCircuitOnBuiltAt: true });
    expect(r2.shortCircuited).toBe(true);
    expect(store.get(a.id)?.lastSeenAt).toBe("2026-08-01T15:01:00.000Z");
  });
});
