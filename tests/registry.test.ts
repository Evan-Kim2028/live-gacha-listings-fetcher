import { describe, expect, it } from "vitest";
import {
  getProvider,
  listProviders,
  registerProvider,
  createDefaultProviders,
  createSolanaProviders,
  DEFAULT_NATIVE_PROVIDER_IDS,
  SOLANA_PROVIDER_IDS,
} from "../src/providers/registry.js";
import { MultiSourceRadar } from "../src/aggregate/MultiSourceRadar.js";
import type { ListingsProvider, PullPage } from "../src/providers/types.js";
import type { Listing } from "../src/types.js";

function emptyPage(provider: string): PullPage {
  return {
    listings: [],
    hasMore: false,
    meta: {
      provider,
      builtAt: "2026-01-01T00:00:00.000Z",
      total: 0,
      universe: 0,
      fetchedAt: new Date().toISOString(),
      querySignature: "",
    },
  };
}

function listingStub(provider: string, nativeId: string): Listing {
  return {
    id: `${provider}:cc:${nativeId}`,
    provider,
    platform: "cc",
    nativeId,
    tokenId: null,
    name: `Card ${nativeId}`,
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
  };
}

describe("provider registry modularity", () => {
  it("registers native builtins collectorcrypt, magiceden, fixture", () => {
    const ids = listProviders();
    expect(ids).toContain("collectorcrypt");
    expect(ids).toContain("magiceden");
    expect(ids).toContain("fixture");
    // traded.gg optional reference only
    expect(ids).toContain("tradedgg");
  });

  it("createDefaultProviders is native-only (CC + ME), never traded.gg", () => {
    expect([...DEFAULT_NATIVE_PROVIDER_IDS]).toEqual([
      "collectorcrypt",
      "magiceden",
    ]);
    const providers = createDefaultProviders();
    expect(providers.map((p) => p.id)).toEqual([
      "collectorcrypt",
      "magiceden",
    ]);
    expect(providers.some((p) => p.id === "tradedgg")).toBe(false);
  });

  it("createDefaultProviders({ all: true }) is CC+ME+Courtyard+Beezie+Renaiss+DYLI", () => {
    const providers = createDefaultProviders({ all: true });
    expect(providers.map((p) => p.id)).toEqual([
      "collectorcrypt",
      "magiceden",
      "courtyard",
      "beezie",
      "renaiss",
      "dyli",
    ]);
    expect(providers.some((p) => p.id === "tradedgg")).toBe(false);
  });

  it("createDefaultProviders({ all: true, magiceden: false }) omits ME", () => {
    expect(
      createDefaultProviders({ all: true, magiceden: false }).map((p) => p.id),
    ).toEqual([
      "collectorcrypt",
      "courtyard",
      "beezie",
      "renaiss",
      "dyli",
    ]);
  });

  it("createSolanaProviders default is Solana-native only (CC + ME collector_crypt + Phygitals)", () => {
    expect([...SOLANA_PROVIDER_IDS]).toEqual([
      "collectorcrypt",
      "magiceden",
      "phygitals",
    ]);
    const providers = createSolanaProviders();
    expect(providers.map((p) => p.id)).toEqual([
      "collectorcrypt",
      "magiceden",
      "phygitals",
    ]);
    // Explicit exclusions (Beezie is EVM — not in default Solana set)
    expect(providers.some((p) => p.id === "beezie")).toBe(false);
    expect(providers.some((p) => p.id === "courtyard")).toBe(false);
    expect(providers.some((p) => p.id === "renaiss")).toBe(false);
    expect(providers.some((p) => p.id === "dyli")).toBe(false);
    expect(providers.some((p) => p.id === "tradedgg")).toBe(false);
  });

  it("createSolanaProviders({ includeBeezie: true }) or includeEvm adds Beezie", () => {
    expect(
      createSolanaProviders({ includeBeezie: true }).map((p) => p.id),
    ).toEqual(["collectorcrypt", "magiceden", "beezie", "phygitals"]);
    expect(
      createSolanaProviders({ includeEvm: true }).map((p) => p.id),
    ).toEqual(["collectorcrypt", "magiceden", "beezie", "phygitals"]);
  });

  it("MultiSourceRadar defaults to createDefaultProviders()", () => {
    const radar = new MultiSourceRadar({ filter: { limit: 1 } });
    expect(radar.providers.map((p) => p.id)).toEqual([
      "collectorcrypt",
      "magiceden",
    ]);
  });

  it("syncAll soft-fails per provider (Promise.allSettled)", async () => {
    const okA: ListingsProvider = {
      id: "cc_ok",
      async pull(): Promise<PullPage> {
        return {
          ...emptyPage("cc_ok"),
          listings: [listingStub("cc_ok", "1")],
        };
      },
    };
    const boom: ListingsProvider = {
      id: "phygitals_boom",
      async pull(): Promise<PullPage> {
        throw new Error("HTTP 500 marketplace-listings");
      },
    };
    const okB: ListingsProvider = {
      id: "beezie_ok",
      async pull(): Promise<PullPage> {
        return {
          ...emptyPage("beezie_ok"),
          listings: [listingStub("beezie_ok", "2")],
        };
      },
    };
    const radar = new MultiSourceRadar({
      providers: [okA, boom, okB],
    });
    const r = await radar.syncAll();
    expect(r.results.map((x) => x.provider).sort()).toEqual([
      "beezie_ok",
      "cc_ok",
    ]);
    expect(r.errors.phygitals_boom).toMatch(/HTTP 500/);
    expect(r.byProvider.cc_ok).toBe(1);
    expect(r.byProvider.beezie_ok).toBe(1);
    expect(r.byProvider.phygitals_boom).toBe(0);
    expect(r.totalActive).toBe(2);
  });

  it("allows adding a custom provider without touching sync", async () => {
    const custom: ListingsProvider = {
      id: "custom_src",
      async pull(): Promise<PullPage> {
        return emptyPage("custom_src");
      },
    };
    registerProvider("custom_src", () => custom);
    expect(getProvider("custom_src").id).toBe("custom_src");
    const page = await getProvider("custom_src").pull();
    expect(page.listings).toEqual([]);
  });
});
