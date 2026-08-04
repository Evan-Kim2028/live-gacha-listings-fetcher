import { describe, expect, it } from "vitest";
import {
  normalizeCcCard,
  normalizeCcOffer,
  normalizeCcOffers,
  countOfferRefs,
  buildMarketplaceUrl,
  pageFromQuery,
  resolveBlockchainParam,
  lastEventFromCcCard,
  createCollectorCryptProvider,
  createCollectorCryptBidsProvider,
  fetchCcCardOffers,
  type CcCard,
  type CcOfferRef,
} from "../src/providers/collectorcrypt.js";
import { applyDelistsFromSync } from "../src/lifecycle/index.js";
import { ListingStore } from "../src/store.js";
import { syncOnce } from "../src/sync.js";
import { MultiSourceRadar } from "../src/aggregate/MultiSourceRadar.js";

/** Live network tests: set LIVE=1 or RUN_LIVE=1 */
const runLive = Boolean(process.env.LIVE || process.env.RUN_LIVE);

const sampleCard: CcCard = {
  id: "card_abc",
  itemName: "1999 Charizard PSA 10",
  nftAddress: "Mint111",
  category: "Pokemon",
  type: "Card",
  year: 1999,
  grade: "10",
  gradeNum: 10,
  gradingCompany: "PSA",
  language: "English",
  set: "Base Set",
  serial: "4",
  listing: {
    createdAt: "2026-08-01T00:00:00.000Z",
    currency: "USDC",
    price: 100,
    marketplace: "CC",
  },
  offers: [
    { id: "off1", price: 80, currency: "USDC", buyerWallet: "Buyer1" },
    { id: "off2" }, // id-only
  ],
  owner: { wallet: "Seller1" },
  images: { frontS: "https://example.com/c.png" },
  insuredValue: 120,
};

const browseFixture = {
  filterNFtCard: [
    {
      ...sampleCard,
      offers: [{ id: "off1" }, { id: "off2" }], // id-only like live browse
    },
  ] as CcCard[],
  findTotal: 1,
  total: 1,
  totalPages: 1,
};

describe("Collector Crypt normalize + URL", () => {
  it("normalizes listing ask with stable id and offerCount on raw", () => {
    const l = normalizeCcCard(sampleCard);
    expect(l).not.toBeNull();
    expect(l!.id).toBe("collectorcrypt:cc:card_abc");
    expect(l!.price).toBe(100);
    expect(l!.tcg).toBe("pokemon");
    expect(l!.grader).toBe("PSA");
    expect(l!.setRaw).toBe("Base Set");
    expect(l!.cardNumber).toBe("4");
    expect(l!.fmv).toBe(120);
    expect(l!.delta).toBe(-17); // (100-120)/120
    expect((l!.raw as { offerCount?: number }).offerCount).toBe(2);
    expect(countOfferRefs(sampleCard)).toEqual({ refs: 2, priced: 1 });
    // Clickable public card page (mint preferred).
    expect(l!.externalUrl).toBe(
      "https://collectorcrypt.com/cards/Mint111",
    );
  });

  it("always sets externalUrl from mint or card id", () => {
    const withMint = normalizeCcCard(sampleCard);
    expect(withMint!.externalUrl).toBe(
      "https://collectorcrypt.com/cards/Mint111",
    );

    const noMint = normalizeCcCard({
      id: "20260101C999",
      itemName: "No mint card",
      listing: {
        createdAt: "2026-08-01T00:00:00.000Z",
        currency: "USDC",
        price: 25,
        marketplace: "CC",
      },
    });
    expect(noMint).not.toBeNull();
    expect(noMint!.externalUrl).toBe(
      "https://collectorcrypt.com/cards/20260101C999",
    );
  });

  it("extracts priced offers as bids; skips id-only", () => {
    const bids = normalizeCcOffers(sampleCard);
    expect(bids).toHaveLength(1);
    expect(bids[0]!.price).toBe(80);
    expect(bids[0]!.side).toBe("bid");
    expect(bids[0]!.bidder).toBe("Buyer1");
  });

  it("normalizes getCardOffers-shaped detail with nested buyer", () => {
    const detail: CcOfferRef = {
      id: "det1",
      price: "45.7",
      currency: "USDC",
      status: "Active",
      buyer: { wallet: "BuyerWallet9", id: "u1" },
      createdAt: "2026-07-31T08:00:00.000Z",
    };
    const b = normalizeCcOffer(detail, sampleCard);
    expect(b).not.toBeNull();
    expect(b!.price).toBe(45.7);
    expect(b!.bidder).toBe("BuyerWallet9");
    expect(b!.nativeId).toBe("det1");
  });

  it("builds page/step + tcg/price/grader query params", () => {
    const url = buildMarketplaceUrl(
      "https://api.collectorcrypt.com",
      {
        tcg: "pokemon",
        limit: 25,
        offset: 50,
        priceMin: 10,
        priceMax: 200,
        grader: "PSA",
        sort: "price",
      },
      50,
    );
    const u = new URL(url);
    expect(u.pathname).toMatch(/marketplace$/);
    expect(u.searchParams.get("page")).toBe("3"); // offset 50 / step 25 + 1
    expect(u.searchParams.get("step")).toBe("25");
    expect(u.searchParams.get("categories")).toBe("Pokemon");
    expect(u.searchParams.get("listPriceMin")).toBe("10");
    expect(u.searchParams.get("listPriceMax")).toBe("200");
    expect(u.searchParams.get("gradingCompany")).toBe("PSA");
    expect(u.searchParams.get("marketplaceStatus")).toBe("Buy now");
    expect(u.searchParams.get("orderBy")).toBe("listedPriceAsc");
  });

  it("pageFromQuery clamps step to 100", () => {
    const { page, step } = pageFromQuery({ limit: 500, offset: 200 }, 50);
    expect(step).toBe(100);
    expect(page).toBe(3);
  });

  it("resolveBlockchainParam canonicalizes Solana aliases", () => {
    expect(resolveBlockchainParam("Solana")).toBe("Solana");
    expect(resolveBlockchainParam("solana")).toBe("Solana");
    expect(resolveBlockchainParam(null)).toBeNull();
    expect(resolveBlockchainParam("")).toBeNull();
  });

  it("builds blockchain=Solana when opts set", () => {
    const url = buildMarketplaceUrl(
      "https://api.collectorcrypt.com",
      { tcg: "pokemon", limit: 50 },
      50,
      { blockchain: "Solana" },
    );
    const u = new URL(url);
    expect(u.searchParams.get("blockchain")).toBe("Solana");
    expect(u.searchParams.get("categories")).toBe("Pokemon");
    expect(u.searchParams.get("step")).toBe("50");
  });

  it("retries on HTTP 429 then succeeds", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      }
      return new Response(
        JSON.stringify({
          filterNFtCard: [sampleCard],
          findTotal: 1,
          total: 1,
          totalPages: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const provider = createCollectorCryptProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retryDelayMs: 1,
      maxRetries: 2,
      blockchain: "Solana",
    });
    const page = await provider.pull({ tcg: "pokemon", limit: 1 });
    expect(calls).toBe(2);
    expect(page.listings).toHaveLength(1);
    expect(provider.lastPullMeta?.blockchain).toBe("Solana");
    expect(provider.lastPullMeta?.url).toMatch(/blockchain=Solana/);
    expect((page.listings[0]!.raw as { offerCount?: number }).offerCount).toBe(
      2,
    );
  });

  it("marketplace ETag: stores etag, sends If-None-Match, 304 → notModified", async () => {
    let calls = 0;
    let lastIfNone: string | null = null;
    const body = JSON.stringify({
      filterNFtCard: [sampleCard],
      findTotal: 1,
      total: 1,
      totalPages: 1,
    });
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      lastIfNone = new Headers(init?.headers).get("If-None-Match");
      if (calls === 1) {
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ETag: '"cc-v1"',
          },
        });
      }
      return new Response(null, { status: 304, headers: { ETag: '"cc-v1"' } });
    };
    const provider = createCollectorCryptProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      blockchain: "Solana",
      maxRetries: 0,
    });
    const p1 = await provider.pull({ tcg: "pokemon", limit: 1 });
    expect(p1.notModified).toBeFalsy();
    expect(p1.listings).toHaveLength(1);
    expect(p1.meta.etag).toBe('"cc-v1"');
    expect(p1.meta.contentFingerprint).toMatch(/^fp:/);
    expect(provider.lastEtag).toBe('"cc-v1"');
    expect(lastIfNone).toBeNull();

    const p2 = await provider.pull({
      tcg: "pokemon",
      limit: 1,
      ifNoneMatch: p1.meta.etag,
    });
    expect(calls).toBe(2);
    expect(lastIfNone).toBe('"cc-v1"');
    expect(p2.notModified).toBe(true);
    expect(p2.listings).toHaveLength(0);
    expect(p2.meta.etag).toBe('"cc-v1"');
  });

  it("syncOnce 304 short-circuits without wipe; no-ETag uses fingerprint", async () => {
    let calls = 0;
    const body = JSON.stringify({
      filterNFtCard: [sampleCard],
      findTotal: 1,
      total: 1,
      totalPages: 1,
    });
    const withEtag = async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const inm = new Headers(init?.headers).get("If-None-Match");
      if (calls === 1) {
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ETag: '"sync-e1"',
          },
        });
      }
      expect(inm).toBe('"sync-e1"');
      return new Response(null, { status: 304 });
    };
    const provider = createCollectorCryptProvider({
      fetchImpl: withEtag as unknown as typeof fetch,
      blockchain: "Solana",
      maxRetries: 0,
    });
    const store = new ListingStore();
    const r1 = await syncOnce(store, provider, {
      tcg: "pokemon",
      limit: 1,
      shortCircuitOnBuiltAt: false,
    });
    expect(r1.shortCircuited).toBe(false);
    expect(r1.fetched).toBe(1);
    expect(store.size("collectorcrypt")).toBe(1);
    expect(store.getMeta("collectorcrypt", r1.querySignature)?.etag).toBe(
      '"sync-e1"',
    );

    const r2 = await syncOnce(store, provider, {
      tcg: "pokemon",
      limit: 1,
      shortCircuitOnBuiltAt: false,
    });
    expect(r2.shortCircuited).toBe(true);
    expect(r2.fetched).toBe(0);
    expect(r2.upserted).toBe(0);
    expect(r2.pruned).toBe(0);
    expect(r2.unchanged).toBe(1);
    expect(store.size("collectorcrypt")).toBe(1);
    expect(store.list("collectorcrypt")[0]!.nativeId).toBe("card_abc");

    // Soft: origin never returns ETag → fingerprint still short-circuits
    let n = 0;
    const noEtag = async () => {
      n += 1;
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const pNo = createCollectorCryptProvider({
      fetchImpl: noEtag as unknown as typeof fetch,
      blockchain: "Solana",
      maxRetries: 0,
    });
    const store2 = new ListingStore();
    const a = await syncOnce(store2, pNo, {
      tcg: "pokemon",
      limit: 1,
      shortCircuitOnBuiltAt: false,
    });
    expect(a.shortCircuited).toBe(false);
    expect(store2.getMeta("collectorcrypt", a.querySignature)?.etag == null).toBe(
      true,
    );
    expect(
      store2.getMeta("collectorcrypt", a.querySignature)?.contentFingerprint,
    ).toMatch(/^fp:/);
    const b = await syncOnce(store2, pNo, {
      tcg: "pokemon",
      limit: 1,
      shortCircuitOnBuiltAt: false,
    });
    expect(n).toBe(2);
    expect(b.shortCircuited).toBe(true);
    expect(store2.size("collectorcrypt")).toBe(1);
  });

  it("pullAll multi-page merges listings and preserves insuredValue→fmv/delta", async () => {
    const card = (id: string, price: number, insured: number): CcCard => ({
      ...sampleCard,
      id,
      nftAddress: `Mint${id}`,
      listing: {
        ...sampleCard.listing!,
        price,
      },
      insuredValue: insured,
      offers: [],
    });
    const pages: Record<string, CcMarketplaceResponse> = {
      "1": {
        filterNFtCard: [card("p1a", 100, 120), card("p1b", 80, 100)],
        findTotal: 3,
        total: 3,
        totalPages: 2,
      },
      "2": {
        filterNFtCard: [card("p2a", 50, 100)],
        findTotal: 3,
        total: 3,
        totalPages: 2,
      },
    };
    const seenPages: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      const u = new URL(String(input));
      const page = u.searchParams.get("page") ?? "1";
      const step = Number(u.searchParams.get("step") ?? "0");
      expect(step).toBeLessThanOrEqual(100);
      seenPages.push(page);
      const body = pages[page] ?? {
        filterNFtCard: [],
        findTotal: 3,
        total: 3,
        totalPages: 2,
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const provider = createCollectorCryptProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      defaultStep: 2,
      blockchain: "Solana",
      maxRetries: 0,
    });
    // maxPages set + defaultStep 2 → multi-page; no low limit so no post-slice
    const page = await provider.pullAll({
      tcg: "pokemon",
      maxPages: 5,
    });
    // step=2 → two pages of 2+1, merge 3; stop after page 2 (!hasMore)
    expect(seenPages).toEqual(["1", "2"]);
    expect(page.listings).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(provider.lastPullMeta?.pagesFetched).toBe(2);
    expect(provider.lastPullMeta?.step).toBe(2);
    const byNative = Object.fromEntries(
      page.listings.map((l) => [l.nativeId, l]),
    );
    expect(byNative.p1a!.fmv).toBe(120);
    expect(byNative.p1a!.delta).toBe(-17); // (100-120)/120
    expect(byNative.p1b!.fmv).toBe(100);
    expect(byNative.p1b!.delta).toBe(-20);
    expect(byNative.p2a!.fmv).toBe(100);
    expect(byNative.p2a!.delta).toBe(-50);
    const ids = page.listings.map((l) => l.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("pullAll bootstrap uses high maxPages and stops on !hasMore", async () => {
    let calls = 0;
    const fetchImpl = async (input: RequestInfo | URL) => {
      calls += 1;
      const u = new URL(String(input));
      const page = Number(u.searchParams.get("page") ?? "1");
      const step = Number(u.searchParams.get("step") ?? "0");
      expect(step).toBeLessThanOrEqual(100);
      const totalPages = 3;
      const card: CcCard = {
        ...sampleCard,
        id: `boot_${page}`,
        nftAddress: `MintBoot${page}`,
        insuredValue: 200,
        listing: { ...sampleCard.listing!, price: 150 },
        offers: [],
      };
      return new Response(
        JSON.stringify({
          filterNFtCard: [card],
          findTotal: totalPages,
          total: totalPages,
          totalPages,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const provider = createCollectorCryptProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      defaultStep: 1,
      blockchain: "Solana",
      maxRetries: 0,
    });
    // No limit → bootstrap walks until !hasMore (3 pages), not single defaultStep page
    const page = await provider.pullAll({ tcg: "pokemon", bootstrap: true });
    expect(calls).toBe(3);
    expect(page.listings).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.listings.every((l) => l.fmv === 200)).toBe(true);
    expect(page.listings.every((l) => l.delta === -25)).toBe(true); // (150-200)/200
    expect(provider.lastPullMeta?.pagesFetched).toBe(3);
  });

  it("lastEvent is LIST for Buy-now rows; card.status is not sold", () => {
    const listed = normalizeCcCard({
      ...sampleCard,
      status: "Transferred",
      listing: {
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        currency: "USDC",
        price: 100,
        marketplace: "CC",
      },
    });
    expect(listed!.lastEvent).toBe("LIST");
    expect(lastEventFromCcCard(listed!.raw as CcCard)).toBe("LIST");
    expect((listed!.raw as CcCard).status).toBe("Transferred");
    // No listing → not normalized (would not appear under marketplaceStatus=Buy now)
    expect(
      normalizeCcCard({ ...sampleCard, listing: null }),
    ).toBeNull();
    expect(lastEventFromCcCard({ ...sampleCard, listing: null })).toBeNull();
  });

  it("delist lifecycle: full bootstrap pullAll then warm complete replace produces prunedIds", async () => {
    // Solana radar path: marketplaceStatus=Buy now absence after complete multi-page
    // pullAll → missing_from_full_snapshot (no invented sold endpoint).
    const mk = (id: string, price: number): CcCard => ({
      ...sampleCard,
      id,
      nftAddress: `Mint${id}`,
      status: "Transferred",
      insuredValue: price,
      listing: {
        createdAt: "2026-08-01T00:00:00.000Z",
        currency: "USDC",
        price,
        marketplace: "CC",
      },
      offers: [],
    });

    // phase full: 3 cards across 2 pages (step=2); warm: drop middle id "gone"
    let phase: "full" | "warm" = "full";
    const urls: string[] = [];
    const fetchImpl = async (input: RequestInfo | URL) => {
      const u = new URL(String(input));
      urls.push(u.toString());
      expect(u.searchParams.get("marketplaceStatus")).toBe("Buy now");
      expect(u.searchParams.get("blockchain")).toBe("Solana");
      const page = u.searchParams.get("page") ?? "1";
      if (phase === "full") {
        const body =
          page === "1"
            ? {
                filterNFtCard: [mk("keep_a", 10), mk("gone", 20)],
                findTotal: 3,
                total: 3,
                totalPages: 2,
              }
            : {
                filterNFtCard: [mk("keep_c", 30)],
                findTotal: 3,
                total: 3,
                totalPages: 2,
              };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Warm complete book: keep_a + keep_c only (gone left Buy-now set)
      const body =
        page === "1"
          ? {
              filterNFtCard: [mk("keep_a", 10), mk("keep_c", 30)],
              findTotal: 2,
              total: 2,
              totalPages: 1,
            }
          : {
              filterNFtCard: [],
              findTotal: 2,
              total: 2,
              totalPages: 1,
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const provider = createCollectorCryptProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      defaultStep: 2,
      blockchain: "Solana",
      maxRetries: 0,
      pageConcurrency: { start: 1, max: 1 },
    });
    const store = new ListingStore();

    const cold = await syncOnce(store, provider, {
      tcg: "pokemon",
      bootstrap: true,
      shortCircuitOnBuiltAt: false,
    });
    expect(cold.fetched).toBe(3);
    expect(cold.pruned).toBe(0);
    expect(cold.prunedIds).toEqual([]);
    expect(store.size("collectorcrypt")).toBe(3);
    const goneId = "collectorcrypt:cc:gone";
    expect(store.get(goneId)).toBeDefined();

    phase = "warm";
    urls.length = 0;
    const warm = await syncOnce(store, provider, {
      tcg: "pokemon",
      bootstrap: true,
      shortCircuitOnBuiltAt: false,
    });
    expect(warm.fetched).toBe(2);
    expect(warm.pruned).toBe(1);
    expect(warm.prunedIds).toEqual([goneId]);
    expect(store.get(goneId)).toBeUndefined();
    expect(store.size("collectorcrypt")).toBe(2);
    // Every browse still filters Buy now (delist signal = absence)
    expect(urls.length).toBeGreaterThan(0);
    for (const raw of urls) {
      expect(new URL(raw).searchParams.get("marketplaceStatus")).toBe("Buy now");
    }

    const events = applyDelistsFromSync(warm);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "collectorcrypt",
      listingId: goneId,
      reason: "missing_from_full_snapshot",
      source: "poll_diff",
    });
  });

  it("pullAll multi-page backs off on 429 then merges", async () => {
    const card = (id: string): CcCard => ({
      ...sampleCard,
      id,
      nftAddress: `Mint${id}`,
      insuredValue: 90,
      listing: { ...sampleCard.listing!, price: 100 },
      offers: [],
    });
    let page1Attempts = 0;
    const fetchImpl = async (input: RequestInfo | URL) => {
      const u = new URL(String(input));
      const page = u.searchParams.get("page") ?? "1";
      if (page === "1") {
        page1Attempts += 1;
        if (page1Attempts === 1) {
          return new Response("rate limited", {
            status: 429,
            headers: { "Retry-After": "0" },
          });
        }
        return new Response(
          JSON.stringify({
            filterNFtCard: [card("r1")],
            findTotal: 2,
            total: 2,
            totalPages: 2,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          filterNFtCard: [card("r2")],
          findTotal: 2,
          total: 2,
          totalPages: 2,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const provider = createCollectorCryptProvider({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      defaultStep: 1,
      retryDelayMs: 1,
      maxRetries: 2,
      blockchain: "Solana",
    });
    const page = await provider.pullAll({ maxPages: 3 });
    expect(page1Attempts).toBe(2);
    expect(page.listings).toHaveLength(2);
    expect(page.listings[0]!.fmv).toBe(90);
    expect(page.listings[0]!.delta).toBe(11); // round((100-90)/90*100)
    expect(page.listings[1]!.nativeId).toBe("r2");
  });

  it("bids provider enriches id-only browse via getCardOffers mock", async () => {
    const fixtureJson = JSON.stringify(browseFixture);
    let postCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/marketplace")) {
        return new Response(fixtureJson, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (init?.method === "POST") {
        postCalls += 1;
        const body = JSON.parse(String(init.body ?? "{}")) as {
          method?: string;
          params?: { nftAddress?: string; useV2?: boolean };
        };
        expect(body.method).toBe("getCardOffers");
        expect(body.params?.nftAddress).toBe("Mint111");
        expect(body.params?.useV2).toBe(true);
        return new Response(
          JSON.stringify([
            {
              id: "off1",
              price: "90",
              currency: "USDC",
              status: "Active",
              buyer: { wallet: "W1" },
            },
            {
              id: "off2",
              price: "85",
              currency: "USDC",
              status: "Active",
              buyer: { wallet: "W2" },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const bidsProvider = createCollectorCryptBidsProvider({
      fetchImpl,
      enrichOffers: true,
      sampleCards: 5,
      ttlMs: 30_000,
    });
    const { writeFile, unlink } = await import("node:fs/promises");
    const path = "/tmp/cc-browse-fixture-test.json";
    await writeFile(path, fixtureJson);
    try {
      const bids = await bidsProvider.pull({
        fixturePath: path,
        enrichOffers: true,
      });
      expect(bids.length).toBe(2);
      expect(bids.map((b) => b.price).sort()).toEqual([85, 90]);
      expect(bidsProvider.lastBidsMeta?.enrichEnabled).toBe(true);
      expect(bidsProvider.lastBidsMeta?.mintsAttempted).toBe(1);
      expect(bidsProvider.lastBidsMeta?.detailOffersRaw).toBe(2);
      expect(bidsProvider.lastBidsMeta?.bidsNormalized).toBe(2);
      expect(bidsProvider.lastBidsMeta?.httpCalls).toBe(1);
      expect(bidsProvider.lastBidsMeta?.cacheHits).toBe(0);
      expect(bidsProvider.lastBidsMeta?.sampleUsed).toBe(1);
      expect(bidsProvider.lastPullMeta?.offerRefs).toBe(2);
      expect(bidsProvider.lastPullMeta?.pricedOffers).toBe(0);
      expect(postCalls).toBe(1);

      // Second pull: getCardOffers served from TTL cache by mint.
      const bids2 = await bidsProvider.pull({
        fixturePath: path,
        enrichOffers: true,
      });
      expect(bids2.length).toBe(2);
      expect(postCalls).toBe(1);
      expect(bidsProvider.lastBidsMeta?.httpCalls).toBe(0);
      expect(bidsProvider.lastBidsMeta?.cacheHits).toBe(1);
      expect(bidsProvider.lastBidsMeta?.attempts?.[0]?.cacheHit).toBe(true);
    } finally {
      await unlink(path).catch(() => undefined);
    }
  });

  it("bids budget prefers offer refs, caps sample, and bounds concurrency", async () => {
    const cards: CcCard[] = [
      {
        id: "no_offers",
        itemName: "No offers",
        nftAddress: "MintNoRefs",
        category: "Pokemon",
        listing: { price: 10, currency: "USDC" },
        offers: [],
      },
      {
        id: "with_refs",
        itemName: "Has refs",
        nftAddress: "MintWithRefs",
        category: "Pokemon",
        listing: { price: 20, currency: "USDC" },
        offers: [{ id: "r1" }, { id: "r2" }],
      },
      {
        id: "also_refs",
        itemName: "Also refs",
        nftAddress: "MintAlsoRefs",
        category: "Pokemon",
        listing: { price: 30, currency: "USDC" },
        offers: [{ id: "r3" }],
      },
      {
        id: "no_refs2",
        itemName: "No refs 2",
        nftAddress: "MintNoRefs2",
        category: "Pokemon",
        listing: { price: 40, currency: "USDC" },
        offers: [],
      },
    ];
    const fixtureJson = JSON.stringify({
      filterNFtCard: cards,
      findTotal: cards.length,
      total: cards.length,
      totalPages: 1,
    });

    const postOrder: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).includes("/marketplace")) {
        return new Response(fixtureJson, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body ?? "{}")) as {
          params?: { nftAddress?: string };
        };
        const mint = body.params?.nftAddress ?? "";
        postOrder.push(mint);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return new Response(
          JSON.stringify([
            {
              id: `o-${mint}`,
              price: "1",
              currency: "USDC",
              status: "Active",
              buyer: { wallet: "W" },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const bidsProvider = createCollectorCryptBidsProvider({
      fetchImpl,
      enrichOffers: true,
      sampleCards: 2,
      concurrency: 1,
      ttlMs: 0, // no cache for this isolation test
    });
    const { writeFile, unlink } = await import("node:fs/promises");
    const path = "/tmp/cc-budget-prefer-test.json";
    await writeFile(path, fixtureJson);
    try {
      const bids = await bidsProvider.pull({
        fixturePath: path,
        enrichOffers: true,
        sampleCards: 2,
      });
      // Prefer withRefs first → MintWithRefs, MintAlsoRefs (not MintNoRefs*).
      expect(postOrder).toEqual(["MintWithRefs", "MintAlsoRefs"]);
      expect(bids.length).toBe(2);
      expect(bidsProvider.lastBidsMeta?.httpCalls).toBe(2);
      expect(bidsProvider.lastBidsMeta?.cacheHits).toBe(0);
      expect(bidsProvider.lastBidsMeta?.sampleUsed).toBe(2);
      expect(bidsProvider.lastBidsMeta?.mintsAttempted).toBe(2);
      expect(bidsProvider.lastBidsMeta?.maxConcurrent).toBe(1);
      expect(peak).toBeLessThanOrEqual(1);
    } finally {
      await unlink(path).catch(() => undefined);
    }
  });
});

describe.skipIf(!runLive)("Collector Crypt live network", () => {
  it("live pull marketplace pokemon listings with offerCount", async () => {
    const provider = createCollectorCryptProvider({ blockchain: "Solana" });
    const store = new ListingStore();
    const r = await syncOnce(store, provider, {
      tcg: "pokemon",
      limit: 5,
      sort: "new",
      shortCircuitOnBuiltAt: false,
    });
    expect(r.fetched).toBeGreaterThan(0);
    expect(store.list("collectorcrypt").length).toBe(r.fetched);
    const row = store.list("collectorcrypt")[0]!;
    expect(row.provider).toBe("collectorcrypt");
    expect(row.price).toBeGreaterThan(0);
    expect(row.id.startsWith("collectorcrypt:")).toBe(true);
    expect(row.tcg).toBe("pokemon");
    expect(provider.lastPullMeta?.step).toBe(5);
    expect(provider.lastPullMeta?.page).toBe(1);
    expect(provider.lastPullMeta?.blockchain).toBe("Solana");
    expect(provider.lastPullMeta?.url).toMatch(/blockchain=Solana/);
    expect(typeof (row.raw as { offerCount?: number }).offerCount).toBe(
      "number",
    );
  }, 30_000);

  it("live pull pokemon limit=50 with metrics.fetched", async () => {
    const provider = createCollectorCryptProvider({ blockchain: "Solana" });
    const store = new ListingStore();
    const r = await syncOnce(store, provider, {
      tcg: "pokemon",
      limit: 50,
      sort: "new",
      shortCircuitOnBuiltAt: false,
    });
    expect(r.fetched).toBeGreaterThan(0);
    expect(r.fetched).toBeLessThanOrEqual(50);
    expect(store.list("collectorcrypt").length).toBe(r.fetched);
    expect(provider.lastPullMeta?.blockchain).toBe("Solana");
    expect(provider.lastPullMeta?.step).toBe(50);
    for (const row of store.list("collectorcrypt")) {
      const raw = row.raw as { blockchain?: string } | null;
      if (raw?.blockchain) {
        expect(raw.blockchain.toLowerCase()).toBe("solana");
      }
    }
  }, 45_000);

  it("live pagination page/step yields distinct ids", async () => {
    const provider = createCollectorCryptProvider({ defaultStep: 3 });
    const p1 = await provider.pull({ tcg: "pokemon", limit: 3, offset: 0 });
    const p2 = await provider.pull({ tcg: "pokemon", limit: 3, offset: 3 });
    expect(p1.listings.length).toBeGreaterThan(0);
    expect(p2.listings.length).toBeGreaterThan(0);
    expect(provider.lastPullMeta?.page).toBe(2);
    const ids1 = new Set(p1.listings.map((l) => l.id));
    const overlap = p2.listings.filter((l) => ids1.has(l.id));
    expect(overlap.length).toBe(0);
    expect(p1.hasMore).toBe(true);
  }, 30_000);

  it("live filters: price range + grader", async () => {
    const provider = createCollectorCryptProvider();
    const page = await provider.pull({
      tcg: "pokemon",
      limit: 10,
      priceMin: 20,
      priceMax: 80,
      grader: "PSA",
      sort: "price",
    });
    expect(page.listings.length).toBeGreaterThan(0);
    for (const l of page.listings) {
      expect(l.price).toBeGreaterThanOrEqual(20);
      expect(l.price).toBeLessThanOrEqual(80);
      if (l.grader) expect(l.grader.toUpperCase()).toContain("PSA");
    }
    expect(provider.lastPullMeta?.url).toMatch(/listPriceMin=20/);
    expect(provider.lastPullMeta?.url).toMatch(/gradingCompany=PSA/);
  }, 30_000);

  it("live getCardOffers returns priced rows for a mint with offer refs", async () => {
    const provider = createCollectorCryptProvider({ blockchain: "Solana" });
    await provider.pull({ tcg: "pokemon", limit: 20 });
    const withOffers = provider.lastCards.find(
      (c) => c.nftAddress && countOfferRefs(c).refs > 0,
    );
    expect(withOffers?.nftAddress).toBeTruthy();
    const { offers, httpStatus } = await fetchCcCardOffers(
      withOffers!.nftAddress!,
      { useV2: true },
    );
    expect(httpStatus).toBe(200);
    const priced = offers.filter((o) => {
      const p = o.price == null ? null : Number(o.price);
      return p != null && Number.isFinite(p) && p > 0;
    });
    expect(priced.length).toBeGreaterThan(0);
    expect(Number(priced[0]!.price)).toBeGreaterThan(0);
  }, 45_000);

  it("live bids harvest priced offers via getCardOffers enrich", async () => {
    const bidsProvider = createCollectorCryptBidsProvider({
      sampleCards: 8,
      concurrency: 4,
      enrichOffers: true,
      blockchain: "Solana",
    });
    const bids = await bidsProvider.pull({
      tcg: "pokemon",
      limit: 20,
      pages: 1,
      priceMin: 5,
      priceMax: 500,
      sampleCards: 8,
    });
    expect(Array.isArray(bids)).toBe(true);
    for (const b of bids) {
      expect(b.side).toBe("bid");
      expect(b.price).toBeGreaterThan(0);
      expect(b.provider).toBe("collectorcrypt");
    }
    expect(bidsProvider.lastCards.length).toBeGreaterThan(0);
    expect(bidsProvider.lastBidsMeta?.enrichEnabled).toBe(true);
    expect(bidsProvider.lastBidsMeta?.mintsAttempted).toBeGreaterThan(0);
    if ((bidsProvider.lastPullMeta?.offerRefs ?? 0) > 0) {
      expect(bids.length).toBeGreaterThan(0);
      expect(bidsProvider.lastBidsMeta?.detailOffersRaw).toBeGreaterThan(0);
    }
  }, 90_000);
});

describe.skipIf(!runLive)("MultiSourceRadar", () => {
  it("merges collectorcrypt (live)", async () => {
    const radar = new MultiSourceRadar({
      providers: [createCollectorCryptProvider()],
      filter: { tcg: "pokemon", limit: 3 },
    });
    const r = await radar.syncAll();
    expect(r.totalActive).toBeGreaterThan(0);
    expect(r.byProvider.collectorcrypt).toBeGreaterThan(0);
    expect(radar.list().every((l) => l.provider === "collectorcrypt")).toBe(
      true,
    );
  }, 30_000);
});
