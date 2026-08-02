import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listingId } from "../src/identity.js";
import { ListingStore } from "../src/store.js";
import { syncOnce } from "../src/sync.js";
import { createTradedGgProvider } from "../src/providers/tradedgg.js";
import { createFixtureProvider } from "../src/providers/fixture.js";
import type { ListingsProvider, PullPage, PullQuery } from "../src/providers/types.js";
import type { Listing } from "../src/types.js";

const fixturePath = join(__dirname, "..", "fixtures", "radar-sample.json");

function makeListing(
  platform: string,
  nativeId: string,
  price: number,
  provider = "mem",
): Listing {
  return {
    id: listingId({ provider, platform, nativeId }),
    provider,
    platform,
    nativeId,
    tokenId: null,
    name: `${platform}-${nativeId}`,
    price,
    currency: "USDC",
    fmv: null,
    delta: null,
    market: null,
    seller: null,
    externalUrl: null,
    imageUrl: null,
    listedAt: "2026-08-01T00:00:00+00:00",
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

/** In-memory provider with controllable pages (drives real syncOnce). */
class ScriptedProvider implements ListingsProvider {
  readonly id = "mem";
  private pages: { builtAt: string; listings: Listing[] }[] = [];
  private i = 0;

  queue(builtAt: string, listings: Listing[]): void {
    this.pages.push({ builtAt, listings });
  }

  async pull(_query?: PullQuery): Promise<PullPage> {
    const page = this.pages[Math.min(this.i, this.pages.length - 1)]!;
    this.i += 1;
    return {
      listings: page.listings,
      hasMore: false,
      meta: {
        provider: this.id,
        builtAt: page.builtAt,
        total: page.listings.length,
        universe: page.listings.length,
        fetchedAt: new Date().toISOString(),
        querySignature: "",
      },
    };
  }
}

/** Provider that filters by query.platform; same builtAt across filters. */
class PlatformFilterProvider implements ListingsProvider {
  readonly id = "filt";
  constructor(
    private readonly builtAt: string,
    private readonly byPlatform: Record<string, Listing[]>,
  ) {}

  async pull(query: PullQuery = {}): Promise<PullPage> {
    const platform = query.platform ?? "all";
    const listings =
      platform === "all"
        ? Object.values(this.byPlatform).flat()
        : (this.byPlatform[platform] ?? []);
    return {
      listings,
      hasMore: false,
      meta: {
        provider: this.id,
        builtAt: this.builtAt,
        total: listings.length,
        universe: listings.length,
        fetchedAt: new Date().toISOString(),
        querySignature: "",
      },
    };
  }
}

describe("idempotent upsert + double-sync", () => {
  it("double-sync of same radar fixture does not grow row count", async () => {
    const store = new ListingStore();
    const provider = createTradedGgProvider();

    const first = await syncOnce(store, provider, {
      fixturePath,
      shortCircuitOnBuiltAt: false,
    });
    expect(first.fetched).toBeGreaterThan(0);
    expect(first.activeCount).toBe(first.fetched);
    const keys1 = new Set(store.list().map((l) => l.id));

    const second = await syncOnce(store, provider, {
      fixturePath,
      shortCircuitOnBuiltAt: false,
    });
    const keys2 = new Set(store.list().map((l) => l.id));

    expect(second.activeCount).toBe(first.activeCount);
    expect(keys2.size).toBe(keys1.size);
    for (const k of keys1) expect(keys2.has(k)).toBe(true);
    expect(second.upserted).toBe(0);
    expect(second.unchanged).toBe(first.activeCount);
    expect(second.pruned).toBe(0);
  });

  it("builtAt short-circuit skips re-apply when query+ids unchanged", async () => {
    const store = new ListingStore();
    const provider = createTradedGgProvider();
    await syncOnce(store, provider, {
      fixturePath,
      shortCircuitOnBuiltAt: false,
    });
    const r = await syncOnce(store, provider, {
      fixturePath,
      shortCircuitOnBuiltAt: true,
    });
    expect(r.shortCircuited).toBe(true);
    expect(r.upserted).toBe(0);
    expect(r.pruned).toBe(0);
  });

  it("resync with removed+added rows prunes missing actives", async () => {
    const store = new ListingStore();
    const provider = new ScriptedProvider();
    const a = makeListing("courtyard", "a", 10);
    const b = makeListing("courtyard", "b", 20);
    const c = makeListing("courtyard", "c", 30);
    provider.queue("2026-08-01T10:00:00.000Z", [a, b]);
    provider.queue("2026-08-01T10:01:00.000Z", [b, c]);

    const r1 = await syncOnce(store, provider, { shortCircuitOnBuiltAt: false });
    expect(r1.activeCount).toBe(2);
    expect(store.get(a.id)).toBeTruthy();
    expect(store.get(b.id)).toBeTruthy();

    const r2 = await syncOnce(store, provider, { shortCircuitOnBuiltAt: false });
    expect(r2.pruned).toBe(1);
    expect(r2.activeCount).toBe(2);
    expect(store.get(a.id)).toBeUndefined();
    expect(store.get(b.id)?.price).toBe(20);
    expect(store.get(c.id)?.price).toBe(30);
    expect(store.size()).toBe(2);
  });

  it("same builtAt with different page content still applies (no silent stale short-circuit)", async () => {
    const store = new ListingStore();
    const provider = new ScriptedProvider();
    const a = makeListing("courtyard", "a", 10);
    const b = makeListing("courtyard", "b", 20);
    const c = makeListing("courtyard", "c", 30);
    // Same builtAt, different rows — must not short-circuit discard
    provider.queue("T1", [a, b]);
    provider.queue("T1", [b, c]);

    await syncOnce(store, provider, { shortCircuitOnBuiltAt: true });
    const r2 = await syncOnce(store, provider, { shortCircuitOnBuiltAt: true });
    expect(r2.shortCircuited).toBe(false);
    expect(store.get(a.id)).toBeUndefined();
    expect(store.get(c.id)).toBeTruthy();
    expect(store.size()).toBe(2);
  });

  it("same rows different builtAt short-circuits (content equality)", async () => {
    const store = new ListingStore();
    const provider = new ScriptedProvider();
    const a = makeListing("courtyard", "a", 10);
    const b = makeListing("courtyard", "b", 20);
    // Fetch-time builtAt differs; inventory unchanged
    provider.queue("2026-08-01T10:00:00.000Z", [a, b]);
    provider.queue("2026-08-01T10:00:30.000Z", [a, b]);

    const r1 = await syncOnce(store, provider, { shortCircuitOnBuiltAt: true });
    expect(r1.shortCircuited).toBe(false);
    expect(r1.activeCount).toBe(2);

    const r2 = await syncOnce(store, provider, { shortCircuitOnBuiltAt: true });
    expect(r2.shortCircuited).toBe(true);
    expect(r2.upserted).toBe(0);
    expect(r2.pruned).toBe(0);
    expect(r2.unchanged).toBe(2);
    expect(store.get(a.id)?.price).toBe(10);
    expect(store.get(b.id)?.price).toBe(20);
  });

  it("same ids price change does not short-circuit", async () => {
    const store = new ListingStore();
    const provider = new ScriptedProvider();
    const a1 = makeListing("courtyard", "a", 10);
    const b = makeListing("courtyard", "b", 20);
    const a2 = makeListing("courtyard", "a", 15); // price change
    provider.queue("T1", [a1, b]);
    provider.queue("T2", [a2, b]);

    await syncOnce(store, provider, { shortCircuitOnBuiltAt: true });
    const r2 = await syncOnce(store, provider, { shortCircuitOnBuiltAt: true });
    expect(r2.shortCircuited).toBe(false);
    expect(r2.upserted).toBe(1);
    expect(store.get(a1.id)?.price).toBe(15);
    expect(store.size()).toBe(2);
  });

  it("warm second pull identical payload short-circuits and skips replaceScopeSnapshot", async () => {
    const store = new ListingStore();
    const replaceSpy = vi.spyOn(store, "replaceScopeSnapshot");
    const a = makeListing("courtyard", "a", 10);
    const b = makeListing("courtyard", "b", 20);
    const provider: ListingsProvider = {
      id: "mem",
      async pull(): Promise<PullPage> {
        return {
          listings: [a, b],
          hasMore: false,
          meta: {
            provider: "mem",
            builtAt: "fp:warm-stable",
            total: 2,
            universe: 2,
            fetchedAt: new Date().toISOString(),
            querySignature: "",
            contentFingerprint: "fp:warm-stable",
          },
        };
      },
    };

    const cold = await syncOnce(store, provider, { shortCircuitOnBuiltAt: false });
    expect(cold.shortCircuited).toBe(false);
    expect(cold.upserted).toBe(2);
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    const coldMs = cold.durationMs;

    const warm = await syncOnce(store, provider, { shortCircuitOnBuiltAt: false });
    expect(warm.shortCircuited).toBe(true);
    expect(warm.upserted).toBe(0);
    expect(warm.pruned).toBe(0);
    expect(warm.unchanged).toBe(2);
    expect(warm.fetched).toBe(2);
    // Generation short-circuit (B): no second rewrite
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(typeof warm.durationMs).toBe("number");
    expect(warm.durationMs).toBeGreaterThanOrEqual(0);
    // Warm path must not be pathologically slower than cold (both local/scripted)
    expect(warm.durationMs).toBeLessThanOrEqual(coldMs + 50);
    expect(store.size("mem")).toBe(2);
  });

  it("matching contentFingerprint short-circuits without listingsEqual walk dependency", async () => {
    const store = new ListingStore();
    const a = makeListing("courtyard", "a", 10);
    let n = 0;
    const provider: ListingsProvider = {
      id: "mem",
      async pull(): Promise<PullPage> {
        n += 1;
        return {
          listings: [a],
          hasMore: false,
          meta: {
            provider: "mem",
            builtAt: `fetch-${n}`,
            total: 1,
            universe: 1,
            fetchedAt: new Date().toISOString(),
            querySignature: "",
            contentFingerprint: "fp-stable",
          },
        };
      },
    };
    const r1 = await syncOnce(store, provider, { shortCircuitOnBuiltAt: false });
    expect(r1.shortCircuited).toBe(false);
    const r2 = await syncOnce(store, provider, { shortCircuitOnBuiltAt: false });
    expect(r2.shortCircuited).toBe(true);
    expect(store.getMeta("mem")?.contentFingerprint).toBe("fp-stable");
  });

  it("different PullQuery with same builtAt does not short-circuit", async () => {
    const cy = makeListing("courtyard", "cy1", 11, "filt");
    const cc = makeListing("cc", "cc1", 22, "filt");
    const provider = new PlatformFilterProvider("T-SAME", {
      courtyard: [cy],
      cc: [cc],
    });
    const store = new ListingStore();

    const r1 = await syncOnce(store, provider, {
      platform: "courtyard",
      shortCircuitOnBuiltAt: true,
    });
    expect(r1.shortCircuited).toBe(false);
    expect(r1.activeCount).toBe(1);
    expect(store.get(cy.id)).toBeTruthy();

    const r2 = await syncOnce(store, provider, {
      platform: "cc",
      shortCircuitOnBuiltAt: true,
    });
    expect(r2.shortCircuited).toBe(false);
    expect(r2.querySignature).toContain("platform=cc");
    expect(store.get(cc.id)?.price).toBe(22);
    // courtyard scope retained; global store has both
    expect(store.get(cy.id)).toBeTruthy();
    expect(store.size()).toBe(2);
  });

  it("fixture provider + tradedgg keys coexist without collision", async () => {
    const store = new ListingStore();
    const traded = createTradedGgProvider();
    await syncOnce(store, traded, {
      fixturePath,
      shortCircuitOnBuiltAt: false,
    });
    const n1 = store.size();

    const altPath = join(__dirname, "alt-source.json");
    writeFileSync(
      altPath,
      JSON.stringify([
        {
          platform: "manual",
          nativeId: "deal-1",
          name: "Alt source deal",
          price: 9.99,
          currency: "USD",
        },
      ]),
    );
    const alt = createFixtureProvider({
      path: altPath,
      providerId: "altmarket",
    });
    await syncOnce(store, alt, { shortCircuitOnBuiltAt: false });
    expect(store.size()).toBe(n1 + 1);
    expect(store.get("altmarket:manual:deal-1")?.price).toBe(9.99);

    await syncOnce(store, alt, { shortCircuitOnBuiltAt: false });
    expect(store.size()).toBe(n1 + 1);
  });

  it("fixture file is real radar shape with multi-platform rows", () => {
    const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      rows: { platform: string; instance_id: string; price: number }[];
    };
    const platforms = new Set(raw.rows.map((r) => r.platform));
    expect(platforms.has("courtyard")).toBe(true);
    expect(platforms.has("cc")).toBe(true);
    expect(raw.rows.every((r) => r.instance_id && r.price > 0)).toBe(true);
  });
});

describe("mass-prune guard (partial warm walk)", () => {
  it("syncOnce does not wipe large scope when page is <50% and hasMore false", async () => {
    
    const store = new ListingStore();
    const rows = Array.from({ length: 300 }, (_, i) => {
      const nativeId = `n${i}`;
      return {
        id: listingId({ provider: "fixture", platform: "cc", nativeId }),
        provider: "fixture",
        platform: "cc",
        nativeId,
        tokenId: null,
        name: `Card ${i}`,
        price: 10 + i,
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
    });
    // seed large scope
    const pFull: ListingsProvider = {
      id: "fixture",
      async pull() {
        return {
          listings: rows,
          hasMore: false,
          meta: {
            provider: "fixture",
            builtAt: "b1",
            total: rows.length,
            universe: null,
            fetchedAt: new Date().toISOString(),
            querySignature: "",
          },
        };
      },
    };
    await syncOnce(store, pFull, { tcg: "pokemon", sort: "new" });
    expect(store.size("fixture")).toBe(300);

    // partial page claiming complete (hasMore false) — must not mass-prune
    const partial = rows.slice(0, 50);
    const pPartial: ListingsProvider = {
      id: "fixture",
      async pull() {
        return {
          listings: partial,
          hasMore: false,
          meta: {
            provider: "fixture",
            builtAt: "b2",
            total: 50,
            universe: null,
            fetchedAt: new Date().toISOString(),
            querySignature: "",
          },
        };
      },
    };
    const r = await syncOnce(store, pPartial, { tcg: "pokemon", sort: "new" });
    expect(r.pruned).toBe(0);
    expect(store.size("fixture")).toBe(300);
  });

  it("syncOnce does not mass-prune when >10% of large scope missing despite full-looking page", async () => {
    const store = new ListingStore();
    const rows = Array.from({ length: 500 }, (_, i) => {
      const nativeId = `m${i}`;
      return {
        id: listingId({ provider: "fixture", platform: "cc", nativeId }),
        provider: "fixture",
        platform: "cc",
        nativeId,
        tokenId: null,
        name: `Card ${i}`,
        price: 10 + i,
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
    });
    const pFull: ListingsProvider = {
      id: "fixture",
      async pull() {
        return {
          listings: rows,
          hasMore: false,
          meta: {
            provider: "fixture",
            builtAt: "b1",
            total: rows.length,
            universe: null,
            fetchedAt: new Date().toISOString(),
            querySignature: "",
          },
        };
      },
    };
    await syncOnce(store, pFull, { tcg: "pokemon", sort: "new" });
    expect(store.size("fixture")).toBe(500);

    // Keep 88% of prior ids + pad with dups so raw length looks full;
    // unique set passes the <50% size guard, but missing ratio is 12% →
    // mass-drop guard must block prune (live Phygitals thrash pattern).
    const kept = rows.slice(0, 440);
    const padded = [...kept, ...kept.slice(0, 200)]; // length 640 > 50% of 500
    const pThrash: ListingsProvider = {
      id: "fixture",
      async pull() {
        return {
          listings: padded,
          hasMore: false,
          meta: {
            provider: "fixture",
            builtAt: "b2",
            total: padded.length,
            universe: null,
            fetchedAt: new Date().toISOString(),
            querySignature: "",
          },
        };
      },
    };
    const r = await syncOnce(store, pThrash, { tcg: "pokemon", sort: "new" });
    expect(r.pruned).toBe(0);
    expect(store.size("fixture")).toBe(500);
  });

  it("syncOnce does not mass-prune when >200 absences on large scope", async () => {
    const store = new ListingStore();
    const rows = Array.from({ length: 1000 }, (_, i) => {
      const nativeId = `a${i}`;
      return {
        id: listingId({ provider: "fixture", platform: "cc", nativeId }),
        provider: "fixture",
        platform: "cc",
        nativeId,
        tokenId: null,
        name: `Card ${i}`,
        price: 10 + i,
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
    });
    const pFull: ListingsProvider = {
      id: "fixture",
      async pull() {
        return {
          listings: rows,
          hasMore: false,
          meta: {
            provider: "fixture",
            builtAt: "b1",
            total: rows.length,
            universe: null,
            fetchedAt: new Date().toISOString(),
            querySignature: "",
          },
        };
      },
    };
    await syncOnce(store, pFull, { tcg: "pokemon", sort: "new" });
    // drop 250 ids (25%) — ratio guard also hits; keep unique large
    const kept = rows.slice(0, 750);
    const pAbs: ListingsProvider = {
      id: "fixture",
      async pull() {
        return {
          listings: kept,
          hasMore: false,
          meta: {
            provider: "fixture",
            builtAt: "b2",
            total: kept.length,
            universe: null,
            fetchedAt: new Date().toISOString(),
            querySignature: "",
          },
        };
      },
    };
    // 250 missing is >200 abs and >10% — no prune
    const r = await syncOnce(store, pAbs, { tcg: "pokemon", sort: "new" });
    expect(r.pruned).toBe(0);
    expect(store.size("fixture")).toBe(1000);
  });

  it("syncOnce still prunes small real churn under 10% missing", async () => {
    const store = new ListingStore();
    const rows = Array.from({ length: 500 }, (_, i) => {
      const nativeId = `s${i}`;
      return {
        id: listingId({ provider: "fixture", platform: "cc", nativeId }),
        provider: "fixture",
        platform: "cc",
        nativeId,
        tokenId: null,
        name: `Card ${i}`,
        price: 10 + i,
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
    });
    const pFull: ListingsProvider = {
      id: "fixture",
      async pull() {
        return {
          listings: rows,
          hasMore: false,
          meta: {
            provider: "fixture",
            builtAt: "b1",
            total: rows.length,
            universe: null,
            fetchedAt: new Date().toISOString(),
            querySignature: "",
          },
        };
      },
    };
    await syncOnce(store, pFull, { tcg: "pokemon", sort: "new" });
    // drop 5% (25 ids) — should prune
    const kept = rows.slice(0, 475);
    const pSmall: ListingsProvider = {
      id: "fixture",
      async pull() {
        return {
          listings: kept,
          hasMore: false,
          meta: {
            provider: "fixture",
            builtAt: "b2",
            total: kept.length,
            universe: null,
            fetchedAt: new Date().toISOString(),
            querySignature: "",
          },
        };
      },
    };
    const r = await syncOnce(store, pSmall, { tcg: "pokemon", sort: "new" });
    expect(r.pruned).toBe(25);
    expect(store.size("fixture")).toBe(475);
  });
});
