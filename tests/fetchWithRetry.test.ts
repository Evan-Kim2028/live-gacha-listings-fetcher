import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeRetryDelayMs,
  fetchWithRetry,
  getResponseEtag,
  isNotModifiedStatus,
  isRetryableStatus,
  withIfNoneMatch,
} from "../src/http/fetchWithRetry.js";
import {
  getMetrics,
  getProviderMetrics,
  recordPull,
  resetMetrics,
} from "../src/http/metrics.js";
import { ListingStore } from "../src/store.js";
import { syncOnce } from "../src/sync.js";
import { PollEngine } from "../src/aggregate/PollEngine.js";
import type { ListingsProvider, PullPage } from "../src/providers/types.js";
import { listingId } from "../src/identity.js";

function mockProvider(
  id: string,
  opts?: { softError?: string; throwMsg?: string },
): ListingsProvider {
  const p: ListingsProvider = {
    id,
    lastError: null,
    async pull(): Promise<PullPage> {
      if (opts?.throwMsg) throw new Error(opts.throwMsg);
      if (opts?.softError) {
        p.lastError = opts.softError;
        return {
          listings: [],
          hasMore: false,
          meta: {
            provider: id,
            builtAt: new Date().toISOString(),
            total: 0,
            universe: null,
            fetchedAt: new Date().toISOString(),
            querySignature: "",
          },
        };
      }
      p.lastError = null;
      const nativeId = "n1";
      return {
        listings: [
          {
            id: listingId({ provider: id, platform: "cc", nativeId }),
            provider: id,
            platform: "cc",
            nativeId,
            tokenId: null,
            name: "Card",
            price: 10,
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
            searchBlob: null,
            raw: {},
          },
        ],
        hasMore: false,
        meta: {
          provider: id,
          builtAt: new Date().toISOString(),
          total: 1,
          universe: null,
          fetchedAt: new Date().toISOString(),
          querySignature: "",
        },
      };
    },
  };
  return p;
}

afterEach(() => {
  resetMetrics();
  vi.useRealTimers();
});

describe("isRetryableStatus", () => {
  it("retries 429 and 5xx only", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
  });
});

describe("computeRetryDelayMs", () => {
  it("uses exponential base * 2^attempt", () => {
    expect(computeRetryDelayMs(null, 0, 100)).toBe(100);
    expect(computeRetryDelayMs(null, 1, 100)).toBe(200);
    expect(computeRetryDelayMs(null, 2, 100)).toBe(400);
  });

  it("honors Retry-After seconds floor", () => {
    const res = new Response("", {
      status: 429,
      headers: { "Retry-After": "2" },
    });
    expect(computeRetryDelayMs(res, 0, 100)).toBe(2000);
  });

  it("caps at maxDelayMs", () => {
    expect(computeRetryDelayMs(null, 10, 1000, 5_000)).toBe(5_000);
  });
});

describe("fetchWithRetry", () => {
  it("returns first successful response without extra calls", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const res = await fetchWithRetry(
      "https://example.test/a",
      undefined,
      { fetchImpl: fetchImpl as typeof fetch, maxRetries: 3, baseDelayMs: 1 },
    );
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  it("retries 429 then succeeds (max 3 retries)", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetchImpl = async () => {
      calls += 1;
      if (calls < 3) {
        return new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      }
      return new Response("ok", { status: 200 });
    };
    const res = await fetchWithRetry("https://example.test/r", undefined, {
      fetchImpl: fetchImpl as typeof fetch,
      maxRetries: 3,
      baseDelayMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(3);
    expect(sleeps.length).toBe(2);
    // exponential: 10 * 2^0, 10 * 2^1 (Retry-After 0 does not raise floor)
    expect(sleeps[0]).toBe(10);
    expect(sleeps[1]).toBe(20);
  });

  it("retries 503 then returns last response when exhausted", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response("down", { status: 503 });
    };
    const res = await fetchWithRetry("https://example.test/5xx", undefined, {
      fetchImpl: fetchImpl as typeof fetch,
      maxRetries: 2,
      baseDelayMs: 1,
      sleep: async () => {},
    });
    expect(res.status).toBe(503);
    // initial + 2 retries
    expect(calls).toBe(3);
  });

  it("does not retry 404", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response("nope", { status: 404 });
    };
    const res = await fetchWithRetry("https://example.test/missing", undefined, {
      fetchImpl: fetchImpl as typeof fetch,
      maxRetries: 3,
      baseDelayMs: 1,
      sleep: async () => {
        throw new Error("should not sleep");
      },
    });
    expect(res.status).toBe(404);
    expect(calls).toBe(1);
  });

  it("retries network errors then throws when exhausted", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      throw new Error("fetch failed");
    };
    await expect(
      fetchWithRetry("https://example.test/net", undefined, {
        fetchImpl: fetchImpl as typeof fetch,
        maxRetries: 2,
        baseDelayMs: 1,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/fetch failed/);
    expect(calls).toBe(3);
  });

  it("maxRetries 0 means single attempt", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response("rl", { status: 429 });
    };
    const res = await fetchWithRetry("https://example.test/once", undefined, {
      fetchImpl: fetchImpl as typeof fetch,
      maxRetries: 0,
      baseDelayMs: 1,
    });
    expect(res.status).toBe(429);
    expect(calls).toBe(1);
  });

  it("sends If-None-Match when ifNoneMatch option is set", async () => {
    let seen: string | null = null;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seen = h.get("If-None-Match");
      return new Response(null, { status: 304 });
    };
    const res = await fetchWithRetry(
      "https://example.test/etag",
      { headers: { Accept: "application/json" } },
      {
        fetchImpl: fetchImpl as typeof fetch,
        ifNoneMatch: '"abc123"',
        maxRetries: 0,
      },
    );
    expect(res.status).toBe(304);
    expect(seen).toBe('"abc123"');
  });

  it("does not overwrite existing If-None-Match header", async () => {
    let seen: string | null = null;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      seen = h.get("If-None-Match");
      return new Response("ok", { status: 200 });
    };
    await fetchWithRetry(
      "https://example.test/etag2",
      { headers: { "If-None-Match": '"keep-me"' } },
      {
        fetchImpl: fetchImpl as typeof fetch,
        ifNoneMatch: '"override"',
        maxRetries: 0,
      },
    );
    expect(seen).toBe('"keep-me"');
  });

  it("does not retry 304", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response(null, { status: 304 });
    };
    const res = await fetchWithRetry("https://example.test/nm", undefined, {
      fetchImpl: fetchImpl as typeof fetch,
      ifNoneMatch: '"x"',
      maxRetries: 3,
      baseDelayMs: 1,
      sleep: async () => {
        throw new Error("should not sleep");
      },
    });
    expect(res.status).toBe(304);
    expect(calls).toBe(1);
  });
});

describe("etag helpers", () => {
  it("getResponseEtag / isNotModifiedStatus / withIfNoneMatch", () => {
    expect(isNotModifiedStatus(304)).toBe(true);
    expect(isNotModifiedStatus(200)).toBe(false);
    const res = new Response("", {
      status: 200,
      headers: { ETag: 'W/"xyz"' },
    });
    expect(getResponseEtag(res)).toBe('W/"xyz"');
    expect(getResponseEtag(new Response("", { status: 200 }))).toBeNull();
    const init = withIfNoneMatch({ headers: { Accept: "a" } }, '"t"');
    expect(new Headers(init?.headers).get("If-None-Match")).toBe('"t"');
    expect(withIfNoneMatch(undefined, null)).toBeUndefined();
  });
});

describe("provider metrics", () => {
  it("recordPull / getMetrics track pulls errors latency_ms", () => {
    recordPull("collectorcrypt", 12, false);
    recordPull("collectorcrypt", 20, true);
    recordPull("magiceden", 5, false);
    const m = getMetrics();
    expect(m.collectorcrypt).toEqual({
      pulls: 2,
      errors: 1,
      latency_ms: 20,
      total_latency_ms: 32,
    });
    expect(getProviderMetrics("magiceden").pulls).toBe(1);
    expect(getProviderMetrics("missing").pulls).toBe(0);
  });

  it("syncOnce records metrics on success and soft error", async () => {
    const store = new ListingStore();
    const ok = mockProvider("fx_ok");
    await syncOnce(store, ok, { shortCircuitOnBuiltAt: false });
    expect(getProviderMetrics("fx_ok").pulls).toBe(1);
    expect(getProviderMetrics("fx_ok").errors).toBe(0);
    expect(getProviderMetrics("fx_ok").latency_ms).toBeGreaterThanOrEqual(0);

    const soft = mockProvider("fx_soft", { softError: "boom" });
    await syncOnce(store, soft, { shortCircuitOnBuiltAt: false });
    expect(getProviderMetrics("fx_soft").pulls).toBe(1);
    expect(getProviderMetrics("fx_soft").errors).toBe(1);
  });

  it("PollEngine.getMetrics exposes counters after syncNow", async () => {
    const store = new ListingStore();
    const p = mockProvider("poll_fx");
    const engine = new PollEngine({ store, providers: [p] });
    await engine.syncNow();
    const m = engine.getMetrics();
    expect(m.poll_fx?.pulls).toBeGreaterThanOrEqual(1);
  });

  it("syncNow soft-fails per provider (Promise.allSettled): one throw does not abort sibling apply", async () => {
    const store = new ListingStore();
    const errors: Record<string, string> = {};
    const boom = mockProvider("poll_boom", { throwMsg: "HTTP 500 marketplace" });
    const ok = mockProvider("poll_ok");
    const engine = new PollEngine({
      store,
      providers: [boom, ok],
      onError: (id, err) => {
        errors[id] = err.message;
      },
    });
    const results = await engine.syncNow();
    expect(results.map((r) => r.provider)).toEqual(["poll_ok"]);
    expect(results[0]!.fetched).toBeGreaterThanOrEqual(1);
    expect(errors.poll_boom).toMatch(/HTTP 500/);
    expect(store.getWatermark("poll_boom")?.lastError).toMatch(/HTTP 500/);
    expect(store.size("poll_ok")).toBe(1);
    expect(store.size("poll_boom")).toBe(0);
    expect(store.getWatermark("poll_ok")?.lastError).toBeNull();
  });

  it("PollEngine per-provider minIntervalMs map (CC 30s / ME 20s / Beezie 20s)", () => {
    const store = new ListingStore();
    const engine = new PollEngine({
      store,
      providers: [
        mockProvider("collectorcrypt"),
        mockProvider("magiceden"),
        mockProvider("beezie"),
        mockProvider("phygitals"),
      ],
      minIntervalMs: {
        collectorcrypt: 30_000,
        magiceden: 20_000,
        beezie: 20_000,
      },
      parallel: true,
    });
    expect(engine.intervalFor("collectorcrypt")).toBe(30_000);
    expect(engine.intervalFor("magiceden")).toBe(20_000);
    expect(engine.intervalFor("beezie")).toBe(20_000);
    // Missing map key → default 30s
    expect(engine.intervalFor("phygitals")).toBe(30_000);
  });

  it("treats 403 as retryable (CDN/WAF rate window)", () => {
    expect(isRetryableStatus(403)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(404)).toBe(false);
  });
});
