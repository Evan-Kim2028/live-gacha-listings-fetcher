import { describe, expect, it } from "vitest";
import { listingId } from "../src/identity.js";
import {
  AlertEngine,
  alertMatches,
  filterAlerts,
  hasOriginUnderFmv,
  underFmvAlertIfAny,
  alertsFromListingDiff,
  softFailAlert,
} from "../src/trader/index.js";
import type { Listing, SyncResult } from "../src/types.js";

function L(
  partial: Partial<Listing> &
    Pick<Listing, "platform" | "nativeId" | "price" | "name">,
): Listing {
  const provider = partial.provider ?? "fixture";
  return {
    id: listingId({
      provider,
      platform: partial.platform,
      nativeId: partial.nativeId,
    }),
    provider,
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
    querySignature: partial.querySignature ?? "tcg=pokemon",
    fetched: listings.length,
    upserted: listings.length,
    unchanged: 0,
    pruned: 0,
    prunedIds: [],
    activeCount: listings.length,
    durationMs: 5,
    listings,
    ...partial,
  };
}

describe("hasOriginUnderFmv / underFmvAlertIfAny", () => {
  it("skips when fmv or delta null — never invents FMV", () => {
    const noFmv = L({
      platform: "cc",
      nativeId: "1",
      name: "A",
      price: 80,
      fmv: null,
      delta: null,
    });
    const noDelta = L({
      platform: "cc",
      nativeId: "2",
      name: "B",
      price: 80,
      fmv: 100,
      delta: null,
    });
    expect(hasOriginUnderFmv(noFmv)).toBe(false);
    expect(hasOriginUnderFmv(noDelta)).toBe(false);
    expect(
      underFmvAlertIfAny(noFmv, { ts: "t", provider: "fixture" }),
    ).toBeNull();
  });

  it("fires only when origin fmv+delta set and delta < 0", () => {
    const under = L({
      platform: "cc",
      nativeId: "3",
      name: "C",
      price: 80,
      fmv: 100,
      delta: -20,
    });
    const over = L({
      platform: "cc",
      nativeId: "4",
      name: "D",
      price: 120,
      fmv: 100,
      delta: 20,
    });
    expect(hasOriginUnderFmv(under)).toBe(true);
    expect(hasOriginUnderFmv(over)).toBe(false);
    const a = underFmvAlertIfAny(under, { ts: "t", provider: "fixture" });
    expect(a).toMatchObject({
      kind: "under_fmv",
      fmv: 100,
      delta: -20,
    });
  });
});

describe("AlertEngine listing diffs", () => {
  it("emits new_listing / reprice / closed", () => {
    const engine = new AlertEngine();
    const a = L({ platform: "cc", nativeId: "a", name: "A", price: 10 });
    const b = L({ platform: "cc", nativeId: "b", name: "B", price: 20 });
    const scope = { provider: "fixture", querySignature: "q" };

    const e1 = engine.onListingsDiff([a, b], scope, "t1");
    expect(e1.map((e) => e.kind)).toEqual(["new_listing", "new_listing"]);

    const a2 = L({ platform: "cc", nativeId: "a", name: "A", price: 9 });
    const e2 = engine.onListingsDiff([a2, b], scope, "t2");
    expect(e2).toHaveLength(1);
    expect(e2[0]).toMatchObject({
      kind: "reprice",
      prevPrice: 10,
      listing: expect.objectContaining({ price: 9 }),
    });

    const e3 = engine.onListingsDiff([b], scope, "t3");
    expect(e3).toHaveLength(1);
    expect(e3[0]).toMatchObject({
      kind: "closed",
      id: a.id,
    });
  });

  it("emits under_fmv with new_listing when origin fmv/delta present", () => {
    const engine = new AlertEngine();
    const deal = L({
      platform: "cc",
      nativeId: "deal",
      name: "Deal",
      price: 80,
      fmv: 100,
      delta: -20,
    });
    const plain = L({
      platform: "cc",
      nativeId: "plain",
      name: "Plain",
      price: 50,
      fmv: null,
      delta: null,
    });
    const events = engine.onListingsDiff(
      [deal, plain],
      { provider: "fixture", querySignature: "q" },
      "t",
    );
    expect(events.map((e) => e.kind)).toEqual([
      "new_listing",
      "under_fmv",
      "new_listing",
    ]);
    const uf = events.find((e) => e.kind === "under_fmv");
    expect(uf).toMatchObject({ fmv: 100, delta: -20, listing: { id: deal.id } });
  });

  it("does not re-emit under_fmv on unchanged re-pull", () => {
    const engine = new AlertEngine();
    const deal = L({
      platform: "cc",
      nativeId: "deal",
      name: "Deal",
      price: 80,
      fmv: 100,
      delta: -20,
    });
    const scope = { provider: "fixture", querySignature: "q" };
    const e1 = engine.onListingsDiff([deal], scope, "t1");
    expect(e1.filter((e) => e.kind === "under_fmv")).toHaveLength(1);
    const e2 = engine.onListingsDiff([deal], scope, "t2");
    expect(e2).toEqual([]);
  });

  it("emits under_fmv on reprice that stays under FMV", () => {
    const engine = new AlertEngine();
    const scope = { provider: "fixture", querySignature: "q" };
    const v1 = L({
      platform: "cc",
      nativeId: "x",
      name: "X",
      price: 90,
      fmv: 100,
      delta: -10,
    });
    engine.onListingsDiff([v1], scope, "t1");
    const v2 = L({
      platform: "cc",
      nativeId: "x",
      name: "X",
      price: 70,
      fmv: 100,
      delta: -30,
    });
    const e2 = engine.onListingsDiff([v2], scope, "t2");
    expect(e2.map((e) => e.kind)).toEqual(["reprice", "under_fmv"]);
    expect(e2[1]).toMatchObject({ kind: "under_fmv", delta: -30 });
  });
});

describe("AlertEngine onSyncResult", () => {
  it("short-circuit yields no alerts", () => {
    const engine = new AlertEngine();
    const r = syncResult(
      [L({ platform: "cc", nativeId: "1", name: "A", price: 1 })],
      { shortCircuited: true, upserted: 0 },
    );
    expect(engine.onSyncResult(r)).toEqual([]);
  });

  it("non-short-circuit diffs listings", () => {
    const engine = new AlertEngine();
    const a = L({
      platform: "cc",
      nativeId: "1",
      name: "A",
      price: 80,
      fmv: 100,
      delta: -20,
    });
    const events = engine.onSyncResult(syncResult([a]));
    expect(events.map((e) => e.kind)).toEqual(["new_listing", "under_fmv"]);
  });

  it("soft_fail path emits soft_fail and skips listing diff", () => {
    const engine = new AlertEngine();
    const a = L({ platform: "cc", nativeId: "1", name: "A", price: 10 });
    const events = engine.onSyncResult(syncResult([a]), {
      softFail: true,
      lastError: "HTTP 500",
      watermark: {
        provider: "fixture",
        lastSuccessfulPullAt: "2026-08-01T00:00:00.000Z",
        lastBuiltAt: null,
        lastRowCount: 3,
        lastError: "HTTP 500",
      },
      ts: "t-sf",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "soft_fail",
      error: "HTTP 500",
      lastRowCount: 3,
      ts: "t-sf",
    });
    // soft_fail must not seed known map
    expect(engine.size()).toBe(0);
  });
});

describe("alertMatches + maxDelta filter", () => {
  it("wires listingMatchesFilter maxDelta / requireFmv / tcg", () => {
    const under = L({
      platform: "cc",
      nativeId: "u",
      name: "U",
      price: 80,
      fmv: 100,
      delta: -20,
      tcg: "pokemon",
    });
    const mild = L({
      platform: "cc",
      nativeId: "m",
      name: "M",
      price: 95,
      fmv: 100,
      delta: -5,
      tcg: "pokemon",
    });
    const noFmv = L({
      platform: "cc",
      nativeId: "n",
      name: "N",
      price: 50,
      fmv: null,
      delta: null,
      tcg: "pokemon",
    });
    const op = L({
      platform: "cc",
      nativeId: "o",
      name: "O",
      price: 80,
      fmv: 100,
      delta: -20,
      tcg: "one_piece",
    });

    const aUnder = {
      ts: "t",
      kind: "under_fmv" as const,
      provider: "fixture",
      listing: under,
      fmv: 100,
      delta: -20,
    };
    const aMild = {
      ts: "t",
      kind: "new_listing" as const,
      provider: "fixture",
      listing: mild,
    };
    const aNoFmv = {
      ts: "t",
      kind: "new_listing" as const,
      provider: "fixture",
      listing: noFmv,
    };
    const aOp = {
      ts: "t",
      kind: "new_listing" as const,
      provider: "fixture",
      listing: op,
    };
    const aSoft = softFailAlert({
      provider: "phygitals",
      error: "500",
    });

    expect(alertMatches(aUnder, { maxDelta: -15 })).toBe(true);
    expect(alertMatches(aMild, { maxDelta: -15 })).toBe(false);
    expect(alertMatches(aNoFmv, { maxDelta: -15 })).toBe(false);
    expect(alertMatches(aNoFmv, { requireFmv: true })).toBe(false);
    expect(alertMatches(aUnder, { tcg: "pokemon" })).toBe(true);
    expect(alertMatches(aOp, { tcg: "pokemon" })).toBe(false);
    // soft_fail always matches
    expect(alertMatches(aSoft, { maxDelta: -50, tcg: "pokemon" })).toBe(true);

    const filtered = filterAlerts(
      [aUnder, aMild, aNoFmv, aOp, aSoft],
      { maxDelta: -15, tcg: "pokemon" },
    );
    expect(filtered.map((e) => e.kind)).toEqual(["under_fmv", "soft_fail"]);
  });
});

describe("alertsFromListingDiff", () => {
  it("stateless two-page diff", () => {
    const prev = [
      L({ platform: "cc", nativeId: "1", name: "A", price: 10 }),
      L({ platform: "cc", nativeId: "2", name: "B", price: 20 }),
    ];
    const next = [
      L({ platform: "cc", nativeId: "1", name: "A", price: 8 }),
      L({
        platform: "cc",
        nativeId: "3",
        name: "C",
        price: 50,
        fmv: 80,
        delta: -38,
      }),
    ];
    const events = alertsFromListingDiff(prev, next, {
      provider: "fixture",
      querySignature: "q",
    });
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("reprice");
    expect(kinds).toContain("new_listing");
    expect(kinds).toContain("closed");
    expect(kinds).toContain("under_fmv");
  });
});
