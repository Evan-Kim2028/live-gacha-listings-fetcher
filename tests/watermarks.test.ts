import { describe, expect, it } from "vitest";
import { MultiSourceRadar } from "../src/aggregate/MultiSourceRadar.js";
import { ListingStore } from "../src/store.js";
import { syncIncremental, syncOnce } from "../src/sync.js";
import type { ListingsProvider, PullPage } from "../src/providers/types.js";
import type { Listing } from "../src/types.js";

function listingStub(provider: string, nativeId: string, price = 10): Listing {
  return {
    id: `${provider}:cc:${nativeId}`,
    provider,
    platform: "cc",
    nativeId,
    tokenId: null,
    name: `Card ${nativeId}`,
    price,
    currency: "USDC",
    fmv: null,
    delta: null,
    market: null,
    seller: null,
    externalUrl: null,
    imageUrl: null,
    listedAt: null,
    firstListedAt: null,
    lastEvent: null,
    tcg: "pokemon",
    itemType: null,
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

function page(
  provider: string,
  listings: Listing[],
  builtAt = "2026-06-01T00:00:00.000Z",
): PullPage {
  return {
    listings,
    hasMore: false,
    meta: {
      provider,
      builtAt,
      total: listings.length,
      universe: listings.length,
      fetchedAt: new Date().toISOString(),
      querySignature: "",
    },
  };
}

describe("per-provider watermarks + multi-source isolation", () => {
  it("syncOnce records lastSuccessfulPullAt / lastBuiltAt / lastRowCount", async () => {
    const store = new ListingStore();
    const ok: ListingsProvider = {
      id: "src_a",
      async pull() {
        return page("src_a", [listingStub("src_a", "1"), listingStub("src_a", "2")]);
      },
    };
    const r = await syncOnce(store, ok, { shortCircuitOnBuiltAt: false });
    expect(r.fetched).toBe(2);
    const wm = store.getWatermark("src_a");
    expect(wm).toBeDefined();
    expect(wm!.lastError).toBeNull();
    expect(wm!.lastBuiltAt).toBe("2026-06-01T00:00:00.000Z");
    expect(wm!.lastRowCount).toBe(2);
    expect(wm!.lastSuccessfulPullAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("two-provider store: one hard-fails; other data and watermark remain", async () => {
    const store = new ListingStore();
    const ok: ListingsProvider = {
      id: "ok_src",
      async pull() {
        return page("ok_src", [listingStub("ok_src", "keep-me", 42)]);
      },
    };
    const boom: ListingsProvider = {
      id: "boom_src",
      async pull() {
        throw new Error("HTTP 503 origin down");
      },
    };

    // Seed both via first successful pass on ok only
    await syncOnce(store, ok, { shortCircuitOnBuiltAt: false });
    expect(store.size("ok_src")).toBe(1);
    const okWmBefore = store.getWatermark("ok_src")!;
    expect(okWmBefore.lastError).toBeNull();
    expect(okWmBefore.lastRowCount).toBe(1);

    const radar = new MultiSourceRadar({
      store,
      providers: [ok, boom],
    });
    const r = await radar.syncAll();

    expect(r.errors.boom_src).toMatch(/HTTP 503/);
    expect(r.results.map((x) => x.provider)).toEqual(["ok_src"]);
    // Failed provider must not wipe the healthy one
    expect(store.size("ok_src")).toBe(1);
    expect(store.get("ok_src:cc:keep-me")?.price).toBe(42);
    expect(store.size("boom_src")).toBe(0);
    expect(r.totalActive).toBe(1);
    expect(r.byProvider.ok_src).toBe(1);
    expect(r.byProvider.boom_src).toBe(0);

    const okWm = store.getWatermark("ok_src")!;
    expect(okWm.lastError).toBeNull();
    expect(okWm.lastRowCount).toBe(1);
    expect(okWm.lastSuccessfulPullAt).toBeTruthy();

    const boomWm = store.getWatermark("boom_src")!;
    expect(boomWm.lastError).toMatch(/HTTP 503/);
    expect(boomWm.lastSuccessfulPullAt).toBeNull();
    expect(boomWm.lastRowCount).toBe(0);
  });

  it("soft-fail empty does not prune prior scope; sets lastError; keeps success stamps", async () => {
    const store = new ListingStore();
    let fail = false;
    const soft: ListingsProvider = {
      id: "soft_src",
      lastError: null,
      async pull() {
        if (fail) {
          this.lastError = "marketplace 500";
          return page("soft_src", [], null as unknown as string);
        }
        this.lastError = null;
        return page("soft_src", [listingStub("soft_src", "a")], "gen-1");
      },
    };

    await syncOnce(store, soft, { shortCircuitOnBuiltAt: false });
    expect(store.size("soft_src")).toBe(1);
    const good = store.getWatermark("soft_src")!;
    expect(good.lastError).toBeNull();
    expect(good.lastBuiltAt).toBe("gen-1");
    expect(good.lastRowCount).toBe(1);
    const successAt = good.lastSuccessfulPullAt;

    fail = true;
    const r = await syncOnce(store, soft, { shortCircuitOnBuiltAt: false });
    expect(r.shortCircuited).toBe(true);
    expect(r.pruned).toBe(0);
    expect(store.size("soft_src")).toBe(1);
    expect(store.get("soft_src:cc:a")).toBeDefined();

    const bad = store.getWatermark("soft_src")!;
    expect(bad.lastError).toMatch(/500/);
    expect(bad.lastSuccessfulPullAt).toBe(successAt);
    expect(bad.lastBuiltAt).toBe("gen-1");
    expect(bad.lastRowCount).toBe(1);
  });

  it("syncIncremental is alias of syncOnce (scoped upsert+prune)", async () => {
    const store = new ListingStore();
    const p: ListingsProvider = {
      id: "inc",
      async pull() {
        return page("inc", [listingStub("inc", "x")]);
      },
    };
    const r = await syncIncremental(store, p, { shortCircuitOnBuiltAt: false });
    expect(r.provider).toBe("inc");
    expect(store.size("inc")).toBe(1);
    expect(store.getWatermark("inc")?.lastRowCount).toBe(1);
  });

  it("failed provider after both had data does not wipe the other", async () => {
    const store = new ListingStore();
    let aFail = false;
    const a: ListingsProvider = {
      id: "prov_a",
      async pull() {
        if (aFail) throw new Error("prov_a timeout");
        return page("prov_a", [listingStub("prov_a", "1")], "a1");
      },
    };
    const b: ListingsProvider = {
      id: "prov_b",
      async pull() {
        return page("prov_b", [listingStub("prov_b", "2")], "b1");
      },
    };

    const radar = new MultiSourceRadar({ store, providers: [a, b] });
    const first = await radar.syncAll();
    expect(first.totalActive).toBe(2);
    expect(Object.keys(first.errors)).toHaveLength(0);

    aFail = true;
    const second = await radar.syncAll();
    expect(second.errors.prov_a).toMatch(/timeout/);
    expect(second.byProvider.prov_a).toBe(1); // prior scope retained (throw before replace)
    expect(second.byProvider.prov_b).toBe(1);
    expect(store.get("prov_a:cc:1")).toBeDefined();
    expect(store.get("prov_b:cc:2")).toBeDefined();
    expect(store.getWatermark("prov_a")?.lastError).toMatch(/timeout/);
    expect(store.getWatermark("prov_a")?.lastSuccessfulPullAt).toBeTruthy();
    expect(store.getWatermark("prov_b")?.lastError).toBeNull();
  });
});
