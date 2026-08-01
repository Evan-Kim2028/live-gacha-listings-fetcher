import { describe, expect, it } from "vitest";
import { MultiSourceRadar } from "../src/aggregate/MultiSourceRadar.js";
import { listingId } from "../src/identity.js";
import {
  applyFmvPlugins,
  FixtureFmvProvider,
  deltaFromPriceAndFmv,
  type FmvProvider,
} from "../src/fmv/index.js";
import type { Listing } from "../src/types.js";
import type { ListingsProvider, PullPage } from "../src/providers/types.js";

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

describe("deltaFromPriceAndFmv", () => {
  it("matches origin % formula", () => {
    expect(deltaFromPriceAndFmv(80, 100)).toBe(-20);
    expect(deltaFromPriceAndFmv(120, 100)).toBe(20);
    expect(deltaFromPriceAndFmv(100, 0)).toBeNull();
    expect(deltaFromPriceAndFmv(100, null)).toBeNull();
  });
});

describe("applyFmvPlugins", () => {
  it("preserves origin fmv (origin wins)", async () => {
    const origin = L({
      platform: "cc",
      nativeId: "a",
      name: "A",
      price: 90,
      fmv: 100,
      delta: -10,
    });
    const plugin = new FixtureFmvProvider({ [origin.id]: 999 });
    const [out] = await applyFmvPlugins([origin], [plugin]);
    expect(out).toEqual(origin);
    expect(out!.fmv).toBe(100);
    expect(out!.delta).toBe(-10);
  });

  it("enriches null fmv and recomputes delta from price", async () => {
    const row = L({
      platform: "cc",
      nativeId: "b",
      name: "B",
      price: 80,
      fmv: null,
      delta: null,
    });
    const plugin = new FixtureFmvProvider({ [row.id]: 100 });
    const [out] = await applyFmvPlugins([row], [plugin]);
    expect(out!.fmv).toBe(100);
    expect(out!.delta).toBe(-20);
    expect(out!.price).toBe(80);
  });

  it("soft-skips plugin errors and continues", async () => {
    const row = L({
      platform: "me",
      nativeId: "c",
      name: "C",
      price: 50,
      fmv: null,
    });
    const boom: FmvProvider = {
      id: "boom",
      enrich() {
        throw new Error("oracle down");
      },
    };
    const ok = new FixtureFmvProvider({ [row.id]: 100 });
    const [out] = await applyFmvPlugins([row], [boom, ok]);
    expect(out!.fmv).toBe(100);
    expect(out!.delta).toBe(-50);
  });

  it("leaves null when all plugins fail or miss", async () => {
    const row = L({
      platform: "me",
      nativeId: "d",
      name: "D",
      price: 10,
      fmv: null,
    });
    const boom: FmvProvider = {
      id: "boom",
      async enrich() {
        throw new Error("fail");
      },
    };
    const miss = new FixtureFmvProvider({});
    const [out] = await applyFmvPlugins([row], [boom, miss]);
    expect(out!.fmv).toBeNull();
    expect(out!.delta).toBeNull();
  });

  it("does not invent FMV with empty plugin list", async () => {
    const row = L({
      platform: "cc",
      nativeId: "e",
      name: "E",
      price: 1,
      fmv: null,
    });
    const [out] = await applyFmvPlugins([row], []);
    expect(out!.fmv).toBeNull();
  });
});

function stubProvider(listings: Listing[]): ListingsProvider {
  return {
    id: "fixture",
    async pull(): Promise<PullPage> {
      return {
        listings,
        hasMore: false,
        meta: {
          provider: "fixture",
          builtAt: "2026-01-01T00:00:00.000Z",
          total: listings.length,
          universe: listings.length,
          fetchedAt: new Date().toISOString(),
          querySignature: "",
        },
      };
    },
  };
}

describe("MultiSourceRadar fmvPlugins wire", () => {
  it("defaults to empty plugins (zero behavior change)", async () => {
    const row = L({
      platform: "cc",
      nativeId: "radar-empty",
      name: "Empty",
      price: 10,
      fmv: null,
      provider: "fixture",
    });
    const radar = new MultiSourceRadar({
      providers: [stubProvider([row])],
    });
    expect(radar.fmvPlugins).toEqual([]);
    await radar.syncAll();
    const listed = radar.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.fmv).toBeNull();
  });

  it("applies fmvPlugins after syncAll (store write-back)", async () => {
    const row = L({
      platform: "cc",
      nativeId: "radar-sync",
      name: "Sync",
      price: 80,
      fmv: null,
      provider: "fixture",
    });
    const plugin = new FixtureFmvProvider({ [row.id]: 100 });
    const radar = new MultiSourceRadar({
      providers: [stubProvider([row])],
      fmvPlugins: [plugin],
    });
    await radar.syncAll();
    const listed = radar.list();
    expect(listed[0]!.fmv).toBe(100);
    expect(listed[0]!.delta).toBe(-20);
    expect(radar.store.get(row.id)?.fmv).toBe(100);
  });

  it("list({ enrichFmv: true }) applies plugins on demand (read-time)", async () => {
    const row = L({
      platform: "me",
      nativeId: "radar-list",
      name: "List",
      price: 50,
      fmv: null,
      provider: "fixture",
    });
    // Sync without plugins so store keeps null fmv
    const bare = new MultiSourceRadar({
      providers: [stubProvider([row])],
    });
    await bare.syncAll();
    expect(bare.list()[0]!.fmv).toBeNull();

    // Same store + fmvPlugins; list enrich only (no second sync write-back)
    const withPlugins = new MultiSourceRadar({
      store: bare.store,
      providers: [],
      fmvPlugins: [new FixtureFmvProvider({ [row.id]: 100 })],
    });
    const enriched = await withPlugins.list({ enrichFmv: true });
    expect(enriched[0]!.fmv).toBe(100);
    expect(enriched[0]!.delta).toBe(-50);
    // Store unchanged on read-time enrich
    expect(bare.store.get(row.id)?.fmv).toBeNull();
  });

  it("preserves origin fmv after sync with plugins", async () => {
    const row = L({
      platform: "cc",
      nativeId: "radar-origin",
      name: "Origin",
      price: 90,
      fmv: 100,
      delta: -10,
      provider: "fixture",
    });
    const plugin = new FixtureFmvProvider({ [row.id]: 999 });
    const radar = new MultiSourceRadar({
      providers: [stubProvider([row])],
      fmvPlugins: [plugin],
    });
    await radar.syncAll();
    const listed = radar.list();
    expect(listed[0]!.fmv).toBe(100);
    expect(listed[0]!.delta).toBe(-10);
  });

  it("does not import or require traded.gg for FMV", () => {
    // Structural: MultiSourceRadar + FixtureFmvProvider only — no traded.gg
    const radar = new MultiSourceRadar({
      providers: [],
      fmvPlugins: [new FixtureFmvProvider({})],
    });
    expect(radar.fmvPlugins[0]!.id).toBe("fixture_fmv");
  });
});
