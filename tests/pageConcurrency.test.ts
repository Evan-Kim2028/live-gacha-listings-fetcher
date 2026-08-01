import { describe, expect, it } from "vitest";
import {
  AdaptiveConcurrency,
  mapLimitAdaptive,
  paginateConcurrent,
  isThrottleError,
} from "../src/http/pageConcurrency.js";

describe("AdaptiveConcurrency", () => {
  it("ramps up after success streak and halves on throttle", () => {
    const a = new AdaptiveConcurrency({
      start: 4,
      min: 1,
      max: 8,
      successesBeforeBump: 2,
    });
    expect(a.current).toBe(4);
    a.onSuccess();
    a.onSuccess();
    expect(a.current).toBe(5);
    a.onThrottle();
    expect(a.current).toBe(2); // floor(5/2)
    a.onThrottle();
    expect(a.current).toBe(1);
    a.onThrottle();
    expect(a.current).toBe(1); // floor
  });
});

describe("mapLimitAdaptive", () => {
  it("preserves order under concurrency", async () => {
    const items = [10, 20, 30, 40, 50];
    const { results, stats } = await mapLimitAdaptive(
      items,
      async (n) => {
        await new Promise((r) => setTimeout(r, 5 + (n % 3)));
        return n * 2;
      },
      { concurrency: { start: 3, min: 1, max: 4 } },
    );
    expect(results).toEqual([20, 40, 60, 80, 100]);
    expect(stats.ok).toBe(5);
    expect(stats.peakConcurrency).toBeGreaterThanOrEqual(1);
  });

  it("retries throttle errors with backoff", async () => {
    let attempts = 0;
    const { results, stats } = await mapLimitAdaptive(
      [1],
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("HTTP 429 rate limit");
        return "ok";
      },
      {
        concurrency: { start: 2, min: 1, max: 4 },
        baseBackoffMs: 1,
        maxBackoffMs: 5,
        maxRetries: 5,
        sleep: async () => {},
      },
    );
    expect(results).toEqual(["ok"]);
    expect(stats.throttles).toBeGreaterThanOrEqual(2);
  });
});

describe("paginateConcurrent", () => {
  it("page0 then concurrent remaining; stops at short page", async () => {
    const calls: number[] = [];
    const walk = await paginateConcurrent<number>({
      maxPages: 10,
      concurrency: { start: 4, min: 1, max: 8 },
      fetchFirst: async () => {
        calls.push(0);
        return {
          listings: [0, 1],
          full: true,
          knownTotalPages: 4,
        };
      },
      fetchPage: async (i) => {
        calls.push(i);
        await new Promise((r) => setTimeout(r, 5));
        if (i === 3) return { listings: [30], full: false };
        return { listings: [i * 10, i * 10 + 1], full: true };
      },
    });
    expect(walk.pagesFetched).toBe(4);
    expect(walk.listings).toEqual([0, 1, 10, 11, 20, 21, 30]);
    expect(walk.hasMore).toBe(false);
    expect(calls[0]).toBe(0);
    expect(new Set(calls.slice(1))).toEqual(new Set([1, 2, 3]));
  });
});

describe("isThrottleError", () => {
  it("detects 429 and timeouts", () => {
    expect(isThrottleError(new Error("HTTP 429"))).toBe(true);
    expect(isThrottleError(new Error("ETIMEDOUT"))).toBe(true);
    expect(isThrottleError(new Error("parse error"))).toBe(false);
  });
});
