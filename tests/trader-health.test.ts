import { describe, expect, it, beforeEach } from "vitest";
import { ListingStore } from "../src/store.js";
import { PollEngine } from "../src/aggregate/PollEngine.js";
import {
  traderHealthSummary,
  formatHealthHud,
} from "../src/trader/health.js";
import { resetMetrics } from "../src/http/metrics.js";
import type { ListingsProvider, PullPage, PullQuery } from "../src/providers/types.js";
import { listingId } from "../src/identity.js";
import type { Listing } from "../src/types.js";

function L(
  partial: Partial<Listing> &
    Pick<Listing, "platform" | "nativeId" | "price" | "name" | "provider">,
): Listing {
  return {
    id: listingId({
      provider: partial.provider,
      platform: partial.platform,
      nativeId: partial.nativeId,
    }),
    tokenId: null,
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
    ...partial,
  };
}

function mockProvider(
  id: string,
  opts: { builtAt?: string; softError?: string; empty?: boolean } = {},
): ListingsProvider {
  const builtAt = opts.builtAt ?? "fp:test-v1";
  return {
    id,
    lastError: null as string | null,
    async pull(_query: PullQuery = {}): Promise<PullPage> {
      if (opts.softError) {
        this.lastError = opts.softError;
        return {
          listings: [],
          hasMore: false,
          meta: {
            provider: id,
            builtAt: null,
            total: 0,
            universe: 0,
            fetchedAt: new Date().toISOString(),
            querySignature: "",
          },
        };
      }
      this.lastError = null;
      const listings = opts.empty
        ? []
        : [
            L({
              provider: id,
              platform: "fx",
              nativeId: "1",
              price: 10,
              name: "Card",
            }),
          ];
      return {
        listings,
        hasMore: false,
        meta: {
          provider: id,
          builtAt,
          total: listings.length,
          universe: listings.length,
          fetchedAt: new Date().toISOString(),
          querySignature: "",
        },
      };
    },
  };
}

describe("traderHealthSummary + formatHealthHud", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("reads watermarks: lastSuccessfulPullAt / lastError / lastRowCount", () => {
    const store = new ListingStore();
    store.markProviderSuccess("a", {
      builtAt: "fp:1",
      rowCount: 12,
      at: "2026-08-01T12:00:00.000Z",
    });
    store.markProviderError("b", "HTTP 500");
    store.setWatermark({
      provider: "b",
      lastSuccessfulPullAt: "2026-08-01T11:00:00.000Z",
      lastBuiltAt: "fp:old",
      lastRowCount: 3,
      lastError: "HTTP 500",
    });

    const summary = traderHealthSummary({
      store,
      at: "2026-08-01T12:30:00.000Z",
    });
    expect(summary.providers.map((p) => p.provider)).toEqual(["a", "b"]);
    const a = summary.providers.find((p) => p.provider === "a")!;
    expect(a.lastSuccessfulPullAt).toBe("2026-08-01T12:00:00.000Z");
    expect(a.lastError).toBeNull();
    expect(a.lastRowCount).toBe(12);
    expect(a.shortCircuitRate).toBeNull();

    const b = summary.providers.find((p) => p.provider === "b")!;
    expect(b.lastError).toBe("HTTP 500");
    expect(b.lastRowCount).toBe(3);
    expect(b.lastSuccessfulPullAt).toBe("2026-08-01T11:00:00.000Z");
  });

  it("includes PollEngine shortCircuit rate and metrics after syncNow", async () => {
    const store = new ListingStore();
    const p = mockProvider("poll_fx", { builtAt: "fp:stable" });
    const engine = new PollEngine({ store, providers: [p] });

    const first = await engine.syncNow();
    expect(first[0]!.shortCircuited).toBe(false);
    const second = await engine.syncNow();
    expect(second[0]!.shortCircuited).toBe(true);

    const summary = traderHealthSummary({ store, poll: engine });
    const row = summary.providers.find((r) => r.provider === "poll_fx")!;
    expect(row.syncs).toBe(2);
    expect(row.shortCircuits).toBe(1);
    expect(row.shortCircuitRate).toBeCloseTo(0.5);
    expect(row.lastRowCount).toBe(1);
    expect(row.lastSuccessfulPullAt).toBeTruthy();
    expect(row.lastError).toBeNull();
    expect(row.pulls).toBeGreaterThanOrEqual(1);
  });

  it("formatHealthHud is multi-line and includes key columns", () => {
    const store = new ListingStore();
    store.markProviderSuccess("fixture", {
      rowCount: 5,
      at: "2026-08-01T19:00:00.000Z",
    });
    store.markProviderError("softfail", "soft-fail HTTP 500 (fixture softfail)");

    const summary = traderHealthSummary({
      store,
      pollStats: {
        fixture: { syncs: 5, shortCircuits: 4 },
        softfail: { syncs: 3, shortCircuits: 0 },
      },
      metrics: {
        fixture: {
          pulls: 5,
          errors: 0,
          latency_ms: 12,
          total_latency_ms: 60,
        },
        softfail: {
          pulls: 3,
          errors: 3,
          latency_ms: 5,
          total_latency_ms: 15,
        },
      },
      at: "2026-08-01T19:05:00.000Z",
    });

    const hud = formatHealthHud(summary);
    expect(hud).toContain("=== Trader Health");
    expect(hud).toContain("fixture");
    expect(hud).toContain("softfail");
    expect(hud).toContain("80.0%");
    expect(hud).toContain("OK");
    expect(hud).toContain("ERR");
    expect(hud).toContain("total active listings");
    expect(hud.split("\n").length).toBeGreaterThanOrEqual(4);
  });

  it("soft-fail peer isolation visible on HUD rows", async () => {
    const store = new ListingStore();
    const ok = mockProvider("ok_fx");
    const bad = mockProvider("bad_fx", { softError: "origin down" });
    const engine = new PollEngine({ store, providers: [ok, bad] });
    await engine.syncNow();

    const summary = traderHealthSummary({ store, poll: engine });
    const okRow = summary.providers.find((r) => r.provider === "ok_fx")!;
    const badRow = summary.providers.find((r) => r.provider === "bad_fx")!;
    expect(okRow.lastError).toBeNull();
    expect(okRow.lastRowCount).toBe(1);
    expect(badRow.lastError).toMatch(/origin down/);
    expect(badRow.lastSuccessfulPullAt).toBeNull();
  });
});
