import { describe, expect, it } from "vitest";
import {
  MagicEdenProvider,
  MagicEdenBidsProvider,
  createMagicEdenBidsProvider,
  createMagicEdenProvider,
  mePriceToSol,
  solToUsd,
  normalizeMeListing,
  clearSolPriceCache,
} from "../src/providers/magiceden.js";
import { meListingUrl } from "../src/externalUrl.js";
import { applyDelistsFromSync } from "../src/lifecycle/index.js";
import { listingToAsk, OrderbookStore } from "../src/orderbook/index.js";
import { OrderbookFeed } from "../src/orderbook/OrderbookFeed.js";
import { ListingStore } from "../src/store.js";
import { syncOnce } from "../src/sync.js";
import { listingId } from "../src/identity.js";
import type { Listing } from "../src/types.js";

/** Live network tests: set LIVE=1 or RUN_LIVE=1 */
const runLive = Boolean(process.env.LIVE || process.env.RUN_LIVE);

describe("mePriceToSol / normalize", () => {
  it("prefers priceInfo lamports over float price", () => {
    expect(
      mePriceToSol(1.5, {
        solPrice: { rawAmount: "1500000000", decimals: 9 },
      }),
    ).toBe(1.5);
    expect(mePriceToSol(0.081249)).toBeCloseTo(0.081249);
    expect(solToUsd(1, 150)).toBe(150);
  });

  it("normalizeMeListing maps mint + SOL price to USD listing", () => {
    const n = normalizeMeListing(
      {
        tokenMint: "Mint111",
        price: 2,
        seller: "Seller1",
        pdaAddress: "Pda1",
        token: {
          name: "Test Card",
          attributes: [
            { trait_type: "Category", value: "Pokemon" },
            { trait_type: "Type", value: "Card" },
          ],
        },
      },
      { solPriceUsd: 100 },
    );
    expect(n).not.toBeNull();
    expect(n!.tokenId).toBe("Mint111");
    expect(n!.price).toBe(200);
    expect(n!.platform).toBe("me");
    expect(n!.tcg).toBe("pokemon");
    // mint-based magiceden.io item page (deep-link only; no buy builders)
    expect(n!.externalUrl).toBe(meListingUrl("Mint111"));
    expect(n!.externalUrl).toBe("https://magiceden.io/item-details/Mint111");
  });

  it("normalizeMeListing externalUrl: origin http(s) preferred; else mint page", () => {
    const withOrigin = normalizeMeListing(
      {
        tokenMint: "MintOrigin",
        price: 1,
        token: {
          name: "Card",
          externalUrl: "https://collectorcrypt.com/assets/solana/MintOrigin",
        },
      },
      { solPriceUsd: 100 },
    );
    expect(withOrigin!.externalUrl).toBe(
      "https://collectorcrypt.com/assets/solana/MintOrigin",
    );

    const fallback = normalizeMeListing(
      {
        tokenMint: "MintFallback",
        price: 1,
        token: { name: "Card", externalUrl: "not-a-url" },
      },
      { solPriceUsd: 100 },
    );
    expect(fallback!.externalUrl).toBe(
      "https://magiceden.io/item-details/MintFallback",
    );
  });
});

describe("MagicEdenProvider soft empty + live SOL", () => {
  it("soft-empties on HTTP error (collector_crypt path)", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503 });
    const p = createMagicEdenProvider({
      fetchImpl,
      offlineSolPrice: true,
      solPriceUsd: 100,
    });
    const page = await p.pull({ limit: 5 });
    expect(page.listings).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(p.lastError).toMatch(/HTTP 503/);
    expect(p.lastMints).toEqual([]);
  });

  it("soft-empties on network throw", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("ECONNRESET");
    };
    const p = new MagicEdenProvider({
      fetchImpl,
      offlineSolPrice: true,
    });
    const page = await p.pull({ limit: 5 });
    expect(page.listings).toEqual([]);
    expect(p.lastError).toMatch(/ECONNRESET/);
  });

  it("uses live SOL when solPriceUsd omitted", async () => {
    clearSolPriceCache();
    const called: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      called.push(url);
      if (url.includes("coingecko")) {
        return new Response(JSON.stringify({ solana: { usd: 80 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/collections/collector_crypt/listings")) {
        return new Response(
          JSON.stringify([
            { tokenMint: "MintLive", price: 1, pdaAddress: "pda1" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    };
    const p = createMagicEdenProvider({ fetchImpl });
    const page = await p.pull({ limit: 5 });
    expect(page.listings).toHaveLength(1);
    expect(page.listings[0]!.price).toBe(80); // 1 SOL * $80
    expect(page.listings[0]!.externalUrl).toBe(
      "https://magiceden.io/item-details/MintLive",
    );
    expect(p.lastSolPriceUsd).toBe(80);
    expect(called.some((u) => u.includes("coingecko"))).toBe(true);
    expect(
      called.some((u) => u.includes("/collections/collector_crypt/listings")),
    ).toBe(true);
  });

  it("sets contentFingerprint; ETag + 304 notModified; syncOnce fingerprint short-circuit", async () => {
    let calls = 0;
    let lastIfNone: string | null = null;
    const listingBody = JSON.stringify([
      { tokenMint: "MintFp", price: 1, pdaAddress: "pda-fp" },
    ]);
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      lastIfNone = new Headers(init?.headers).get("If-None-Match");
      if (calls === 1) {
        return new Response(listingBody, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ETag: '"me-v1"',
          },
        });
      }
      return new Response(null, {
        status: 304,
        headers: { ETag: '"me-v1"' },
      });
    };
    const p = createMagicEdenProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      offlineSolPrice: true,
      solPriceUsd: 100,
      maxRetries: 0,
    });
    const p1 = await p.pull({ limit: 5 });
    expect(p1.notModified).toBeFalsy();
    expect(p1.listings).toHaveLength(1);
    expect(p1.meta.etag).toBe('"me-v1"');
    expect(p1.meta.contentFingerprint).toMatch(/^fp:/);
    expect(p1.meta.builtAt).toBe(p1.meta.contentFingerprint);
    expect(p.lastEtag).toBe('"me-v1"');

    const p2 = await p.pull({ limit: 5, ifNoneMatch: p1.meta.etag });
    expect(calls).toBe(2);
    expect(lastIfNone).toBe('"me-v1"');
    expect(p2.notModified).toBe(true);
    expect(p2.listings).toHaveLength(0);

    // No ETag → fingerprint still short-circuits via syncOnce
    let n = 0;
    const noEtag: typeof fetch = async () => {
      n += 1;
      return new Response(listingBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const pNo = createMagicEdenProvider({
      fetchImpl: noEtag,
      offlineSolPrice: true,
      solPriceUsd: 100,
      maxRetries: 0,
    });
    const store = new ListingStore();
    const a = await syncOnce(store, pNo, {
      limit: 5,
      shortCircuitOnBuiltAt: false,
    });
    expect(a.shortCircuited).toBe(false);
    expect(
      store.getMeta("magiceden", a.querySignature)?.contentFingerprint,
    ).toMatch(/^fp:/);
    const b = await syncOnce(store, pNo, {
      limit: 5,
      shortCircuitOnBuiltAt: false,
    });
    expect(n).toBe(2);
    expect(b.shortCircuited).toBe(true);
    expect(store.size("magiceden")).toBe(1);
  });

  it("fetchOffers:false skips offer endpoints", async () => {
    const called: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      called.push(String(input));
      return new Response("[]", { status: 200 });
    };
    const bids = createMagicEdenBidsProvider({
      fetchImpl,
      fetchOffers: false,
      mints: ["M1", "M2"],
      offlineSolPrice: true,
    });
    const orders = await bids.pull({ limit: 3 });
    expect(orders).toEqual([]);
    expect(called).toHaveLength(0);
    expect(bids.lastPullMeta?.mintsAttempted).toBe(0);
  });
});

describe("MagicEdenProvider pullAll / pagination", () => {
  function meRow(mint: string, price = 1) {
    return { tokenMint: mint, price, pdaAddress: `pda_${mint}` };
  }

  /** Continuous universe sliced by offset/limit (true multi-page mock). */
  function mockUniverse(
    rows: ReturnType<typeof meRow>[],
  ): { fetchImpl: typeof fetch; called: string[] } {
    const called: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      called.push(url);
      if (!url.includes("/listings")) {
        return new Response("{}", { status: 404 });
      }
      const u = new URL(url);
      const offset = Number(u.searchParams.get("offset") ?? "0");
      const limit = Number(u.searchParams.get("limit") ?? "20");
      const body = rows.slice(offset, offset + limit);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    return { fetchImpl, called };
  }

  it("pullAll aggregates multi-page collector_crypt until short page", async () => {
    const rows = [
      meRow("A"),
      meRow("B"),
      meRow("C"),
      meRow("D"),
      meRow("E"),
    ];
    const { fetchImpl, called } = mockUniverse(rows);
    const p = createMagicEdenProvider({
      fetchImpl,
      offlineSolPrice: true,
      solPriceUsd: 100,
      maxRetries: 0,
    });
    // desired 5, pageLimit min(5,100)=5 → one page of 5, hasMore false
    // Use maxPages + page size 2 via pullPages, and pullAll with limit>page
    // pullAll: desired=5, pageLimit=5 → single full page.
    const page = await p.pullAll({ limit: 5 });
    expect(page.listings.map((l) => l.tokenId)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);
    expect(p.lastError).toBeNull();
    expect(called.some((u) => u.includes("collector_crypt"))).toBe(true);

    // Multi-page: desired 250 → pageLimit 100; universe 5 → one short page after first
    const rows2 = Array.from({ length: 5 }, (_, i) => meRow(`N${i}`));
    const m2 = mockUniverse(rows2);
    const p2 = createMagicEdenProvider({
      fetchImpl: m2.fetchImpl,
      offlineSolPrice: true,
      solPriceUsd: 100,
      maxRetries: 0,
    });
    // pageLimit=min(250,100)=100, maxPages=ceil(250/100)=3 → fetch offset0 limit100 → 5 rows → stop
    const all = await p2.pullAll({ limit: 250 });
    expect(all.listings).toHaveLength(5);
    expect(p2.lastPagesFetched).toBe(1);
    expect(p2.lastPullMeta?.stoppedReason).toMatch(/hasMore_false|single/);
  });

  it("pullPages walks offset until short page (mock multi-page)", async () => {
    const rows = [
      meRow("M0"),
      meRow("M1"),
      meRow("M2"),
      meRow("M3"),
      meRow("M4"),
    ];
    const { fetchImpl, called } = mockUniverse(rows);
    const p = createMagicEdenProvider({
      fetchImpl,
      offlineSolPrice: true,
      solPriceUsd: 100,
      maxRetries: 0,
    });
    const page = await p.pullPages({ limit: 2, maxPages: 5 });
    expect(page.listings.map((l) => l.tokenId)).toEqual([
      "M0",
      "M1",
      "M2",
      "M3",
      "M4",
    ]);
    expect(page.hasMore).toBe(false);
    expect(p.lastPagesFetched).toBe(3);
    expect(p.lastPullMeta?.stoppedReason).toBe("hasMore_false");
    const listingCalls = called.filter((u) => u.includes("/listings"));
    // Concurrent waves may overshoot by ≤2 empty probes after the short page
    expect(listingCalls.length).toBeGreaterThanOrEqual(3);
    expect(listingCalls.length).toBeLessThanOrEqual(5);
    expect(listingCalls[0]).toMatch(/offset=0/);
    expect(listingCalls.some((u) => /offset=2/.test(u))).toBe(true);
    expect(listingCalls.some((u) => /offset=4/.test(u))).toBe(true);
    expect(listingCalls.every((u) => u.includes("collector_crypt"))).toBe(true);
  });

  it("pullAll paginates multiple full pages (pageLimit 100)", async () => {
    const big = Array.from({ length: 250 }, (_, i) => meRow(`B${i}`));
    const m = mockUniverse(big);
    const pBig = createMagicEdenProvider({
      fetchImpl: m.fetchImpl,
      offlineSolPrice: true,
      solPriceUsd: 100,
      maxRetries: 0,
    });
    const page = await pBig.pullAll({ limit: 250 });
    expect(page.listings).toHaveLength(250);
    expect(pBig.lastPagesFetched).toBe(3);
    expect(pBig.lastPullMeta?.stoppedReason).toMatch(
      /hasMore_false|desired|maxPages/,
    );
    expect(m.called.filter((u) => u.includes("/listings")).length).toBe(3);
    expect(m.called[0]).toMatch(/limit=100/);
    expect(m.called[1]).toMatch(/offset=100/);
    expect(m.called[2]).toMatch(/offset=200/);
  });

  it("pullAll slices to desired when more rows fetched", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => meRow(`C${i}`));
    const { fetchImpl } = mockUniverse(rows);
    const p = createMagicEdenProvider({
      fetchImpl,
      offlineSolPrice: true,
      solPriceUsd: 100,
      maxRetries: 0,
    });
    // maxPages forces multi-page path; pageLimit=25 fills then page2 adds 5 → slice to 25
    const page = await p.pullAll({ limit: 25, maxPages: 5 });
    expect(page.listings).toHaveLength(25);
    expect(page.listings.map((l) => l.tokenId).slice(0, 3)).toEqual([
      "C0",
      "C1",
      "C2",
    ]);
    expect(p.lastPullMeta?.stoppedReason).toBe("desired");
  });

  it("maxPages stops early with hasMore true", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => meRow(`X${i}`));
    const { fetchImpl, called } = mockUniverse(rows);
    const p = createMagicEdenProvider({
      fetchImpl,
      offlineSolPrice: true,
      solPriceUsd: 100,
      maxRetries: 0,
    });
    const page = await p.pullPages({ limit: 2, maxPages: 2 });
    expect(page.listings).toHaveLength(4);
    expect(page.hasMore).toBe(true);
    expect(p.lastPullMeta?.stoppedReason).toBe("maxPages");
    expect(p.lastPagesFetched).toBe(2);
    expect(called.filter((u) => u.includes("/listings"))).toHaveLength(2);
  });

  it("pullAll soft-fails empty on HTTP error (no throw)", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503 });
    const p = createMagicEdenProvider({
      fetchImpl,
      offlineSolPrice: true,
      solPriceUsd: 100,
      maxRetries: 0,
    });
    const page = await p.pullAll({ limit: 50, maxPages: 5 });
    expect(page.listings).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(p.lastError).toMatch(/HTTP 503/);
    expect(page.meta.contentFingerprint).toBeUndefined();
  });

  it("mid-pagination soft-fail keeps partial rows", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (!url.includes("/listings")) {
        return new Response("{}", { status: 404 });
      }
      n += 1;
      if (n === 1) {
        return new Response(
          JSON.stringify([meRow("P0"), meRow("P1")]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("err", { status: 500 });
    };
    const p = createMagicEdenProvider({
      fetchImpl,
      offlineSolPrice: true,
      solPriceUsd: 100,
      maxRetries: 0,
    });
    const page = await p.pullPages({ limit: 2, maxPages: 5 });
    expect(page.listings.map((l) => l.tokenId)).toEqual(["P0", "P1"]);
    expect(p.lastError).toMatch(/HTTP 500/);
    expect(p.lastPullMeta?.stoppedReason).toBe("soft_error");
    expect(p.lastPagesFetched).toBe(1);
    // Incomplete: must not look like a complete snapshot (would mass-prune)
    expect(page.hasMore).toBe(true);
  });

  it("syncOnce uses pullAll multi-page for magiceden", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => meRow(`S${i}`));
    const { fetchImpl } = mockUniverse(rows);
    const p = createMagicEdenProvider({
      fetchImpl,
      offlineSolPrice: true,
      solPriceUsd: 100,
      maxRetries: 0,
    });
    const store = new ListingStore();
    // limit 250 → pageLimit 100, pages until short (5 rows)
    const result = await syncOnce(store, p, {
      limit: 250,
      shortCircuitOnBuiltAt: false,
    });
    expect(result.fetched).toBe(5);
    expect(store.size("magiceden")).toBe(5);
    expect(p.lastPagesFetched).toBe(1);
    expect(typeof p.pullAll).toBe("function");
  });

  it("multi-page pullAll then shrink prunes missing mint (poll-diff delist)", async () => {
    // ME page size ≤100 → 250 rows needs 3 pages; then drop one mint on re-pull.
    let universe = Array.from({ length: 250 }, (_, i) =>
      meRow(`M${i}`, 1 + (i % 10)),
    );
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (!url.includes("/listings")) {
        return new Response("{}", { status: 404 });
      }
      const u = new URL(url);
      const offset = Number(u.searchParams.get("offset") ?? "0");
      const limit = Number(u.searchParams.get("limit") ?? "20");
      const body = universe.slice(offset, offset + limit);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const p = createMagicEdenProvider({
      fetchImpl,
      offlineSolPrice: true,
      solPriceUsd: 100,
      maxRetries: 0,
    });
    const store = new ListingStore();
    // pullAll: pageLimit 100, maxPages ceil(250/100)=3 → full multi-page walk
    const cold = await syncOnce(store, p, {
      limit: 250,
      shortCircuitOnBuiltAt: false,
    });
    expect(cold.fetched).toBe(250);
    expect(cold.pruned).toBe(0);
    expect(cold.prunedIds).toEqual([]);
    expect(store.size("magiceden")).toBe(250);
    expect(p.lastPagesFetched).toBe(3);
    expect(p.lastPullMeta?.symbol).toBe("collector_crypt");

    const goneId = listingId({
      provider: "magiceden",
      platform: "me",
      nativeId: "pda_M42",
    });
    expect(store.get(goneId)).toBeDefined();

    const book = new OrderbookStore();
    for (const l of store.list("magiceden")) {
      book.upsertAsk(listingToAsk(l));
    }
    expect(book.allAsks()).toHaveLength(250);

    // Shrink: mint M42 leaves collection listings (sold/delisted on ME)
    universe = universe.filter((r) => r.tokenMint !== "M42");
    const warm = await syncOnce(store, p, {
      limit: 250,
      shortCircuitOnBuiltAt: false,
    });
    expect(warm.pruned).toBe(1);
    expect(warm.prunedIds).toEqual([goneId]);
    expect(store.get(goneId)).toBeUndefined();
    expect(store.size("magiceden")).toBe(249);
    expect(warm.prunedIds.every((id) => id.startsWith("magiceden:me:"))).toBe(
      true,
    );

    const events = applyDelistsFromSync(warm, book);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "magiceden",
      listingId: goneId,
      reason: "missing_from_full_snapshot",
      source: "poll_diff",
    });
    expect(book.getAsk(`ask:${goneId}`)).toBeUndefined();
    expect(book.allAsks()).toHaveLength(249);
  });

  it("mid-pagination soft-fail after full book does not prune", async () => {
    let mode: "ok" | "partial_fail" = "ok";
    // 150 rows → 2 pages at limit 100; fail page 2 on warm re-pull
    const rows = Array.from({ length: 150 }, (_, i) => meRow(`K${i}`));
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (!url.includes("/listings")) {
        return new Response("{}", { status: 404 });
      }
      const u = new URL(url);
      const offset = Number(u.searchParams.get("offset") ?? "0");
      const limit = Number(u.searchParams.get("limit") ?? "20");
      if (mode === "partial_fail" && offset > 0) {
        return new Response("err", { status: 500 });
      }
      const body = rows.slice(offset, offset + limit);
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const p = createMagicEdenProvider({
      fetchImpl,
      offlineSolPrice: true,
      solPriceUsd: 100,
      maxRetries: 0,
    });
    const store = new ListingStore();
    await syncOnce(store, p, {
      limit: 150,
      shortCircuitOnBuiltAt: false,
    });
    expect(store.size("magiceden")).toBe(150);

    mode = "partial_fail";
    const warm = await syncOnce(store, p, {
      limit: 150,
      shortCircuitOnBuiltAt: false,
    });
    expect(warm.pruned).toBe(0);
    expect(warm.prunedIds).toEqual([]);
    expect(store.size("magiceden")).toBe(150);
    expect(p.lastError).toMatch(/HTTP 500/);
  });

  it("bootstrap walks until empty with high page cap", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => meRow(`Z${i}`));
    const { fetchImpl, called } = mockUniverse(rows);
    const p = createMagicEdenProvider({
      fetchImpl,
      offlineSolPrice: true,
      solPriceUsd: 100,
      maxRetries: 0,
    });
    const page = await p.pullAll({ bootstrap: true });
    expect(page.listings).toHaveLength(7);
    expect(p.lastError).toBeNull();
    // bootstrap uses pageLimit 100 → single short page
    expect(called.filter((u) => u.includes("/listings"))).toHaveLength(1);
    expect(called[0]).toMatch(/limit=100/);
  });

  it("empty first page stops without error", async () => {
    const { fetchImpl } = mockUniverse([]);
    const p = createMagicEdenProvider({
      fetchImpl,
      offlineSolPrice: true,
      solPriceUsd: 100,
      maxRetries: 0,
    });
    const page = await p.pullPages({ limit: 5, maxPages: 3 });
    expect(page.listings).toEqual([]);
    expect(p.lastError).toBeNull();
    expect(p.lastPullMeta?.stoppedReason).toBe("empty");
    expect(p.lastPagesFetched).toBe(1);
  });
});

describe("MagicEdenBidsProvider unit", () => {
  it("after listings pull, fetches offers for sample mints (offers_received)", async () => {
    const called: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      called.push(url);
      if (url.includes("/collections/") && url.includes("/listings")) {
        return new Response(
          JSON.stringify([
            { tokenMint: "MintA", price: 1, pdaAddress: "pA" },
            { tokenMint: "MintB", price: 2, pdaAddress: "pB" },
            { tokenMint: "MintC", price: 3, pdaAddress: "pC" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/offers_received")) {
        const mint = url.match(/tokens\/([^/]+)\//)?.[1] ?? "x";
        return new Response(
          JSON.stringify([
            {
              price: 0.5,
              buyer: `buyer_${mint}`,
              pdaAddress: `offer_${mint}`,
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/offers")) {
        return new Response("Not Found.", { status: 400 });
      }
      return new Response("{}", { status: 404 });
    };

    const bids = createMagicEdenBidsProvider({
      fetchImpl,
      solPriceUsd: 100,
      offlineSolPrice: true,
      sampleMints: 3,
    });
    const orders = await bids.pull({ limit: 3 });
    expect(bids.lastPullMeta?.mintsAttempted).toBe(3);
    expect(bids.lastPullMeta?.mintsFromListings).toBeGreaterThanOrEqual(3);
    expect(bids.lastMints).toHaveLength(3);
    expect(orders.length).toBe(3);
    expect(orders.every((o) => o.provider === "magiceden_bids")).toBe(true);
    expect(orders.every((o) => o.side === "bid")).toBe(true);
    expect(called.some((u) => u.includes("/listings"))).toBe(true);
    expect(
      called.filter((u) => u.includes("/offers_received")).length,
    ).toBeGreaterThanOrEqual(3);
    for (const a of bids.lastPullMeta!.attempts) {
      expect(a.endpoint).toContain("offers_received");
      expect(a.httpStatus).toBe(200);
    }
  });

  it("setMints skips listings hop and still hits offer endpoints", async () => {
    const called: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      called.push(url);
      if (url.includes("/offers_received")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    };
    const p = new MagicEdenBidsProvider({
      fetchImpl,
      solPriceUsd: 150,
      offlineSolPrice: true,
    });
    p.setMints(["M1", "M2", "M3", "M4"]);
    const orders = await p.pull({ limit: 3 });
    expect(orders).toEqual([]);
    expect(p.lastPullMeta?.mintsAttempted).toBe(3);
    expect(p.lastPullMeta?.sampleUsed).toBe(3);
    expect(p.lastPullMeta?.bidsHttpCalls).toBe(3);
    expect(p.lastPullMeta?.cacheHits).toBe(0);
    expect(called.every((u) => !u.includes("/listings"))).toBe(true);
    expect(called.filter((u) => u.includes("/offers_received"))).toHaveLength(
      3,
    );
  });

  it("sampleMints caps offers_received fan-out", async () => {
    const called: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      called.push(url);
      if (url.includes("/offers_received")) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    };
    const p = new MagicEdenBidsProvider({
      fetchImpl,
      solPriceUsd: 100,
      offlineSolPrice: true,
      sampleMints: 2,
      mints: ["A", "B", "C", "D", "E"],
    });
    await p.pull();
    expect(p.lastMints).toEqual(["A", "B"]);
    expect(p.lastPullMeta?.sampleUsed).toBe(2);
    expect(p.lastPullMeta?.bidsHttpCalls).toBe(2);
    expect(called.filter((u) => u.includes("/offers_received"))).toHaveLength(
      2,
    );
  });

  it("TTL cache serves offers_received hits; expiry re-fetches", async () => {
    let now = 1_000_000;
    const called: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      called.push(url);
      if (url.includes("/offers_received")) {
        const mint = url.match(/tokens\/([^/]+)\//)?.[1] ?? "x";
        return new Response(
          JSON.stringify([
            { price: 1, buyer: "b", pdaAddress: `off_${mint}` },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    };
    const p = new MagicEdenBidsProvider({
      fetchImpl,
      solPriceUsd: 100,
      offlineSolPrice: true,
      mints: ["M1", "M2"],
      sampleMints: 2,
      ttlMs: 1000,
      maxConcurrent: 2,
      now: () => now,
    });

    const first = await p.pull();
    expect(first).toHaveLength(2);
    expect(p.lastPullMeta?.bidsHttpCalls).toBe(2);
    expect(p.lastPullMeta?.cacheHits).toBe(0);
    expect(p.lastPullMeta?.ttlMs).toBe(1000);
    expect(p.lastPullMeta?.maxConcurrent).toBe(2);
    const httpAfterFirst = called.filter((u) =>
      u.includes("/offers_received"),
    ).length;
    expect(httpAfterFirst).toBe(2);

    const second = await p.pull();
    expect(second).toHaveLength(2);
    expect(p.lastPullMeta?.bidsHttpCalls).toBe(0);
    expect(p.lastPullMeta?.cacheHits).toBe(2);
    expect(
      called.filter((u) => u.includes("/offers_received")),
    ).toHaveLength(httpAfterFirst);

    now += 1001;
    const third = await p.pull();
    expect(third).toHaveLength(2);
    expect(p.lastPullMeta?.bidsHttpCalls).toBe(2);
    expect(p.lastPullMeta?.cacheHits).toBe(0);
    expect(
      called.filter((u) => u.includes("/offers_received")),
    ).toHaveLength(4);
  });

  it("maxConcurrent bounds in-flight offers_received", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (!url.includes("/offers_received")) {
        return new Response("{}", { status: 404 });
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const p = new MagicEdenBidsProvider({
      fetchImpl,
      solPriceUsd: 100,
      offlineSolPrice: true,
      mints: ["1", "2", "3", "4", "5", "6"],
      sampleMints: 6,
      maxConcurrent: 2,
      ttlMs: 0,
    });
    await p.pull();
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBe(2);
    expect(p.lastPullMeta?.bidsHttpCalls).toBe(6);
    expect(p.lastPullMeta?.maxConcurrent).toBe(2);
  });
});

describe("OrderbookFeed native + MagicEdenBidsProvider", () => {
  it("seeds ME mints from store and pulls offers when native", async () => {
    const store = new ListingStore();
    const mk = (mint: string, price: number): Listing => ({
      id: listingId({ provider: "magiceden", platform: "me", nativeId: mint }),
      provider: "magiceden",
      platform: "me",
      nativeId: mint,
      tokenId: mint,
      name: mint,
      price,
      currency: "USDC",
      fmv: null,
      delta: null,
      market: "Magic Eden",
      seller: null,
      externalUrl: null,
      imageUrl: null,
      listedAt: null,
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
    });
    store.upsertOne(mk("SeedMint1", 10));
    store.upsertOne(mk("SeedMint2", 20));
    store.upsertOne(mk("SeedMint3", 30));

    const offerHits: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/offers_received")) {
        offerHits.push(url);
        return new Response(
          JSON.stringify([{ price: 0.1, buyer: "b", pdaAddress: url }]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("[]", { status: 200 });
    };

    const meBids = new MagicEdenBidsProvider({
      fetchImpl,
      solPriceUsd: 100,
      offlineSolPrice: true,
      sampleMints: 3,
    });
    const feed = new OrderbookFeed({
      listingStore: store,
      listingFilter: { tcg: "pokemon" },
      native: true,
      bidsProvider: meBids,
    });
    await feed.start();
    expect(offerHits.length).toBeGreaterThanOrEqual(3);
    expect(meBids.lastPullMeta?.mintsAttempted).toBeGreaterThanOrEqual(3);
    expect(feed.getOrderbookStore().allAsks().length).toBe(3);
    expect(feed.getOrderbookStore().allBids().length).toBeGreaterThanOrEqual(3);
    feed.stop();
  });
});

describe.skipIf(!runLive)("MagicEden live", () => {
  it("live listings collector_crypt + live SOL + optional top-mint offers", async () => {
    clearSolPriceCache();
    // Live SOL price (CoinGecko); listings for collector_crypt
    const listings = createMagicEdenProvider();
    const page = await listings.pull({ limit: 10 });
    expect(listings.lastError).toBeNull();
    expect(page.listings.length).toBeGreaterThan(0);
    expect(listings.lastMints.length).toBeGreaterThan(0);
    expect(listings.lastSolPriceUsd).not.toBeNull();
    expect(listings.lastSolPriceUsd!).toBeGreaterThan(0);
    // USD prices derived from live SOL
    expect(page.listings.every((l) => l.price > 0)).toBe(true);
    expect(page.listings.every((l) => l.platform === "me")).toBe(true);

    // Optional offers for top mints (soft empty per mint)
    const bids = createMagicEdenBidsProvider({
      sampleMints: 3,
      listingsProvider: listings as MagicEdenProvider,
      mints: listings.lastMints.slice(0, 5),
    });
    const orders = await bids.pull({ limit: 3 });
    expect(Array.isArray(orders)).toBe(true);
    expect(bids.lastPullMeta).not.toBeNull();
    expect(bids.lastPullMeta!.mintsAttempted).toBeGreaterThanOrEqual(3);
    expect(bids.lastMints.length).toBeGreaterThanOrEqual(3);
    expect(bids.lastPullMeta!.solPriceUsd).toBeGreaterThan(0);
    expect(bids.lastPullMeta!.attempts.length).toBeGreaterThanOrEqual(3);
    for (const a of bids.lastPullMeta!.attempts) {
      expect(a.mint.length).toBeGreaterThan(0);
      // Live mainnet: offers_received returns 200 (often empty array)
      expect(
        a.httpStatus === 200 || a.httpStatus === 400 || a.httpStatus === null,
      ).toBe(true);
    }
    for (const o of orders) {
      expect(o.side).toBe("bid");
      expect(o.price).toBeGreaterThan(0);
      expect(o.provider).toBe("magiceden_bids");
    }
  }, 60_000);
});
