import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TTL_MS,
  TtlCache,
  bidCacheKey,
  mapLimit,
  mapWithBidBudget,
  resolveBidBudgetOptions,
} from "../src/orderbook/bidBudget.js";

describe("bidCacheKey", () => {
  it("namespaces provider + asset", () => {
    expect(bidCacheKey("magiceden", "mintA")).toBe("magiceden\0mintA");
    expect(bidCacheKey("cc", "a")).not.toBe(bidCacheKey("me", "a"));
  });
});

describe("TtlCache", () => {
  it("returns hit while fresh and miss after expiry", () => {
    const cache = new TtlCache<number>(1000);
    let now = 1_000_000;
    cache.set("k", 42, now);
    expect(cache.get("k", now)).toBe(42);
    expect(cache.has("k", now)).toBe(true);

    now += 999;
    expect(cache.get("k", now)).toBe(42);

    now += 2; // past expiresAt
    expect(cache.get("k", now)).toBeUndefined();
    expect(cache.has("k", now)).toBe(false);
  });

  it("ttlMs 0 disables caching (always miss)", () => {
    const cache = new TtlCache<string>(0);
    cache.set("a", "x", 5000);
    expect(cache.get("a", 5000)).toBeUndefined();
    expect(cache.has("a", 5000)).toBe(false);
  });
});

describe("mapLimit concurrency bound", () => {
  it("never exceeds maxConcurrent in flight", async () => {
    const maxConcurrent = 3;
    let inFlight = 0;
    let peak = 0;
    const n = 12;

    const results = await mapLimit(
      Array.from({ length: n }, (_, i) => i),
      maxConcurrent,
      async (item) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight -= 1;
        return item * 2;
      },
    );

    expect(peak).toBeLessThanOrEqual(maxConcurrent);
    expect(peak).toBe(maxConcurrent);
    expect(results).toEqual(Array.from({ length: n }, (_, i) => i * 2));
  });

  it("preserves order with varying latency", async () => {
    const results = await mapLimit([3, 1, 2], 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms * 10));
      return ms;
    });
    expect(results).toEqual([3, 1, 2]);
  });

  it("empty input", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});

describe("mapWithBidBudget", () => {
  it("cache hit skips fetch; expiry re-fetches", async () => {
    const cache = new TtlCache<string>(1000);
    let now = 10_000;
    const fetch = vi.fn(async (mint: string) => `v:${mint}`);

    const first = await mapWithBidBudget(["m1", "m2"], {
      provider: "me",
      assetOf: (m) => m,
      fetch,
      cache,
      ttlMs: 1000,
      maxConcurrent: 4,
      now: () => now,
    });
    expect(first.httpCalls).toBe(2);
    expect(first.cacheHits).toBe(0);
    expect(first.results).toEqual(["v:m1", "v:m2"]);
    expect(fetch).toHaveBeenCalledTimes(2);

    const second = await mapWithBidBudget(["m1", "m2"], {
      provider: "me",
      assetOf: (m) => m,
      fetch,
      cache,
      now: () => now,
    });
    expect(second.httpCalls).toBe(0);
    expect(second.cacheHits).toBe(2);
    expect(second.results).toEqual(["v:m1", "v:m2"]);
    expect(fetch).toHaveBeenCalledTimes(2);

    now += 1001;
    const third = await mapWithBidBudget(["m1"], {
      provider: "me",
      assetOf: (m) => m,
      fetch,
      cache,
      now: () => now,
    });
    expect(third.httpCalls).toBe(1);
    expect(third.cacheHits).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("respects maxSample and maxConcurrent", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => `mint${i}`);

    const out = await mapWithBidBudget(items, {
      provider: "cc",
      assetOf: (m) => m,
      maxSample: 8,
      maxConcurrent: 2,
      ttlMs: 30_000,
      fetch: async (m) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight -= 1;
        return m;
      },
    });

    expect(out.sampleUsed).toBe(8);
    expect(out.httpCalls).toBe(8);
    expect(out.results).toHaveLength(8);
    expect(peak).toBeLessThanOrEqual(2);
    expect(out.maxConcurrent).toBe(2);
  });

  it("keys by provider so same mint differs across venues", async () => {
    const cache = new TtlCache<string>(30_000);
    const fetch = vi.fn(async (_m: string, _i: number) => "x");

    await mapWithBidBudget(["mint"], {
      provider: "me",
      assetOf: (m) => m,
      fetch,
      cache,
    });
    await mapWithBidBudget(["mint"], {
      provider: "cc",
      assetOf: (m) => m,
      fetch,
      cache,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(2);
  });
});

describe("resolveBidBudgetOptions", () => {
  it("defaults", () => {
    expect(resolveBidBudgetOptions()).toEqual({
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
      ttlMs: DEFAULT_TTL_MS,
      maxSample: undefined,
    });
    expect(DEFAULT_MAX_CONCURRENT).toBe(4);
    expect(DEFAULT_TTL_MS).toBe(30_000);
  });
});

describe("MagicEden sample defaults (documented)", () => {
  it("DEFAULT_SAMPLE_MINTS is 8", async () => {
    const { DEFAULT_SAMPLE_MINTS } = await import(
      "../src/providers/magiceden.js"
    );
    expect(DEFAULT_SAMPLE_MINTS).toBe(8);
  });
});
